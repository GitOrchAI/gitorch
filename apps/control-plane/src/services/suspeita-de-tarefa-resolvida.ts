// Quem decide a suspeita de "esta tarefa já está resolvida" é o produto, não o dono.
//
// O diagnóstico pelo grafo do código erra em quase metade dos casos medidos, e
// por isso nunca fechou nada sozinho. O que ele fazia no lugar era PULAR a
// tarefa e deixar um comentário na issue pedindo ao dono que conferisse e
// fechasse — num repositório que o dono não acompanha. Onze das dezessete
// tarefas abertas dos cinco repositórios ficaram paradas assim, algumas por
// semanas.
//
// Aqui a suspeita vira decisão por EVIDÊNCIA DETERMINÍSTICA de entrega: existe
// pull request mesclado na branch padrão, ligado a esta tarefa deste projeto,
// mesclado depois de a issue nascer e, se a issue foi reaberta, depois da
// reabertura?
//
//   com evidência   -> (cuidar) fecha a tarefa, com registro e como desfazer
//   sem evidência   -> (cuidar) descarta a suspeita: a tarefa volta à fila
//   ambíguo         -> pergunta ao dono pelo mecanismo de perguntas (painel e
//                      Telegram); só ESTA tarefa espera
//
// `sugerir` nunca escreve no GitHub: vira pergunta. `so_olhar` só registra no
// painel. O que foi avaliado fica na ficha da tarefa, para nada ser reavaliado
// em laço enquanto a tarefa não mudar.

import { normalizarNivel } from '@gitorch/cadence'
import { atualizarFichaDoItem, lerFichaDoItem, type PrismaDaFichaDoItem } from './ficha-do-item.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'
import { cortarPorPontoDeCodigo } from './texto-seguro.js'
import { lerMotivoDaResposta } from './erro-do-github.js'
import { headersGithub } from './github-json.js'

export const PREFIXO_DA_SUSPEITA = 'suspeita-resolvida:'
export const RESPOSTA_FECHAR_A_TAREFA = 'suspeita-fechar'
export const RESPOSTA_SEGUIR_COM_A_TAREFA = 'suspeita-seguir'

/** Quantas entregas candidatas se confirmam no GitHub por tarefa. */
const MAX_ENTREGAS_CONFERIDAS = 5

export function dedupKeyDaSuspeita(
  repositorio: string,
  numeroDaTarefa: number,
  atualizadaEm: string
): string {
  return `${PREFIXO_DA_SUSPEITA}${repositorio}:${numeroDaTarefa}:${Date.parse(atualizadaEm) || 0}`
}

export function lerDedupKeyDaSuspeita(
  chave: string
): { repositorio: string; numeroDaTarefa: number; atualizadaEmMs: number } | null {
  if (!chave.startsWith(PREFIXO_DA_SUSPEITA)) return null
  const partes = chave.slice(PREFIXO_DA_SUSPEITA.length).split(':')
  if (partes.length !== 3) return null
  const [repositorio, tarefa, ms] = partes as [string, string, string]
  const numeroDaTarefa = Number(tarefa)
  const atualizadaEmMs = Number(ms)
  if (!repositorio.includes('/')) return null
  if (!Number.isInteger(numeroDaTarefa) || numeroDaTarefa <= 0) return null
  if (!Number.isInteger(atualizadaEmMs) || atualizadaEmMs < 0) return null
  return { repositorio, numeroDaTarefa, atualizadaEmMs }
}

export interface EntregaMesclada {
  pullRequest: number | null
  mergedAt: Date
}

export interface EvidenciaDaTarefa {
  entregas: EntregaMesclada[]
  /** Quando a issue foi reaberta (todas as vezes). */
  reabertaEm: Date[]
  /** Há uma sessão do dev com entrega em aberto para esta mesma tarefa. */
  trabalhoEmAndamento: boolean
}

export type VereditoDaSuspeita =
  | { tipo: 'entregue'; entrega: EntregaMesclada }
  | { tipo: 'sem-entrega' }
  | { tipo: 'ambiguo'; entrega: EntregaMesclada; motivo: string }

/**
 * A regra, pura. Só conta entrega mesclada DEPOIS de a issue nascer: um PR
 * mesclado antes não pode ter resolvido um pedido que ainda não existia.
 */
export function decidirSuspeita(args: {
  issueCriadaEm: Date
  evidencia: EvidenciaDaTarefa
}): VereditoDaSuspeita {
  const validas = args.evidencia.entregas.filter(
    (e) => e.mergedAt.getTime() > args.issueCriadaEm.getTime()
  )
  if (validas.length === 0) return { tipo: 'sem-entrega' }

  const ultima = validas.reduce((a, b) => (b.mergedAt > a.mergedAt ? b : a))
  if (args.evidencia.reabertaEm.some((d) => d.getTime() > ultima.mergedAt.getTime())) {
    return {
      tipo: 'ambiguo',
      entrega: ultima,
      motivo: 'a tarefa foi reaberta depois que a entrega foi mesclada',
    }
  }
  if (args.evidencia.trabalhoEmAndamento) {
    return {
      tipo: 'ambiguo',
      entrega: ultima,
      motivo: 'há outra entrega desta tarefa ainda em andamento',
    }
  }
  return { tipo: 'entregue', entrega: ultima }
}

// ---------------------------------------------------------------- evidência

export interface DepsDaEvidencia {
  /** Entregas do dev assíncrono com merge gravado (dev_sessions). */
  sessoesMescladas: () => Promise<Array<{ pullRequest: number | null; mergedAt: Date }>>
  /** PRs que fecham esta tarefa segundo o grafo de vínculos na ficha. */
  prsLigadosNaFicha: () => Promise<number[]>
  /** O pull request no GitHub; `null` quando não existe. Lança em falha de leitura. */
  lerPullRequest: (
    numero: number
  ) => Promise<{ mesclado: boolean; mergedAt: string | null; baseEhPadrao: boolean } | null>
  /** Eventos da issue no GitHub (para achar as reaberturas). */
  lerEventosDaIssue: () => Promise<Array<{ event?: string; created_at?: string }>>
  /** Existe sessão do dev ainda aberta para esta tarefa. */
  existeTrabalhoEmAndamento: () => Promise<boolean>
}

/**
 * Junta o que prova a entrega. O número do PR vem das sessões do dev e do grafo
 * de vínculos; o fato de estar MESCLADO NA BRANCH PADRÃO e QUANDO vem do próprio
 * GitHub. Lança quando uma leitura necessária falha: quem chama deixa a decisão
 * para a próxima passada em vez de decidir às cegas.
 */
export async function coletarEvidenciaDaTarefa(deps: DepsDaEvidencia): Promise<EvidenciaDaTarefa> {
  const sessoes = await deps.sessoesMescladas()
  const ligados = await deps.prsLigadosNaFicha()

  const numeros = new Set<number>()
  for (const s of sessoes) if (s.pullRequest !== null) numeros.add(s.pullRequest)
  for (const n of ligados) numeros.add(n)

  const entregas: EntregaMesclada[] = []
  for (const numero of [...numeros].slice(0, MAX_ENTREGAS_CONFERIDAS)) {
    const pr = await deps.lerPullRequest(numero)
    if (pr === null) {
      // O PR não existe mais: vale o que a sessão do dev registrou, se registrou.
      const daSessao = sessoes.find((s) => s.pullRequest === numero)
      if (daSessao) entregas.push({ pullRequest: numero, mergedAt: daSessao.mergedAt })
      continue
    }
    if (!pr.mesclado || !pr.baseEhPadrao || !pr.mergedAt) continue
    entregas.push({ pullRequest: numero, mergedAt: new Date(pr.mergedAt) })
  }
  // Merge gravado sem número de PR: só a sessão sabe, e o instante é o dela.
  for (const s of sessoes) {
    if (s.pullRequest === null) entregas.push({ pullRequest: null, mergedAt: s.mergedAt })
  }

  let reabertaEm: Date[] = []
  if (entregas.length > 0) {
    const eventos = await deps.lerEventosDaIssue()
    reabertaEm = eventos
      .filter((e) => e.event === 'reopened' && typeof e.created_at === 'string')
      .map((e) => new Date(e.created_at as string))
  }

  return {
    entregas,
    reabertaEm,
    trabalhoEmAndamento: entregas.length > 0 ? await deps.existeTrabalhoEmAndamento() : false,
  }
}

// ------------------------------------------------------------------ memória

export type DesfechoDaSuspeita =
  'fechada' | 'descartada' | 'perguntada' | 'registrada' | 'aguardando'

export interface MemoriaDaSuspeita {
  veredito: 'fechada' | 'descartada' | 'perguntada' | 'registrada'
  /** O `updated_at` da issue quando a suspeita foi avaliada. */
  issueAtualizadaEm: string
  avaliadaEm: string
}

const CHAVE_DA_MEMORIA = 'suspeitaDeTarefaResolvida'

function ehMemoria(valor: unknown): valor is MemoriaDaSuspeita {
  if (valor === null || typeof valor !== 'object') return false
  const m = valor as Record<string, unknown>
  return (
    (m['veredito'] === 'fechada' ||
      m['veredito'] === 'descartada' ||
      m['veredito'] === 'perguntada' ||
      m['veredito'] === 'registrada') &&
    typeof m['issueAtualizadaEm'] === 'string'
  )
}

export async function lerMemoriaDaSuspeita(
  prisma: PrismaDaFichaDoItem,
  projectId: string,
  numero: number
): Promise<MemoriaDaSuspeita | null> {
  const ficha = await lerFichaDoItem({ prisma, projectId, tipo: 'issue', numero })
  const bruto = ficha?.conferencia?.[CHAVE_DA_MEMORIA]
  return ehMemoria(bruto) ? bruto : null
}

export async function gravarMemoriaDaSuspeita(
  prisma: PrismaDaFichaDoItem,
  projectId: string,
  numero: number,
  memoria: Omit<MemoriaDaSuspeita, 'avaliadaEm'>,
  agora: Date = new Date()
): Promise<void> {
  await atualizarFichaDoItem({
    prisma,
    projectId,
    tipo: 'issue',
    numero,
    conferencia: { [CHAVE_DA_MEMORIA]: { ...memoria, avaliadaEm: agora.toISOString() } },
  })
}

// ---------------------------------------------------------------- a decisão

export interface DepsDaSuspeita {
  autonomia: string | null | undefined
  repositorio: string
  tarefa: { numero: number; titulo: string; criadaEm: string; atualizadaEm: string }
  motivoDoDiagnostico: string
  lerMemoria: () => Promise<MemoriaDaSuspeita | null>
  gravarMemoria: (m: Omit<MemoriaDaSuspeita, 'avaliadaEm'>) => Promise<void>
  coletarEvidencia: () => Promise<EvidenciaDaTarefa>
  /** Comenta o registro, fecha a tarefa e marca a ficha. Lança se a guarda recusar. */
  fecharTarefa: (pullRequest: number | null) => Promise<void>
  perguntar: (p: {
    text: string
    options: AgentQuestionOption[]
    dedupKey: string
  }) => Promise<void>
  perguntaAberta: (dedupKey: string) => Promise<boolean>
  registrarNoPainel: (chave: string, texto: string) => Promise<void>
  aviso: (mensagem: string) => void
}

export interface ResultadoDaSuspeita {
  desfecho: DesfechoDaSuspeita
  /** Gastou leitura ou escrita (conta no teto do ciclo); `false` = veio da memória. */
  avaliou: boolean
}

const MAX_TITULO = 80

function tituloCurto(titulo: string): string {
  return cortarPorPontoDeCodigo(titulo.replace(/\s+/g, ' ').trim(), MAX_TITULO, { sufixo: '…' })
}

function nomeDaEntrega(pr: number | null): string {
  return pr === null ? 'uma entrega já mesclada' : `o PR #${pr}`
}

export function textoDoRegistroDeFechamento(pr: number | null): string {
  return `Entregue ${pr === null ? 'por uma entrega já mesclada' : `pelo PR #${pr}`}. Para desfazer: reabrir esta issue.`
}

/** A pergunta ao dono: o que é a tarefa, o PR, o que mudou depois e as opções. */
export function montarPerguntaDaSuspeita(args: {
  repositorio: string
  tarefa: DepsDaSuspeita['tarefa']
  veredito: VereditoDaSuspeita
  motivoDoDiagnostico: string
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const { tarefa, veredito } = args
  const partes = [
    `A tarefa #${tarefa.numero} de ${args.repositorio} ("${tituloCurto(tarefa.titulo)}") parece já estar resolvida.`,
    `O que a análise do código achou: ${args.motivoDoDiagnostico}`,
  ]
  if (veredito.tipo === 'sem-entrega') {
    partes.push('Não há nenhuma entrega mesclada ligada a esta tarefa.')
  } else if (veredito.tipo === 'entregue') {
    partes.push(
      `Existe ${nomeDaEntrega(veredito.entrega.pullRequest)} mesclado que resolve esta tarefa.`
    )
  } else {
    partes.push(
      `Existe ${nomeDaEntrega(veredito.entrega.pullRequest)} mesclado ligado a esta tarefa, mas ${veredito.motivo}.`
    )
  }
  partes.push('Só esta tarefa fica esperando a sua resposta; as outras seguem. O que eu faço?')
  return {
    text: partes.join('\n\n'),
    options: [
      { label: 'Já está entregue: fechar a tarefa', value: RESPOSTA_FECHAR_A_TAREFA },
      { label: 'Ainda falta fazer: seguir com a tarefa', value: RESPOSTA_SEGUIR_COM_A_TAREFA },
      buildFreeTextOption(),
    ],
    dedupKey: dedupKeyDaSuspeita(args.repositorio, tarefa.numero, tarefa.atualizadaEm),
  }
}

function textoDoPainel(args: {
  repositorio: string
  numero: number
  veredito: VereditoDaSuspeita
  acao: 'fechada' | 'descartada' | 'so-olhar'
}): string {
  const base = `Tarefa #${args.numero} de ${args.repositorio}`
  if (args.acao === 'fechada' && args.veredito.tipo === 'entregue') {
    return `${base} encerrada: ${nomeDaEntrega(args.veredito.entrega.pullRequest)} mesclado resolve a tarefa. Para desfazer: reabrir a issue #${args.numero}.`
  }
  if (args.acao === 'descartada') {
    return `${base}: suspeita descartada, não há entrega mesclada ligada a esta tarefa. Ela segue para o organizador.`
  }
  const achado =
    args.veredito.tipo === 'sem-entrega'
      ? 'não há entrega mesclada ligada a ela'
      : args.veredito.tipo === 'entregue'
        ? `${nomeDaEntrega(args.veredito.entrega.pullRequest)} mesclado parece resolvê-la`
        : `${nomeDaEntrega(args.veredito.entrega.pullRequest)} mesclado está ligado a ela, mas ${args.veredito.motivo}`
  return `${base} parece já resolvida (${achado}). O projeto está em "só olhar", então nada foi alterado e a tarefa não será delegada até você decidir.`
}

/**
 * Decide uma suspeita e devolve o desfecho. Quem chama: `runSmDelegation`, no
 * lugar do antigo comentário que pedia ao dono para conferir e fechar.
 */
export async function resolverSuspeita(deps: DepsDaSuspeita): Promise<ResultadoDaSuspeita> {
  const { tarefa } = deps

  const memoria = await deps.lerMemoria().catch(() => null)
  if (memoria && memoria.issueAtualizadaEm === tarefa.atualizadaEm) {
    return { desfecho: memoria.veredito, avaliou: false }
  }

  let evidencia: EvidenciaDaTarefa
  try {
    evidencia = await deps.coletarEvidencia()
  } catch (err) {
    deps.aviso(
      `suspeita da #${tarefa.numero} de ${deps.repositorio}: não consegui reunir a evidência (${(err as Error).message}); decido na próxima passada`
    )
    return { desfecho: 'aguardando', avaliou: true }
  }
  const veredito = decidirSuspeita({ issueCriadaEm: new Date(tarefa.criadaEm), evidencia })
  const nivel = normalizarNivel(deps.autonomia)
  const chaveBase = `suspeita:${deps.repositorio}#${tarefa.numero}:${Date.parse(tarefa.atualizadaEm) || 0}`
  const lembrar = (v: MemoriaDaSuspeita['veredito']): Promise<void> =>
    deps
      .gravarMemoria({ veredito: v, issueAtualizadaEm: tarefa.atualizadaEm })
      .catch((err) =>
        deps.aviso(
          `suspeita da #${tarefa.numero} de ${deps.repositorio}: decidida, mas não consegui guardar na ficha (${(err as Error).message})`
        )
      )

  const perguntar = async (): Promise<ResultadoDaSuspeita> => {
    const pergunta = montarPerguntaDaSuspeita({
      repositorio: deps.repositorio,
      tarefa,
      veredito,
      motivoDoDiagnostico: deps.motivoDoDiagnostico,
    })
    try {
      if (!(await deps.perguntaAberta(pergunta.dedupKey))) await deps.perguntar(pergunta)
    } catch (err) {
      deps.aviso(
        `suspeita da #${tarefa.numero} de ${deps.repositorio}: não consegui perguntar ao dono (${(err as Error).message})`
      )
      return { desfecho: 'aguardando', avaliou: true }
    }
    await lembrar('perguntada')
    return { desfecho: 'perguntada', avaliou: true }
  }

  if (nivel === 'so_olhar') {
    await deps
      .registrarNoPainel(
        `${chaveBase}:so-olhar`,
        textoDoPainel({
          repositorio: deps.repositorio,
          numero: tarefa.numero,
          veredito,
          acao: 'so-olhar',
        })
      )
      .catch((err) =>
        deps.aviso(`registro no painel da #${tarefa.numero} falhou: ${(err as Error).message}`)
      )
    await lembrar('registrada')
    return { desfecho: 'registrada', avaliou: true }
  }

  if (nivel === 'sugerir') return perguntar()

  // cuidar
  if (veredito.tipo === 'ambiguo') return perguntar()

  if (veredito.tipo === 'sem-entrega') {
    await deps
      .registrarNoPainel(
        `${chaveBase}:descartada`,
        textoDoPainel({
          repositorio: deps.repositorio,
          numero: tarefa.numero,
          veredito,
          acao: 'descartada',
        })
      )
      .catch((err) =>
        deps.aviso(`registro no painel da #${tarefa.numero} falhou: ${(err as Error).message}`)
      )
    await lembrar('descartada')
    return { desfecho: 'descartada', avaliou: true }
  }

  try {
    await deps.fecharTarefa(veredito.entrega.pullRequest)
  } catch (err) {
    deps.aviso(
      `suspeita da #${tarefa.numero} de ${deps.repositorio}: não consegui encerrar a tarefa (${(err as Error).message}); tento na próxima passada`
    )
    return { desfecho: 'aguardando', avaliou: true }
  }
  await deps
    .registrarNoPainel(
      `${chaveBase}:fechada`,
      textoDoPainel({
        repositorio: deps.repositorio,
        numero: tarefa.numero,
        veredito,
        acao: 'fechada',
      })
    )
    .catch((err) =>
      deps.aviso(`registro no painel da #${tarefa.numero} falhou: ${(err as Error).message}`)
    )
  await lembrar('fechada')
  return { desfecho: 'fechada', avaliou: true }
}

// ------------------------------------------------------------ a resposta

export interface DepsDaRespostaDaSuspeita {
  fecharTarefa: (numero: number) => Promise<void>
  gravarMemoria: (numero: number, m: Omit<MemoriaDaSuspeita, 'avaliadaEm'>) => Promise<void>
  registrarNoPainel: (chave: string, texto: string) => Promise<void>
  onWarn: (mensagem: string) => void
}

/**
 * A resposta do dono à pergunta da suspeita. Fechar encerra a tarefa; seguir a
 * devolve à fila. Qualquer outra resposta não pode ser lida como decisão e
 * também devolve a tarefa à fila (o caminho que existia antes da suspeita), com
 * rastro no painel: deixar a tarefa presa por uma resposta ilegível seria
 * repetir o defeito que esta peça veio corrigir.
 */
export async function processarRespostaDaSuspeita(
  args: { dedupKey: string; resposta: string; opcoes: Array<{ value: string }> },
  deps: DepsDaRespostaDaSuspeita
): Promise<void> {
  const chave = lerDedupKeyDaSuspeita(args.dedupKey)
  if (!chave) return
  const { repositorio, numeroDaTarefa, atualizadaEmMs } = chave
  const resposta = args.resposta.trim()
  const issueAtualizadaEm = new Date(atualizadaEmMs).toISOString()
  const daPergunta = (valor: string): boolean => args.opcoes.some((o) => o.value === valor)

  if (resposta === RESPOSTA_FECHAR_A_TAREFA && daPergunta(resposta)) {
    await deps.fecharTarefa(numeroDaTarefa)
    await deps.gravarMemoria(numeroDaTarefa, { veredito: 'fechada', issueAtualizadaEm })
    await deps.registrarNoPainel(
      `suspeita-resposta:${repositorio}#${numeroDaTarefa}:${atualizadaEmMs}`,
      `Tarefa #${numeroDaTarefa} de ${repositorio} encerrada a seu pedido. Para desfazer: reabrir a issue #${numeroDaTarefa}.`
    )
    return
  }

  const seguir = resposta === RESPOSTA_SEGUIR_COM_A_TAREFA && daPergunta(resposta)
  if (!seguir) {
    deps.onWarn(
      `suspeita: resposta do dono sobre a #${numeroDaTarefa} de ${repositorio} não foi uma das opções; a tarefa segue o fluxo normal`
    )
  }
  await deps.gravarMemoria(numeroDaTarefa, { veredito: 'descartada', issueAtualizadaEm })
  await deps.registrarNoPainel(
    `suspeita-resposta:${repositorio}#${numeroDaTarefa}:${atualizadaEmMs}`,
    seguir
      ? `Tarefa #${numeroDaTarefa} de ${repositorio}: você indicou que ainda falta fazer; ela segue para o organizador.`
      : `Tarefa #${numeroDaTarefa} de ${repositorio}: recebi sua resposta, mas ela não era uma das opções; a tarefa segue para o organizador.`
  )
}

/**
 * Encerra a tarefa no GitHub: primeiro o registro (que diz o PR e como
 * desfazer), depois o fechamento. O `fetchImpl` é o da guarda de autonomia do
 * projeto — quem chama nunca passa um `fetch` cru. Lança, com o motivo que o
 * GitHub deu, se qualquer um dos dois passos for recusado.
 */
export async function encerrarTarefaEntregue(args: {
  fetchImpl: typeof fetch
  token: string
  repositorio: string
  numero: number
  pullRequest: number | null
}): Promise<void> {
  const base = `https://api.github.com/repos/${args.repositorio}/issues/${args.numero}`
  const enviar = async (metodo: string, url: string, corpo: unknown): Promise<void> => {
    const resposta = await args.fetchImpl(url, {
      method: metodo,
      headers: headersGithub(args.token, true),
      body: JSON.stringify(corpo),
    })
    if (!resposta.ok) {
      const motivo = await lerMotivoDaResposta(resposta)
      throw new Error(
        `GitHub ${metodo} da tarefa #${args.numero} falhou (${resposta.status})${motivo ? `: ${motivo}` : ''}`
      )
    }
  }
  await enviar('POST', `${base}/comments`, { body: textoDoRegistroDeFechamento(args.pullRequest) })
  await enviar('PATCH', base, { state: 'closed', state_reason: 'completed' })
}
