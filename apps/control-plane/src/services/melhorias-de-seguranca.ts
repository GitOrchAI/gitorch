// O plano de cada passada: dado o que a sondagem viu e o que o registro da
// ficha já guarda, quais melhorias valem a pena agora, em que ordem, o que só
// precisa ser acompanhado e o que precisa ser perguntado ao dono.
//
// É função pura: não lê o GitHub, não grava nada. A ordem é fixa de propósito
// (uma por vez, a mais barata e reversível primeiro):
//   alertas -> atualizações -> senhas -> código -> alternativa gratuita ->
//   permissões mínimas por workflow -> permissão padrão do token (por último,
//   porque só é seguro depois de todos os workflows declararem a sua).
// Proteção de branch não existe aqui.

import { caminhoDeWorkflowValido } from './workflows-de-seguranca.js'
import type { EstadoDaMelhoria, RegistroDaMelhoria } from './executores-de-seguranca.js'
import type { SondagemDoRepositorio, WorkflowSondado } from './sondagem-de-seguranca.js'
import { cortarPorPontoDeCodigo, mascararCredenciais } from './texto-seguro.js'

export interface Candidata {
  id: string
  tipo: 'configuracao' | 'pr'
  /** Só nas permissões mínimas: o workflow-alvo. */
  workflow?: WorkflowSondado
  /** O dono liberou o workflow de deploy/CD para esta mudança. */
  liberadoPeloDono?: boolean
}

export interface PlanoDaPassada {
  /** Em ordem de aplicação. */
  candidatas: Candidata[]
  /** PRs abertos: só leitura, para ver se foram mesclados ou fechados. */
  acompanhar: Array<{ id: string; registro: RegistroDaMelhoria }>
  /** Escritas com resultado incerto: só leitura, para confirmar. */
  conferir: Array<{ id: string; registro: RegistroDaMelhoria }>
  /** Workflows de deploy/CD sem permissions que ainda não viraram pergunta ao dono. */
  perguntas: WorkflowSondado[]
  /** Workflows que o GitOrch decidiu não mexer, com o motivo. */
  naoMexidos: Array<{ id: string; motivo: string }>
}

export const PREFIXO_DAS_PERMISSOES_MINIMAS = 'permissoes-minimas-dos-workflows:'

export function idDasPermissoesMinimas(caminho: string): string {
  return `${PREFIXO_DAS_PERMISSOES_MINIMAS}${caminho}`
}

const HORA_MS = 3_600_000
const DIA_MS = 24 * HORA_MS

/** Quando uma melhoria que não deu pode ser tentada de novo. `null` = sem espera. */
export function proximaTentativaApos(
  estado: EstadoDaMelhoria,
  agora: Date,
  limitada: boolean
): string | null {
  const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString()
  switch (estado) {
    case 'indisponivel':
    case 'recusado':
      return depois(7 * DIA_MS)
    case 'falhou':
      return depois(limitada ? HORA_MS : 3 * HORA_MS)
    default:
      return null
  }
}

function podeTentar(registro: RegistroDaMelhoria | undefined, agora: Date): boolean {
  if (registro === undefined) return true
  switch (registro.estado) {
    case 'recusado':
    case 'indisponivel':
    case 'falhou':
      return (
        registro.proximaTentativaEm === null ||
        Date.parse(registro.proximaTentativaEm) <= agora.getTime()
      )
    default:
      // aplicado, desfeito, dispensado, aguardando-*, incerto: ou já está resolvido, ou outro passo cuida.
      return false
  }
}

export function planejarMelhorias(args: {
  sondagem: SondagemDoRepositorio
  registros: Readonly<Record<string, RegistroDaMelhoria>>
  /** Caminhos de workflows de deploy/CD que o dono liberou na pergunta. */
  liberadosPeloDono: ReadonlySet<string>
  agora: Date
}): PlanoDaPassada {
  const { sondagem: s, registros, agora } = args
  const candidatas: Candidata[] = []
  const acompanhar: PlanoDaPassada['acompanhar'] = []
  const conferir: PlanoDaPassada['conferir'] = []
  const perguntas: WorkflowSondado[] = []
  const naoMexidos: PlanoDaPassada['naoMexidos'] = []

  for (const [id, registro] of Object.entries(registros)) {
    if (registro.estado === 'aguardando-revisao' && registro.pr) acompanhar.push({ id, registro })
    if (registro.estado === 'incerto' && !registro.pr) conferir.push({ id, registro })
  }

  const quer = (id: string, ok: boolean): boolean => ok && podeTentar(registros[id], agora)

  // Configuração por API: só o que a sondagem viu "desligado" (e provou ter admin para ver).
  if (s.comAdmin) {
    if (quer('alertas-de-dependencias', s.alertasDeDependencias === 'desligado')) {
      candidatas.push({ id: 'alertas-de-dependencias', tipo: 'configuracao' })
    }
    if (
      quer(
        'atualizacoes-de-seguranca',
        s.atualizacoesDeSeguranca === 'desligado' && s.alertasDeDependencias === 'ligado'
      )
    ) {
      candidatas.push({ id: 'atualizacoes-de-seguranca', tipo: 'configuracao' })
    }
    if (
      quer('varredura-de-senhas', s.segredos === 'desligado' || s.bloqueioDePush === 'desligado')
    ) {
      candidatas.push({ id: 'varredura-de-senhas', tipo: 'configuracao' })
    }
    if (quer('varredura-de-codigo', s.varreduraDeCodigo === 'desligado')) {
      candidatas.push({ id: 'varredura-de-codigo', tipo: 'configuracao' })
    }
  }

  const workflowsLegiveis = s.workflows.estado === 'lidos' || s.workflows.estado === 'ausente'

  // Alternativa gratuita: privado, sem o recurso pago (a sondagem não viu, ou a escrita foi recusada
  // por plano), e nenhum workflow roda gitleaks.
  const semRecursoPago =
    s.privado === true &&
    (s.segredos === 'indisponivel' || registros['varredura-de-senhas']?.estado === 'indisponivel')
  if (
    quer(
      'alternativa-de-varredura-de-senhas',
      semRecursoPago && workflowsLegiveis && !s.workflows.itens.some((w) => w.temGitleaks)
    )
  ) {
    candidatas.push({ id: 'alternativa-de-varredura-de-senhas', tipo: 'pr' })
  }

  // Permissões mínimas, um workflow por vez.
  const ordenados = [...s.workflows.itens].sort((a, b) => a.caminho.localeCompare(b.caminho))
  for (const workflow of ordenados) {
    if (!caminhoDeWorkflowValido(workflow.caminho)) continue
    if (workflow.declaraPermissoes !== false) continue
    const id = idDasPermissoesMinimas(workflow.caminho)
    const registro = registros[id]
    const liberado = args.liberadosPeloDono.has(workflow.caminho)

    if (workflow.ehDeploy && !liberado) {
      if (registro === undefined) perguntas.push(workflow)
      continue
    }
    if (!workflow.seguroParaPermissaoMinima) {
      if (registro === undefined) {
        naoMexidos.push({ id, motivo: workflow.motivoDeNaoSeguro ?? 'pode precisar de escrita' })
      }
      continue
    }
    // Liberado pelo dono: o registro "aguardando-dono" não impede a mudança.
    const impedido = registro?.estado === 'aguardando-dono' ? false : !podeTentar(registro, agora)
    if (impedido) continue
    candidatas.push({
      id,
      tipo: 'pr',
      workflow,
      ...(workflow.ehDeploy ? { liberadoPeloDono: true } : {}),
    })
  }

  // A permissão padrão do token só muda quando TODOS os workflows já declaram a sua.
  const todosDeclaram = s.workflows.itens.every((w) => w.declaraPermissoes === true)
  if (
    quer(
      'permissao-padrao-do-workflow',
      s.comAdmin &&
        s.permissaoDoWorkflow === 'write' &&
        workflowsLegiveis &&
        !s.workflows.truncado &&
        todosDeclaram
    )
  ) {
    candidatas.push({ id: 'permissao-padrao-do-workflow', tipo: 'configuracao' })
  }

  return { candidatas, acompanhar, conferir, perguntas, naoMexidos }
}

// ------------------------------------------------------------------ painel

export function chaveDoEventoDaMelhoria(
  repositorio: string,
  id: string,
  estado: EstadoDaMelhoria
): string {
  return `melhoria-de-seguranca:${repositorio}:${id}:${estado}`
}

const FRASE_DO_ESTADO: Record<EstadoDaMelhoria, string> = {
  aplicado: 'aplicada',
  'aguardando-revisao': 'proposta por pull request, ainda não mesclada',
  'aguardando-dono': 'à espera da resposta do dono',
  recusado: 'recusada pelo GitHub',
  indisponivel: 'indisponível neste repositório',
  incerto: 'sem confirmação',
  falhou: 'falhou (tento de novo)',
  desfeito: 'desfeita',
  dispensado: 'dispensada',
}

const NOME_DA_MELHORIA: Record<string, string> = {
  'alertas-de-dependencias': 'alertas de dependências vulneráveis (Dependabot)',
  'atualizacoes-de-seguranca': 'atualizações de segurança do Dependabot',
  'varredura-de-senhas': 'varredura de senhas vazadas e bloqueio de push',
  'varredura-de-codigo': 'varredura de código (code scanning)',
  'alternativa-de-varredura-de-senhas': 'varredura gratuita de senhas (gitleaks)',
  'permissoes-minimas-dos-workflows': 'permissões mínimas do workflow',
  'permissao-padrao-do-workflow': 'permissão padrão do token das Actions',
}

export function nomeDaMelhoriaPorId(id: string): string {
  const base = id.split(':', 1)[0] ?? id
  const nome = NOME_DA_MELHORIA[base] ?? base
  return id.includes(':') ? `${nome} (${id.slice(base.length + 1)})` : nome
}

export function textoDoEventoDaMelhoria(args: {
  repositorio: string
  id: string
  estado: EstadoDaMelhoria
  motivo: string
  desfazer: string
}): string {
  const base = args.id.split(':', 1)[0] ?? args.id
  const nome = NOME_DA_MELHORIA[base] ?? base
  const alvo = args.id.includes(':') ? ` (${args.id.slice(base.length + 1)})` : ''
  const motivo = cortarPorPontoDeCodigo(mascararCredenciais(args.motivo), 500)
  const desfazer =
    args.estado === 'aplicado' || args.estado === 'aguardando-revisao'
      ? ` ${cortarPorPontoDeCodigo(args.desfazer, 700)}`
      : ''
  return `Segurança de ${args.repositorio}: ${nome}${alvo} ${FRASE_DO_ESTADO[args.estado]}. ${motivo}${desfazer}`
}
