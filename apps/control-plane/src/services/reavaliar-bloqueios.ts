import { RAILS_SCHEMAS, buildStepPrompt, type PoReavaliarBloqueioForm } from '@gitorch/cadence'
import { fetchComTeto } from './fetch-com-teto.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import { arquivosDeclarados, lerSecaoDaIssue } from './secao-da-issue.js'
import { extractBlockers } from './sm-delegation.js'
import { registrarNoPainelUmaVez, type PrismaDoRegistroNoPainel } from './registro-no-painel.js'
import { lerCadenciaMs, lerInteiroDaEnv } from './cadencia-de-varredura.js'
import { ehTetoDeUsoDaConta } from './teto-de-uso-da-conta.js'

// DJ-T12: as filas que já existem estão em fila indiana — medido no GitHub
// (26/32 e 22/23 tasks abertas com "Blocked by" num repositório): só a
// primeira de cada corrente pode ser delegada, e o dev assíncrono fica com
// vagas ociosas. D74 (05/09) já barra dependência sem justificativa na
// CRIAÇÃO da tarefa; este serviço faz o mesmo julgamento nas tarefas que já
// nasceram bloqueadas ANTES de D74 existir — o PO relê cada "Blocked by" já
// publicado e solta o que não é dependência real.

/** Só TASK (`gitorch:task`) entra na reavaliação — a mesma etiqueta do SM. */
export const TASK_LABEL = 'gitorch:task'

/** Prefixo do marcador oculto por PAR (tarefa, bloqueador) — idempotência. */
const PREFIXO_MARCADOR = 'gitorch:reavaliado:'

function marcador(bloqueadorNumero: number): string {
  return `<!-- ${PREFIXO_MARCADOR}${bloqueadorNumero} -->`
}

/**
 * Marcador de FALHA do motor por par (tarefa, bloqueador) — DEFEITO 1 (QA,
 * starvation): antes, um erro do motor num par parava a rodada inteira e os
 * pares seguintes nunca eram tentados (medido: 3 rodadas só tentaram o par
 * mais prioritário). Agora o erro conta como tentativa e a contagem fica
 * persistida AQUI (mesmo corpo da issue, sem migração nenhuma) para
 * sobreviver entre rodadas; ao chegar no teto (`TETO_DE_FALHAS_POR_PAR`) o
 * par é pulado nas rodadas seguintes, sem travar os demais.
 */
const PREFIXO_MARCADOR_DE_FALHA = 'gitorch:falha:'

function marcadorDeFalha(bloqueadorNumero: number, contagem: number): string {
  return `<!-- ${PREFIXO_MARCADOR_DE_FALHA}${bloqueadorNumero}:${contagem} -->`
}

/** Depois de 3 falhas seguidas do motor no MESMO par, ele para de ser tentado (só pulado). */
export const TETO_DE_FALHAS_POR_PAR = 3

/** Um bloqueio já publicado no corpo, com o motivo (se houver), se já foi reavaliado e quantas vezes o motor já falhou nesse par. */
export interface BloqueioComMotivo {
  numero: number
  motivo: string | null
  marcado: boolean
  falhas: number
}

/**
 * Lê os "Blocked by #N[, #M...]" do corpo, junto do motivo (se D74 ou uma
 * reavaliação anterior já publicou um), se o PAR já tem o marcador de
 * idempotência e quantas falhas do motor já foram persistidas para ele.
 *
 * Formato reconhecido por blocker: `- #N: <motivo>` (o que este serviço
 * escreve). Formato LEGADO de D74 (`backlog-executor.ts`, um único
 * `- <motivo>` sem número, só faz sentido quando há EXATAMENTE um bloqueio)
 * também é lido, para as tarefas criadas antes deste serviço existir.
 */
export function lerBloqueiosComMotivo(corpo: string | undefined | null): BloqueioComMotivo[] {
  const texto = corpo ?? ''
  const numeros = extractBlockers(texto)
  const legado = numeros.length === 1 ? texto.match(/^-\s*(?!#\d+:)(.+)$/m)?.[1]?.trim() : undefined
  return numeros.map((numero) => {
    const comNumero = texto.match(new RegExp(`^-\\s*#${numero}:\\s*(.+)$`, 'm'))?.[1]?.trim()
    const falha = texto.match(
      new RegExp(`<!--\\s*${PREFIXO_MARCADOR_DE_FALHA}${numero}:(\\d+)\\s*-->`)
    )?.[1]
    return {
      numero,
      motivo: comNumero ?? legado ?? null,
      marcado: texto.includes(marcador(numero)),
      falhas: falha ? Number(falha) : 0,
    }
  })
}

/** Uma linha "Blocked by #N[, #M...]" (o que este serviço sabe reescrever). */
const RE_LINHA_BLOCKED_BY = /^Blocked by\s+[#\d,\s]+$/
/** Linha de motivo (`- #N: ...` ou o formato legado `- ...`) ou marcador (`<!-- gitorch:... -->`) desta seção. */
const RE_LINHA_DE_MOTIVO_OU_MARCADOR = /^(?:-\s+.+|<!--\s*gitorch:[^>]*-->)$/

/**
 * Acha a seção "Blocked by" (a linha em si + as linhas de motivo/marcador
 * contíguas logo abaixo) EM QUALQUER POSIÇÃO do corpo — não só no fim.
 *
 * DEFEITO 2 (QA, perda silenciosa): a versão anterior (`corpoSemSecaoDeBloqueio`)
 * usava uma regex ANCORADA em `$` (fim do corpo). Se alguém acrescentava
 * texto depois da seção "Blocked by" (ela deixava de ser a última coisa do
 * corpo), a regex parava de casar, a reescrita virava no-op e a decisão do
 * PO era descartada em silêncio.
 */
function localizarBlocoDeBloqueio(linhas: string[]): { inicio: number; fim: number } | null {
  const inicio = linhas.findIndex((l) => RE_LINHA_BLOCKED_BY.test(l.trim()))
  if (inicio === -1) return null
  let fim = inicio + 1
  while (fim < linhas.length && RE_LINHA_DE_MOTIVO_OU_MARCADOR.test(linhas[fim]!.trim())) {
    fim += 1
  }
  return { inicio, fim }
}

function renderSecaoDeBloqueio(bloqueios: BloqueioComMotivo[]): string {
  if (bloqueios.length === 0) return ''
  const linhas = [`Blocked by ${bloqueios.map((b) => `#${b.numero}`).join(', ')}`]
  for (const b of bloqueios) {
    if (b.motivo) linhas.push(`- #${b.numero}: ${b.motivo}`)
    if (b.marcado) linhas.push(marcador(b.numero))
    else if (b.falhas > 0) linhas.push(marcadorDeFalha(b.numero, b.falhas))
  }
  return linhas.join('\n')
}

/**
 * Substitui a seção "Blocked by" pela nova (`novaSecao`, já renderizada) NO
 * MESMO LUGAR onde ela estava — preserva todo o texto antes e depois dela.
 * Sem seção existente (não deveria acontecer no fluxo normal, que só chama
 * isto quando já leu bloqueios pendentes do próprio corpo), cai para o
 * comportamento antigo de acrescentar no fim, como rede de segurança.
 */
function substituirSecaoDeBloqueio(corpo: string, novaSecao: string): string {
  const linhas = corpo.split('\n')
  const bloco = localizarBlocoDeBloqueio(linhas)
  if (!bloco) {
    const base = corpo.trimEnd()
    if (!novaSecao) return base
    return base ? `${base}\n\n${novaSecao}` : novaSecao
  }
  const antes = [...linhas.slice(0, bloco.inicio)]
  const depois = [...linhas.slice(bloco.fim)]
  while (antes.length > 0 && antes[antes.length - 1] === '') antes.pop()
  while (depois.length > 0 && depois[0] === '') depois.shift()
  const partes: string[] = []
  if (antes.length > 0) partes.push(antes.join('\n'))
  if (novaSecao) partes.push(novaSecao)
  if (depois.length > 0) partes.push(depois.join('\n'))
  return partes.join('\n\n').trimEnd()
}

/**
 * Aplica um lote de decisões (manter/remover) ao corpo de UMA issue,
 * reescrevendo a seção "Blocked by" NO LUGAR ONDE ELA ESTÁ a partir do
 * estado atual + decisões. `remover` tira o número da lista (linha some se
 * não sobrar nenhum); `manter` garante a linha "- #N: motivo" e marca o par
 * — idempotente: rodar de novo com o mesmo par marcado não o reconsidera
 * (`lerBloqueiosComMotivo` já filtra `marcado` antes de chegar aqui).
 */
export function aplicarDecisoesNoCorpo(
  corpoAtual: string,
  decisoes: Array<{ numero: number; decisao: 'manter' | 'remover'; motivo: string }>
): string {
  const porNumero = new Map(lerBloqueiosComMotivo(corpoAtual).map((b) => [b.numero, b] as const))
  for (const d of decisoes) {
    if (d.decisao === 'remover') {
      porNumero.delete(d.numero)
    } else {
      porNumero.set(d.numero, { numero: d.numero, motivo: d.motivo, marcado: true, falhas: 0 })
    }
  }
  const secao = renderSecaoDeBloqueio([...porNumero.values()])
  return substituirSecaoDeBloqueio(corpoAtual, secao)
}

/**
 * Registra mais uma falha do motor para UM par (tarefa, bloqueador) no
 * próprio corpo — sem migração, reaproveitando o mesmo mecanismo de
 * marcador oculto que já existe para decisões. Devolve o corpo atualizado e
 * a nova contagem; se o par já tinha sido decidido (`marcado`) nesse
 * meio-tempo, não mexe em nada — a decisão já tomada prevalece.
 */
export function registrarFalhaNoCorpo(
  corpoAtual: string,
  bloqueadorNumero: number
): { corpo: string; contagem: number } {
  const bloqueios = lerBloqueiosComMotivo(corpoAtual)
  const alvo = bloqueios.find((b) => b.numero === bloqueadorNumero)
  if (!alvo || alvo.marcado) {
    return { corpo: corpoAtual, contagem: alvo?.falhas ?? 0 }
  }
  const contagem = alvo.falhas + 1
  const atualizados = bloqueios.map((b) =>
    b.numero === bloqueadorNumero ? { ...b, falhas: contagem } : b
  )
  const secao = renderSecaoDeBloqueio(atualizados)
  return { corpo: substituirSecaoDeBloqueio(corpoAtual, secao), contagem }
}

/**
 * Pré-filtro determinístico e barato ANTES de gastar o motor: cruzam Related
 * Files, ou o Goal da tarefa cita o número/título do bloqueador? Nunca decide
 * sozinho — só vira um SINAL a mais no prompt (a régua pede julgamento do PO
 * mesmo quando o sinal é fraco, porque "sem sinal óbvio" ainda pode esconder
 * uma dependência real que o texto não deixou explícita).
 */
export function sinalDeCruzamento(args: {
  tarefaBody: string | undefined | null
  bloqueadorBody: string | undefined | null
  bloqueadorNumero: number
  bloqueadorTitulo: string | undefined
}): { cruza: boolean; sinal: string } {
  const arquivosTarefa = new Set(arquivosDeclarados(args.tarefaBody))
  const arquivosBloqueador = new Set(arquivosDeclarados(args.bloqueadorBody))
  const cruzaArquivo = [...arquivosTarefa].some((a) => arquivosBloqueador.has(a))
  const objetivo = lerSecaoDaIssue(args.tarefaBody, 'Goal')
  const citaNumero = objetivo.includes(`#${args.bloqueadorNumero}`)
  const titulo = (args.bloqueadorTitulo ?? '').trim()
  const citaTitulo = titulo.length > 0 && objetivo.toLowerCase().includes(titulo.toLowerCase())
  const cruza = cruzaArquivo || citaNumero || citaTitulo
  const sinal = cruza
    ? 'Pré-filtro determinístico: HÁ sinal de cruzamento (Related File em comum, ou o Goal cita o bloqueador).'
    : 'Pré-filtro determinístico: SEM sinal de cruzamento (nenhum Related File em comum e o Goal não cita o bloqueador) — mesmo assim, decida com julgamento; a ausência de sinal textual não decide sozinha.'
  return { cruza, sinal }
}

/** Teto de PARES (tarefa, bloqueador) que chamam o motor numa única rodada — protege a cota e o tempo da missão do PO (medido: 29 pares num único repositório levariam a rodada inteira para o motor). */
export const ENV_POR_RODADA_DE_REAVALIACAO = 'GITORCH_REAVALIAR_BLOQUEIOS_POR_RODADA'
const TETO_PADRAO_POR_RODADA = 8

interface TaskParaPriorizar {
  number: number
  body?: string | null
}

/**
 * Ordena as tasks com bloqueio pendente para decidir QUAIS pares cabem no
 * teto desta rodada: prioriza a task que é CABEÇA da corrente mais longa —
 * a que, resolvida, libera a maior sequência de tarefas atrás dela (maior
 * ganho de paralelismo). Empate (correntes do mesmo tamanho, ou nenhuma
 * corrente) desempata pela mais antiga (menor número — ordem de criação no
 * GitHub).
 *
 * "Corrente" só enxerga as próprias `tasks` desta rodada (mesma etiqueta
 * `gitorch:task`); um bloqueador fora dessa lista é uma folha (comprimento
 * 1) — não há como saber se ele também está numa corrente maior sem buscá-lo.
 */
export function ordenarPorPrioridadeDeCorrente<T extends TaskParaPriorizar>(tasks: T[]): T[] {
  const porNumero = new Map(tasks.map((t) => [t.number, t] as const))
  const dependentesDe = new Map<number, number[]>()
  for (const t of tasks) {
    for (const b of extractBlockers(t.body ?? '')) {
      if (!porNumero.has(b)) continue
      const lista = dependentesDe.get(b) ?? []
      lista.push(t.number)
      dependentesDe.set(b, lista)
    }
  }
  const memo = new Map<number, number>()
  function comprimento(numero: number, caminho: Set<number>): number {
    const guardado = memo.get(numero)
    if (guardado !== undefined) return guardado
    if (caminho.has(numero)) return 0 // ciclo (não deveria existir) — corta aqui, nunca gira para sempre
    caminho.add(numero)
    let maior = 0
    for (const dep of dependentesDe.get(numero) ?? []) {
      maior = Math.max(maior, comprimento(dep, caminho))
    }
    caminho.delete(numero)
    const resultado = 1 + maior
    memo.set(numero, resultado)
    return resultado
  }
  const comprimentos = new Map(
    tasks.map((t) => [t.number, comprimento(t.number, new Set())] as const)
  )
  return [...tasks].sort((a, b) => {
    const diff = (comprimentos.get(b.number) ?? 0) - (comprimentos.get(a.number) ?? 0)
    return diff !== 0 ? diff : a.number - b.number
  })
}

export interface ReavaliarBloqueiosOptions {
  repository: string
  githubToken: string
  execute: StepExecutor
  /** Fetch já embrulhado por `fetchDoRepositorio` (guarda de autonomia); sem ele, cai no nível mais restrito. */
  fetchImpl?: typeof fetch
  onWarn?: (mensagem: string) => void
  /**
   * Chamado (best-effort) UMA VEZ quando um par (tarefa, bloqueador) esgota
   * as tentativas (`TETO_DE_FALHAS_POR_PAR` falhas do motor, nenhuma delas
   * erro de cota) e passa a ser pulado nas rodadas seguintes — quem chama
   * decide se/como registrar isso no painel (`registrarNoPainelUmaVez`, que
   * já deduplica por chave).
   */
  onParEsgotado?: (par: { taskNumber: number; blockerNumber: number }) => void
}

export interface ReavaliarBloqueiosResult {
  removidos: number
  mantidos: number
  /** true quando o motor ficou sem resposta válida (cota) e a rodada parou antes de terminar. */
  interrompidoPorMotor: boolean
  /**
   * true quando, ao fim desta rodada, ainda existe algum "Blocked by" sem
   * marcador (teto da rodada atingido, motor sem cota, releitura ou escrita
   * recusadas). A agenda semanal (`deveRodarReavaliacaoAgora`) só marca a
   * rodada como concluída quando isto vier `false` — enquanto for `true`,
   * a próxima missão do PO roda de novo, sem esperar os 7 dias.
   */
  restamPendentes: boolean
}

interface IssueDoGithub {
  number: number
  title?: string
  body?: string
  labels: Array<{ name: string }>
}

/**
 * Reavalia os "Blocked by" já publicados em UM repositório: para cada tarefa
 * aberta (`gitorch:task`) com bloqueador aberto ainda não reavaliado, pede ao
 * motor do PO uma decisão estruturada (mesmo mecanismo StepExecutor/schema do
 * roteiro do PO) e aplica no GitHub via `fetchDoRepositorio`
 * (`options.fetchImpl`) — nunca `fetch` cru.
 *
 * Teto por rodada (`GITORCH_REAVALIAR_BLOQUEIOS_POR_RODADA`, padrão 8, mesma
 * guarda `lerInteiroDaEnv` do scheduler): só essa quantidade de PARES chama o
 * motor nesta chamada — protege a cota e o tempo da missão do PO. A ordem é
 * `ordenarPorPrioridadeDeCorrente` (cabeça da corrente mais longa primeiro,
 * empate pelo mais antigo); os pares que não couberem ficam pendentes
 * (`restamPendentes: true`) e são os primeiros da PRÓXIMA chamada — o
 * marcador de idempotência impede reperguntar o que já foi decidido.
 *
 * Sem motor com cota (execute lança), a rodada PARA no par que falhou —
 * nada além disso é decidido para aquela tarefa — e devolve o que já foi
 * aplicado; o resto fica para a próxima rodada.
 *
 * Antes de aplicar qualquer decisão numa issue, relê o corpo pelo GET
 * (`aplicarDecisoesNaIssue`): o corpo usado para montar o prompt pode já
 * estar velho quando o motor devolve o veredito — SM/PO podem ter editado a
 * issue nesse intervalo. A decisão é aplicada sobre o corpo FRESCO; se o
 * bloqueador decidido não está mais no "Blocked by" fresco (alguém já
 * resolveu), o par é pulado sem erro e sem PATCH.
 */
export async function runReavaliarBloqueios(
  options: ReavaliarBloqueiosOptions
): Promise<ReavaliarBloqueiosResult> {
  const f = fetchComTeto(options.fetchImpl ?? fetchSemPermissao())
  const onWarn = options.onWarn ?? (() => undefined)

  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`GitHub ${method} ${path} failed (${resp.status}): ${detail.slice(0, 150)}`)
    }
    return resp.json().catch(() => ({}))
  }

  const tasks = (await gh(
    'GET',
    `/repos/${options.repository}/issues?state=open&labels=${encodeURIComponent(TASK_LABEL)}&per_page=100`
  )) as IssueDoGithub[]

  const result: ReavaliarBloqueiosResult = {
    removidos: 0,
    mantidos: 0,
    interrompidoPorMotor: false,
    restamPendentes: false,
  }

  /**
   * Aplica um lote de decisões (já com o veredito do motor) numa ÚNICA
   * issue: relê o corpo fresco, descarta as decisões cujo bloqueador já
   * saiu do "Blocked by" (edição concorrente), grava comentário + PATCH só
   * se algo de fato mudou, e devolve quantas decisões pegaram.
   */
  const aplicarDecisoesNaIssue = async (
    t: IssueDoGithub,
    decisoes: Array<{ numero: number; decisao: 'manter' | 'remover'; motivo: string }>
  ): Promise<{ removidos: number; mantidos: number }> => {
    let corpoFresco: string
    try {
      const fresh = (await gh('GET', `/repos/${options.repository}/issues/${t.number}`)) as {
        body?: string
      }
      corpoFresco = fresh.body ?? ''
    } catch (err) {
      onWarn(
        `reavaliar-bloqueios: não deu para reler a #${t.number} antes de aplicar; decisão fica para a próxima rodada: ${String(err).slice(0, 150)}`
      )
      result.restamPendentes = true
      return { removidos: 0, mantidos: 0 }
    }

    // Se o bloqueador decidido já saiu do "Blocked by" fresco — alguém
    // (SM/PO, ou outra rodada) mexeu na issue nesse meio-tempo — o par não é
    // mais real: pula sem erro, sem reaplicar uma decisão sobre bloqueio que
    // já sumiu.
    const bloqueiosNoCorpoFresco = new Set(lerBloqueiosComMotivo(corpoFresco).map((b) => b.numero))
    const decisoesValidas = decisoes.filter((d) => bloqueiosNoCorpoFresco.has(d.numero))
    if (decisoesValidas.length === 0) return { removidos: 0, mantidos: 0 }

    const novoCorpo = aplicarDecisoesNoCorpo(corpoFresco, decisoesValidas)
    if (novoCorpo === corpoFresco) {
      // DEFEITO 2 (QA, perda silenciosa): havia decisão(ões) válida(s) mas o
      // corpo resultante não mudou nada — sinal de que a seção "Blocked by"
      // não foi localizada/reescrita como deveria. Nunca tratar isto como
      // "nada a fazer, rodada concluída": fica pendente e avisa, para a
      // próxima rodada tentar de novo em vez de perder a decisão calada.
      onWarn(
        `reavaliar-bloqueios: decisão(ões) da #${t.number} não mudaram o corpo (a seção "Blocked by" não foi reescrita) — fica pendente para não perder a decisão em silêncio.`
      )
      result.restamPendentes = true
      return { removidos: 0, mantidos: 0 }
    }

    // Escreve SEMPRE via `fetchDoRepositorio` (embrulhado em `gh`/`f`) —
    // nunca fetch cru. Uma autonomia "só olhar" recusa a escrita
    // (`EscritaNaoAutorizadaError`); aqui isso vira aviso e a decisão
    // continua sem marcador, reperguntada na próxima rodada.
    try {
      for (const d of decisoesValidas) {
        if (d.decisao === 'remover') {
          await gh('POST', `/repos/${options.repository}/issues/${t.number}/comments`, {
            body: `${marcador(d.numero)}\nO PO reavaliou: esta tarefa não depende de #${d.numero} (${d.motivo}). Pode andar em paralelo.`,
          })
        }
      }
      await gh('PATCH', `/repos/${options.repository}/issues/${t.number}`, { body: novoCorpo })
    } catch (err) {
      onWarn(
        `reavaliar-bloqueios: escrita recusada para a #${t.number} (autonomia do projeto) — decisão não aplicada, fica para a próxima rodada: ${String(err).slice(0, 150)}`
      )
      result.restamPendentes = true
      return { removidos: 0, mantidos: 0 }
    }

    let removidos = 0
    let mantidos = 0
    for (const d of decisoesValidas) {
      if (d.decisao === 'remover') removidos += 1
      else mantidos += 1
    }
    return { removidos, mantidos }
  }

  /**
   * Persiste mais uma falha do motor (não-cota) para UM par (tarefa,
   * bloqueador) — relê o corpo fresco antes (mesma disciplina de
   * `aplicarDecisoesNaIssue`, para não pisar numa edição concorrente); sem
   * GET fresco, incrementa em cima do corpo em mãos mesmo assim (melhor
   * tentar persistir do que perder a contagem). Devolve a nova contagem.
   */
  const persistirFalhaDoPar = async (
    t: IssueDoGithub,
    bloqueadorNumero: number
  ): Promise<number> => {
    let corpoFresco = t.body ?? ''
    try {
      const fresh = (await gh('GET', `/repos/${options.repository}/issues/${t.number}`)) as {
        body?: string
      }
      corpoFresco = fresh.body ?? corpoFresco
    } catch {
      // segue com o corpo em mãos
    }
    const { corpo: novoCorpo, contagem } = registrarFalhaNoCorpo(corpoFresco, bloqueadorNumero)
    if (novoCorpo !== corpoFresco) {
      try {
        await gh('PATCH', `/repos/${options.repository}/issues/${t.number}`, { body: novoCorpo })
        t.body = novoCorpo
      } catch (err) {
        onWarn(
          `reavaliar-bloqueios: não deu para gravar a falha do motor para #${t.number}/#${bloqueadorNumero} (autonomia do projeto); contagem não persistida: ${String(err).slice(0, 150)}`
        )
      }
    }
    return contagem
  }

  const teto = lerInteiroDaEnv(ENV_POR_RODADA_DE_REAVALIACAO, TETO_PADRAO_POR_RODADA, onWarn)
  const ordemPrioritaria = ordenarPorPrioridadeDeCorrente(Array.isArray(tasks) ? tasks : [])

  let chamadasAoMotor = 0
  let pararRodada = false

  for (const t of ordemPrioritaria) {
    if (pararRodada) break

    const bloqueios = lerBloqueiosComMotivo(t.body)
    const pendentes = bloqueios.filter((b) => !b.marcado)
    if (pendentes.length === 0) continue

    const decisoes: Array<{ numero: number; decisao: 'manter' | 'remover'; motivo: string }> = []

    for (const pendente of pendentes) {
      // DEFEITO 1 (QA, starvation): par já esgotou as tentativas em rodadas
      // anteriores — pula sem chamar o motor de novo, sem consumir o teto
      // da rodada e sem travar os pares seguintes.
      if (pendente.falhas >= TETO_DE_FALHAS_POR_PAR) {
        result.restamPendentes = true
        continue
      }

      if (chamadasAoMotor >= teto) {
        result.restamPendentes = true
        pararRodada = true
        break
      }

      let bloqueador: { number?: number; state?: string; title?: string; body?: string }
      try {
        bloqueador = (await gh(
          'GET',
          `/repos/${options.repository}/issues/${pendente.numero}`
        )) as {
          state?: string
          title?: string
          body?: string
        }
      } catch (err) {
        onWarn(
          `reavaliar-bloqueios: não deu para ler #${pendente.numero} (bloqueador da #${t.number}); segue para a próxima rodada: ${String(err).slice(0, 150)}`
        )
        result.restamPendentes = true
        continue
      }
      // Bloqueador já fechado não é mais bloqueio ativo — a fila normal do SM
      // já enxerga isso via `extractBlockers`; esta reavaliação só trata do
      // que AINDA trava a delegação.
      if (bloqueador.state !== 'open') continue

      const { sinal } = sinalDeCruzamento({
        tarefaBody: t.body,
        bloqueadorBody: bloqueador.body,
        bloqueadorNumero: pendente.numero,
        bloqueadorTitulo: bloqueador.title,
      })

      const prompt = buildStepPrompt(
        'po',
        'po-reavaliar-bloqueio',
        RAILS_SCHEMAS.poReavaliarBloqueio,
        [
          `Task under review: #${t.number} ${t.title ?? ''}\nGoal: ${lerSecaoDaIssue(t.body, 'Goal')}\nRelated Files: ${arquivosDeclarados(t.body).join(', ') || '(none declared)'}`,
          `Blocker under review: #${pendente.numero} ${bloqueador.title ?? ''}\nGoal: ${lerSecaoDaIssue(bloqueador.body, 'Goal')}\nRelated Files: ${arquivosDeclarados(bloqueador.body).join(', ') || '(none declared)'}`,
          sinal,
          'Decida "manter" APENAS quando a tarefa em revisão USA um RESULTADO concreto que o bloqueador produz (um arquivo que ele cria, uma rota, uma coluna, um contrato de dados/interface). Tocar área ou arquivo diferente NÃO é dependência — decida "remover" para as duas andarem em paralelo.',
        ]
      )

      chamadasAoMotor += 1
      let veredito: PoReavaliarBloqueioForm
      try {
        veredito = (await runFormStep({
          schema: RAILS_SCHEMAS.poReavaliarBloqueio,
          prompt,
          execute: options.execute,
        })) as PoReavaliarBloqueioForm
      } catch (err) {
        const mensagemDeErro = err instanceof Error ? err.message : String(err)
        if (ehTetoDeUsoDaConta(mensagemDeErro)) {
          // Sem cota é diferente de um erro qualquer do motor (D76): a
          // conta bateu no teto, e insistir nos próximos pares só gastaria
          // chamadas à toa contra a mesma cota zerada — a rodada inteira
          // espera a próxima vez.
          onWarn(
            `reavaliar-bloqueios: motor sem cota para #${t.number}/#${pendente.numero} — fica para a próxima rodada: ${mensagemDeErro.slice(0, 150)}`
          )
          result.interrompidoPorMotor = true
          result.restamPendentes = true
          pararRodada = true
          break
        }
        // DEFEITO 1 (QA, starvation): erro do motor que NÃO é falta de cota
        // (resposta inválida, timeout do provedor, etc.) conta como
        // tentativa falha SÓ deste par — a rodada segue para os próximos
        // pares/tarefas em vez de parar aqui. A contagem fica persistida no
        // corpo da issue; ao chegar em `TETO_DE_FALHAS_POR_PAR`, o par passa
        // a ser pulado (acima, no início deste for) para não travar os
        // demais para sempre.
        const contagem = await persistirFalhaDoPar(t, pendente.numero)
        onWarn(
          `reavaliar-bloqueios: motor falhou (não é cota) para #${t.number}/#${pendente.numero} — tentativa ${contagem}/${TETO_DE_FALHAS_POR_PAR}: ${mensagemDeErro.slice(0, 150)}`
        )
        result.restamPendentes = true
        if (contagem >= TETO_DE_FALHAS_POR_PAR) {
          options.onParEsgotado?.({ taskNumber: t.number, blockerNumber: pendente.numero })
        }
        continue
      }

      decisoes.push({ numero: pendente.numero, decisao: veredito.decisao, motivo: veredito.motivo })
    }

    if (decisoes.length > 0) {
      const aplicado = await aplicarDecisoesNaIssue(t, decisoes)
      result.removidos += aplicado.removidos
      result.mantidos += aplicado.mantidos
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Agenda: uma vez por semana por projeto, e a primeira vez logo após o boot.
// ---------------------------------------------------------------------------

const ENV_CADENCIA_MS = 'GITORCH_REAVALIAR_BLOQUEIOS_CADENCIA_MS'
const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000
/** Reaproveita a tabela `events` (sem migração) só para marcar "já rodei". */
export const TIPO_EVENTO_ULTIMA_EXECUCAO = 'reavaliar-bloqueios:execucao'

/** Só o que a agenda precisa do Prisma. */
export interface PrismaDaAgendaDeReavaliacao {
  event: {
    findFirst: (args: {
      where: { projectId: string; type: string }
      orderBy: { createdAt: 'desc' }
    }) => Promise<{ createdAt: Date } | null>
    create: (args: {
      data: { projectId: string; type: string; payload: Record<string, unknown> }
    }) => Promise<unknown>
  }
}

/**
 * true quando é hora de rodar: nunca rodou antes (primeira vez após o boot),
 * ou já passou a cadência (padrão 7 dias, `lerCadenciaMs` — mesma guarda
 * contra env inválida que o resto do scheduler usa) desde a última execução.
 */
export async function deveRodarReavaliacaoAgora(args: {
  prisma: PrismaDaAgendaDeReavaliacao
  projectId: string
  agora?: Date
  onWarn?: (mensagem: string) => void
}): Promise<boolean> {
  const ultima = await args.prisma.event.findFirst({
    where: { projectId: args.projectId, type: TIPO_EVENTO_ULTIMA_EXECUCAO },
    orderBy: { createdAt: 'desc' },
  })
  if (!ultima) return true
  const cadenciaMs = lerCadenciaMs(ENV_CADENCIA_MS, SETE_DIAS_MS, args.onWarn)
  const agora = (args.agora ?? new Date()).getTime()
  return agora - ultima.createdAt.getTime() >= cadenciaMs
}

async function marcarReavaliacaoExecutada(args: {
  prisma: PrismaDaAgendaDeReavaliacao
  projectId: string
}): Promise<void> {
  await args.prisma.event.create({
    data: {
      projectId: args.projectId,
      type: TIPO_EVENTO_ULTIMA_EXECUCAO,
      payload: { executadoEm: new Date().toISOString() },
    },
  })
}

export interface RodarReavaliacaoDeProjetoOptions extends ReavaliarBloqueiosOptions {
  prisma: PrismaDaAgendaDeReavaliacao & PrismaDoRegistroNoPainel
  projectId: string
  agora?: Date
  /** `app.acordarSmPorVagaLiberada` do scheduler — best-effort, nunca lança. */
  acordarSmPorVagaLiberada?: (projectId: string, motivo: string) => void
}

/**
 * O ciclo completo por projeto: só roda se a agenda mandar; registra o
 * resultado UMA VEZ na timeline do painel (`registrarNoPainelUmaVez`) —
 * nada vai ao dono (sem agent_question, sem Telegram); acorda o SM se algum
 * bloqueio foi removido (vaga liberada). Devolve `null` quando a agenda
 * decidiu não rodar agora.
 *
 * A execução só é marcada como CONCLUÍDA (`marcarReavaliacaoExecutada`)
 * quando `resultado.restamPendentes` vem `false` — com pendente sobrando
 * (teto da rodada, motor sem cota, escrita recusada), a marca da última
 * execução NÃO avança: `deveRodarReavaliacaoAgora` continua achando que já
 * passou da hora, então a PRÓXIMA missão do PO roda de novo, sem esperar os
 * 7 dias da cadência normal. Só quando zera o pendente é que o ciclo volta a
 * ser semanal.
 */
export async function rodarReavaliacaoDeProjetoSeForAHora(
  options: RodarReavaliacaoDeProjetoOptions
): Promise<ReavaliarBloqueiosResult | null> {
  const deveRodar = await deveRodarReavaliacaoAgora({
    prisma: options.prisma,
    projectId: options.projectId,
    ...(options.agora ? { agora: options.agora } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  })
  if (!deveRodar) return null

  const resultado = await runReavaliarBloqueios({
    ...options,
    onParEsgotado: (par) => {
      options.onParEsgotado?.(par)
      // best-effort: registra no painel UMA VEZ por par esgotado
      // (`registrarNoPainelUmaVez` já deduplica pela chave) — nunca lança,
      // mesmo padrão de `acordarSmPorVagaLiberada` logo abaixo.
      registrarNoPainelUmaVez({
        prisma: options.prisma,
        projectId: options.projectId,
        chave: `reavaliar-bloqueios:esgotado:${options.repository}:${par.taskNumber}:${par.blockerNumber}`,
        texto: `PO desistiu de reavaliar #${par.taskNumber}↔#${par.blockerNumber} em ${options.repository}: o motor falhou ${TETO_DE_FALHAS_POR_PAR}x seguidas (não é cota). Decisão manual necessária.`,
      }).catch(() => undefined)
    },
  })
  if (!resultado.restamPendentes) {
    await marcarReavaliacaoExecutada({ prisma: options.prisma, projectId: options.projectId })
  }

  const dataDeHoje = (options.agora ?? new Date()).toISOString().slice(0, 10)
  await registrarNoPainelUmaVez({
    prisma: options.prisma,
    projectId: options.projectId,
    chave: `reavaliar-bloqueios:${options.repository}:${dataDeHoje}`,
    texto: `PO reavaliou os bloqueios de ${options.repository}: ${resultado.removidos} bloqueio(s) removido(s), ${resultado.mantidos} mantido(s).`,
  })

  if (resultado.removidos > 0 && options.acordarSmPorVagaLiberada) {
    try {
      options.acordarSmPorVagaLiberada(
        options.projectId,
        'reavaliação de bloqueios liberou tarefa(s)'
      )
    } catch {
      // best-effort — mesmo padrão de app.acordarSmPorVagaLiberada em telegram.ts
    }
  }

  return resultado
}
