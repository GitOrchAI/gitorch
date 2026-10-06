// Fase 5.2: alerta de dependência vira trabalho. Grave que afeta o produto
// (ou que já tem correção) entra na sprint atual como tarefa que o Scrum
// Master delega; média e baixa vão para o backlog. Regras contra inundar o
// repositório do cliente:
//   - uma tarefa por PACOTE (todos os alertas do pacote juntos);
//   - idempotente pela marca estável no corpo (não recria se há issue aberta);
//   - teto de tarefas novas por ciclo, graves primeiro;
//   - só escreve se a autonomia de SEGURANÇA do projeto permitir propor.

import { podeEscrever, type DoDFields } from '@gitorch/cadence'
import type { AlertaDeSeguranca, Severidade } from './security-debt-collector.js'
import { destinoDoAlerta } from './prioridade-da-vulnerabilidade.js'
import { renderIssueBody } from './backlog-executor.js'
import { TASK_LABEL } from './sm-delegation.js'
import { agentLabel } from './agent-label.js'

/** Toda tarefa de segurança carrega esta etiqueta (é por ela que se lista). */
export const ETIQUETA_DE_SEGURANCA = 'gitorch:seguranca'
/** Backlog: visível no quadro, mas fora da fila do Scrum Master. */
export const ETIQUETA_DE_BACKLOG = 'gitorch:backlog'
export const TETO_DE_TAREFAS_POR_CICLO = 3

const PREFIXO_DA_MARCA = 'gitorch-seguranca'
const ORDEM: Record<Severidade, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function marcaDoPacote(ecossistema: string, pacote: string): string {
  return `${PREFIXO_DA_MARCA}:${ecossistema || 'desconhecido'}:${pacote || 'desconhecido'}`
}

/** As marcas de pacote presentes no corpo de uma issue. */
function marcasNoCorpo(corpo: string | null): string[] {
  if (!corpo) return []
  const achadas: string[] = []
  const re = new RegExp(`<!-- (${PREFIXO_DA_MARCA}:[^\\s]+) -->`, 'g')
  for (const m of corpo.matchAll(re)) if (m[1]) achadas.push(m[1])
  return achadas
}

export interface GrupoDoPacote {
  marca: string
  pacote: string
  ecossistema: string
  destino: 'sprint-atual' | 'backlog'
  pior: Severidade
  alertas: AlertaDeSeguranca[]
}

export function agruparAlertasPorPacote(alertas: AlertaDeSeguranca[]): {
  grupos: GrupoDoPacote[]
  semTarefa: Array<{ numero: number; motivo: string }>
} {
  const porMarca = new Map<string, GrupoDoPacote>()
  const semTarefa: Array<{ numero: number; motivo: string }> = []
  for (const a of alertas) {
    const { destino, motivo } = destinoDoAlerta(a)
    if (destino === 'sem-tarefa') {
      semTarefa.push({ numero: a.numero, motivo })
      continue
    }
    const marca = marcaDoPacote(a.ecossistema, a.pacote)
    const grupo = porMarca.get(marca)
    if (!grupo) {
      porMarca.set(marca, {
        marca,
        pacote: a.pacote,
        ecossistema: a.ecossistema,
        destino,
        pior: a.severidade,
        alertas: [a],
      })
      continue
    }
    grupo.alertas.push(a)
    if (destino === 'sprint-atual') grupo.destino = 'sprint-atual'
    if (ORDEM[a.severidade] < ORDEM[grupo.pior]) grupo.pior = a.severidade
  }
  const grupos = [...porMarca.values()].sort(
    (x, y) =>
      Number(x.destino !== 'sprint-atual') - Number(y.destino !== 'sprint-atual') ||
      ORDEM[x.pior] - ORDEM[y.pior] ||
      y.alertas.length - x.alertas.length ||
      x.pacote.localeCompare(y.pacote)
  )
  return { grupos, semTarefa }
}

/** Texto do aviso vem de fora: sem tags e curto antes de ir para a issue. */
function textoSeguro(texto: string): string {
  return texto.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function montarTarefaDoPacote(grupo: GrupoDoPacote): {
  titulo: string
  corpo: string
  etiquetas: string[]
  campos: DoDFields
} {
  const n = grupo.alertas.length
  const plural = n === 1 ? 'alerta' : 'alertas'
  const titulo = `Segurança: atualizar ${grupo.pacote} (${n} ${plural}, gravidade ${grupo.pior})`
  const manifestos = [...new Set(grupo.alertas.map((a) => a.manifesto).filter(Boolean))]
  const correcoes = [
    ...new Set(grupo.alertas.map((a) => a.versaoCorrigida).filter((v): v is string => !!v)),
  ]
  const numeros = grupo.alertas.map((a) => `#${a.numero}`).join(', ')
  const linhas = grupo.alertas.map((a) => {
    const { motivo } = destinoDoAlerta(a)
    return (
      `- Alerta ${a.numero} (${a.ghsa ?? 'sem GHSA'}): ${textoSeguro(a.resumo) || 'sem resumo'}\n` +
      `  ${motivo}. ${a.url}`
    )
  })
  const campos: DoDFields = {
    titulo,
    goal:
      `Eliminar ${n} vulnerabilidade(s) conhecida(s) do pacote ${grupo.pacote} (${grupo.ecossistema || 'ecossistema não informado'}) ` +
      `apontadas pelo Dependabot, sem quebrar o produto.`,
    taskDetails: [
      `- Pacote: ${grupo.pacote}`,
      `- Ecossistema: ${grupo.ecossistema || 'não informado'}`,
      `- Pior gravidade: ${grupo.pior}`,
      `- Versões que corrigem: ${correcoes.length ? correcoes.join(', ') : 'ainda não publicada'}`,
      `- Manifestos: ${manifestos.length ? manifestos.join(', ') : 'não informado'}`,
      '',
      'Alertas:',
      ...linhas,
    ].join('\n'),
    taskDescription:
      grupo.destino === 'sprint-atual'
        ? `Vulnerabilidade grave que afeta o produto ou já tem correção publicada: entra na sprint atual. ` +
          `Esta tarefa atualiza ${grupo.pacote} para uma versão sem as falhas listadas.`
        : `Vulnerabilidade de gravidade média ou baixa: fica no backlog até ser puxada para uma sprint. ` +
          `Esta tarefa atualiza ${grupo.pacote} para uma versão sem as falhas listadas.`,
    implementationGuide: [
      correcoes.length
        ? `1. Atualize ${grupo.pacote} para a maior versão entre ${correcoes.join(', ')} (ou mais nova compatível) em ${manifestos.join(', ') || 'o manifesto do projeto'}.`
        : `1. Ainda não há versão corrigida: avalie trocar ${grupo.pacote} por alternativa mantida ou isolar o uso afetado, e registre a decisão em Notes.`,
      `2. Se ${grupo.pacote} for dependência indireta, use o mecanismo de sobreposição do gerenciador de pacotes (overrides/resolutions) em vez de editar o lockfile à mão.`,
      '3. Regenere o lockfile e rode os testes e o build do projeto; nada de pular teste para passar.',
      '4. Abra o pull request citando os alertas desta tarefa.',
    ].join('\n'),
    verificationCriteria: [
      `- Os alertas ${numeros} do Dependabot aparecem como corrigidos depois do merge.`,
      `- O lockfile resolve ${grupo.pacote} numa versão igual ou acima da que corrige cada alerta.`,
      '- Testes e build do projeto verdes no pull request.',
    ].join('\n'),
    dependencies: 'Nenhuma tarefa bloqueia esta: a correção depende só da atualização do pacote.',
    relatedFiles: manifestos.length
      ? manifestos.map((m) => `- \`${m}\``).join('\n')
      : '- O manifesto de dependências do projeto (o alerta não informou o caminho).',
    notes:
      `Aberta pelo próprio produto ao varrer os alertas de segurança — uma tarefa por pacote ` +
      `(marca \`${grupo.marca}\`). Enquanto esta issue estiver aberta, alertas novos do mesmo pacote não abrem outra.`,
  }
  const etiquetas =
    grupo.destino === 'sprint-atual'
      ? [TASK_LABEL, agentLabel('sm'), ETIQUETA_DE_SEGURANCA]
      : [ETIQUETA_DE_SEGURANCA, ETIQUETA_DE_BACKLOG]
  return { titulo, corpo: renderIssueBody(campos, grupo.marca, null), etiquetas, campos }
}

export interface ResumoDasTarefasDeSeguranca {
  autorizado: boolean
  motivo?: string
  criadas: Array<{ pacote: string; issue: number; destino: 'sprint-atual' | 'backlog' }>
  jaExistiam: number
  adiadas: number
  semTarefa: number
  falhas: number
}

export async function gerarTarefasDeVulnerabilidade(deps: {
  alertas: AlertaDeSeguranca[]
  /** `Project.autonomiaDeSeguranca`; ausente/desconhecido = só olhar. */
  autonomiaDeSeguranca: string | null | undefined
  /** Issues abertas com `ETIQUETA_DE_SEGURANCA` (número e corpo). */
  listarTarefasAbertas: () => Promise<Array<{ numero: number; corpo: string | null }>>
  criarIssue: (t: { titulo: string; corpo: string; etiquetas: string[] }) => Promise<{
    numero: number
  }>
  /** Grava na ficha de cada alerta a issue que cuida dele. */
  ligarFichas: (numerosDosAlertas: number[], issue: number) => Promise<void>
  teto?: number
  onWarn?: (m: string) => void
}): Promise<ResumoDasTarefasDeSeguranca> {
  const { grupos, semTarefa } = agruparAlertasPorPacote(deps.alertas)
  const resumo: ResumoDasTarefasDeSeguranca = {
    autorizado: true,
    criadas: [],
    jaExistiam: 0,
    adiadas: 0,
    semTarefa: semTarefa.length,
    falhas: 0,
  }
  if (grupos.length === 0) return resumo

  const decisao = podeEscrever(deps.autonomiaDeSeguranca, 'propor')
  if (!decisao.pode) {
    resumo.autorizado = false
    resumo.motivo = decisao.motivo
    resumo.adiadas = grupos.length
    return resumo
  }

  let existentes: Map<string, number>
  try {
    existentes = new Map()
    for (const issue of await deps.listarTarefasAbertas()) {
      for (const marca of marcasNoCorpo(issue.corpo)) existentes.set(marca, issue.numero)
    }
  } catch (err) {
    // Sem a lista não há como garantir que não duplica: não cria nada.
    resumo.falhas += 1
    resumo.adiadas = grupos.length
    deps.onWarn?.(`tarefas de segurança: não consegui listar as existentes: ${err}`)
    return resumo
  }

  const ligar = async (grupo: GrupoDoPacote, issue: number): Promise<void> => {
    await deps
      .ligarFichas(
        grupo.alertas.map((a) => a.numero),
        issue
      )
      .catch((err) =>
        deps.onWarn?.(
          `tarefas de segurança: ficha de ${grupo.pacote} sem ligação à #${issue}: ${err}`
        )
      )
  }

  const teto = deps.teto ?? TETO_DE_TAREFAS_POR_CICLO
  let tentativas = 0
  for (const grupo of grupos) {
    const jaExiste = existentes.get(grupo.marca)
    if (jaExiste !== undefined) {
      resumo.jaExistiam += 1
      await ligar(grupo, jaExiste)
      continue
    }
    if (tentativas >= teto) {
      resumo.adiadas += 1
      continue
    }
    // A tentativa gasta a vaga mesmo se falhar: evita repetir a mesma falha
    // em série no mesmo ciclo.
    tentativas += 1
    const tarefa = montarTarefaDoPacote(grupo)
    try {
      const { numero } = await deps.criarIssue(tarefa)
      resumo.criadas.push({ pacote: grupo.pacote, issue: numero, destino: grupo.destino })
      await ligar(grupo, numero)
    } catch (err) {
      resumo.falhas += 1
      deps.onWarn?.(`tarefas de segurança: falha ao abrir a tarefa de ${grupo.pacote}: ${err}`)
    }
  }
  return resumo
}
