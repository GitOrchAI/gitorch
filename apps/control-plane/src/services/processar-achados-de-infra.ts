// ESTEIRA-T8 (D54) — o motor do "sensor → RA → PO → issue". Recebe os achados
// tipados de `coletarAchadosDeInfra`, e para cada um:
//   1. pula o que já tem incidente aberto (não reabre);
//   2. roteia por classe (repo do cliente / repo do produto / ignora);
//   3. RA entende a causa → PO escreve a issue padrão Shrimp;
//   4. cria a issue no alvo certo, registra em `infra_incidents`, e — quando é
//      encanamento do GitOrch — avisa o dono no Telegram, NUNCA o PO do cliente.
//
// Best-effort por contrato: um achado que falha vira `onWarn` e não derruba os
// outros. Regra PURA de roteamento à parte (`alvoDaClasse`, `scaffoldingObsoleto`)
// para o teste cravar a matriz sem tocar em motor nem rede.

import type { DoDFields, RaCausaDeInfraForm } from '@gitorch/cadence'
import type { StepExecutor } from './role-rails.js'
import type { AchadoDeInfra } from './incidente-ci.js'
import type { ClasseDeFalha } from './classificar-falha-de-infra.js'
import { runAnaliseCausaDeInfra, runIssuePadraoDeInfra } from './analise-causa-de-infra.js'

/** Onde a issue nasce. `nenhum` = o RA nem analisa (só log). */
export type AlvoDaIssue = 'repo-do-cliente' | 'repo-do-produto' | 'nenhum'

/** Roteamento PURO por classe. */
export function alvoDaClasse(classe: ClasseDeFalha): AlvoDaIssue {
  switch (classe) {
    case 'ci-do-cliente':
    case 'config-de-actions':
    case 'dependabot-travado':
    case 'alerta-de-seguranca':
      return 'repo-do-cliente'
    case 'scaffolding-do-gitorch':
      return 'repo-do-produto'
    case 'workflow-morto':
      return 'nenhum'
    default:
      // Classe nova sem rota: fail-safe para o repo do produto (é um bug nosso
      // de classificação, o dono precisa ver — nunca o cliente).
      return 'repo-do-produto'
  }
}

/**
 * Basenames de encanamento do GitOrch cuja FUNÇÃO já é feita pelo control-plane
 * (decisão do dono 29/08): o merge agora é o veredito do QA + `gh pr merge`, e o
 * Dependabot é orquestrado pelo pipeline RA→PO→SM→QA. A issue pede REMOÇÃO.
 */
const SCAFFOLDING_OBSOLETO = new Set([
  'auto-merge.yml',
  'auto-merge-monitor.yml',
  'jules-auto-merge.yml',
  'check-merge-gate.yml',
])

/** Este achado é de um workflow de auto-merge que o control-plane substituiu? */
export function scaffoldingObsoleto(paths: string[]): boolean {
  return paths.some((p) => SCAFFOLDING_OBSOLETO.has(p.split('/').pop() ?? p))
}

export interface IncidenteAberto {
  identidadeEstavel: string
  issueNumber: number | null
}

export interface RegistrarIncidenteArgs {
  projectId: string
  classe: ClasseDeFalha
  identidadeEstavel: string
  issueNumber: number
  titulo: string
}

export interface ProcessarAchadosDeps {
  achados: AchadoDeInfra[]
  projectId: string
  /** Nome `dono/repo` do cliente — para o texto do aviso. */
  repository: string
  execute: StepExecutor
  /** Contexto extra para os passos do motor (guia do Jules, aprendizados...). */
  contextBlocks?: string[]
  guiaDoDev?: string
  aprendizados?: string
  /** Incidentes que já têm issue aberta — não reanalisa (T9 fecha sozinho). */
  incidentesAbertos: () => Promise<IncidenteAberto[]>
  /** Cria a issue no repo do CLIENTE (board do cliente). Devolve o número. */
  criarIssueNoCliente: (fields: DoDFields, achado: AchadoDeInfra) => Promise<number>
  /** Cria a issue em `GitOrchAI/gitorch` (encanamento do produto). */
  criarIssueNoProduto: (fields: DoDFields, achado: AchadoDeInfra) => Promise<number>
  /** Telegram ao DONO (só para achados de encanamento do produto). */
  avisarDono: (texto: string) => Promise<void>
  /** upsert em `infra_incidents` por (projectId, identidadeEstavel). */
  registrarIncidente: (args: RegistrarIncidenteArgs) => Promise<void>
  /** Teto de achados analisados por passada — proteção de cota de motor. */
  teto?: number
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface ProcessarAchadosResultado {
  issuesNoCliente: number[]
  issuesNoProduto: number[]
  ignorados: string[]
  jaRastreados: string[]
}

/** Teto padrão de achados processados por passada (motor é caro). */
export const TETO_DE_ACHADOS_PROCESSADOS = 3

export async function processarAchadosDeInfra(
  deps: ProcessarAchadosDeps
): Promise<ProcessarAchadosResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const teto = deps.teto ?? TETO_DE_ACHADOS_PROCESSADOS
  const ctx = deps.contextBlocks ?? []

  const res: ProcessarAchadosResultado = {
    issuesNoCliente: [],
    issuesNoProduto: [],
    ignorados: [],
    jaRastreados: [],
  }

  let abertos: Set<string>
  try {
    const lista = await deps.incidentesAbertos()
    abertos = new Set(lista.filter((i) => i.issueNumber !== null).map((i) => i.identidadeEstavel))
  } catch (err) {
    // Sem a lista, o pior caso é reanalisar um achado já rastreado. O upsert
    // por identidade evita duplicar a LINHA; a issue duplicada é o risco —
    // aceitável e raro, melhor que travar tudo.
    warn(`processar-achados: não li os incidentes abertos (${String(err).slice(0, 120)})`)
    abertos = new Set()
  }

  let processados = 0
  for (const achado of deps.achados) {
    if (processados >= teto) {
      info(
        `processar-achados: teto de ${teto} atingido, ${deps.achados.length - processados} achado(s) ficam para a próxima passada`
      )
      break
    }

    if (abertos.has(achado.identidadeEstavel)) {
      res.jaRastreados.push(achado.identidadeEstavel)
      continue
    }

    const alvo = alvoDaClasse(achado.classe)
    if (alvo === 'nenhum') {
      info(`processar-achados: ${achado.identidadeEstavel} (${achado.classe}) — só log, sem issue`)
      res.ignorados.push(achado.identidadeEstavel)
      continue
    }

    processados += 1
    try {
      const analise: RaCausaDeInfraForm = await runAnaliseCausaDeInfra(deps.execute, achado, ctx)
      const obsoleto = alvo === 'repo-do-produto' && scaffoldingObsoleto(achado.paths)
      const fields = await runIssuePadraoDeInfra(
        deps.execute,
        {
          achado,
          analise,
          ...(deps.guiaDoDev ? { guiaDoDev: deps.guiaDoDev } : {}),
          ...(deps.aprendizados ? { aprendizados: deps.aprendizados } : {}),
          scaffoldingObsoleto: obsoleto,
        },
        ctx
      )

      if (alvo === 'repo-do-cliente') {
        const numero = await deps.criarIssueNoCliente(fields, achado)
        await deps.registrarIncidente({
          projectId: deps.projectId,
          classe: achado.classe,
          identidadeEstavel: achado.identidadeEstavel,
          issueNumber: numero,
          titulo: achado.titulo,
        })
        res.issuesNoCliente.push(numero)
        info(
          `processar-achados: issue #${numero} no repo do cliente para ${achado.identidadeEstavel}`
        )
      } else {
        const numero = await deps.criarIssueNoProduto(fields, achado)
        await deps.registrarIncidente({
          projectId: deps.projectId,
          classe: achado.classe,
          identidadeEstavel: achado.identidadeEstavel,
          issueNumber: numero,
          titulo: achado.titulo,
        })
        res.issuesNoProduto.push(numero)
        await deps
          .avisarDono(
            `Encanamento do GitOrch em ${deps.repository}: ${achado.titulo}. ` +
              `${obsoleto ? 'Função já é do control-plane — issue de REMOÇÃO' : 'Bridge quebrado — issue de conserto'} #${numero} (GitOrchAI/gitorch).`
          )
          .catch((err) =>
            warn(`processar-achados: aviso ao dono falhou (${String(err).slice(0, 120)})`)
          )
        info(
          `processar-achados: issue #${numero} no repo do produto para ${achado.identidadeEstavel}`
        )
      }
    } catch (err) {
      warn(`processar-achados: ${achado.identidadeEstavel} falhou (${String(err).slice(0, 160)})`)
    }
  }

  return res
}
