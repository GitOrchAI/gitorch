import { RAILS_SCHEMAS, buildStepPrompt, type PoReavaliarBloqueioForm } from '@gitorch/cadence'
import { fetchComTeto } from './fetch-com-teto.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import { arquivosDeclarados, lerSecaoDaIssue } from './secao-da-issue.js'
import { extractBlockers } from './sm-delegation.js'
import { registrarNoPainelUmaVez, type PrismaDoRegistroNoPainel } from './registro-no-painel.js'
import { lerCadenciaMs, lerInteiroDaEnv } from './cadencia-de-varredura.js'

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

/** Um bloqueio já publicado no corpo, com o motivo (se houver) e se já foi reavaliado. */
export interface BloqueioComMotivo {
  numero: number
  motivo: string | null
  marcado: boolean
}

/**
 * Lê os "Blocked by #N[, #M...]" do corpo, junto do motivo (se D74 ou uma
 * reavaliação anterior já publicou um) e se o PAR já tem o marcador de
 * idempotência.
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
    return {
      numero,
      motivo: comNumero ?? legado ?? null,
      marcado: texto.includes(marcador(numero)),
    }
  })
}

/** Remove a seção "Blocked by ..." (e as linhas de motivo/marcador dela) do fim do corpo. */
function corpoSemSecaoDeBloqueio(corpo: string): string {
  return corpo
    .replace(/\n*Blocked by\s+[#\d,\s]+(?:\n(?:-.*|<!--\s*gitorch:reavaliado:\d+\s*-->))*\s*$/, '')
    .trimEnd()
}

function renderSecaoDeBloqueio(bloqueios: BloqueioComMotivo[]): string {
  if (bloqueios.length === 0) return ''
  const linhas = [`Blocked by ${bloqueios.map((b) => `#${b.numero}`).join(', ')}`]
  for (const b of bloqueios) {
    if (b.motivo) linhas.push(`- #${b.numero}: ${b.motivo}`)
    if (b.marcado) linhas.push(marcador(b.numero))
  }
  return linhas.join('\n')
}

/**
 * Aplica um lote de decisões (manter/remover) ao corpo de UMA issue,
 * reescrevendo a seção "Blocked by" inteira a partir do estado atual +
 * decisões. `remover` tira o número da lista (linha some se não sobrar
 * nenhum); `manter` garante a linha "- #N: motivo" e marca o par —
 * idempotente: rodar de novo com o mesmo par marcado não o reconsidera
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
      porNumero.set(d.numero, { numero: d.numero, motivo: d.motivo, marcado: true })
    }
  }
  const semSecao = corpoSemSecaoDeBloqueio(corpoAtual)
  const secao = renderSecaoDeBloqueio([...porNumero.values()])
  return secao ? `${semSecao}\n\n${secao}` : semSecao
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
    if (novoCorpo === corpoFresco) return { removidos: 0, mantidos: 0 }

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
        onWarn(
          `reavaliar-bloqueios: motor sem resposta válida para #${t.number}/#${pendente.numero} — sem cota agora, fica para a próxima rodada: ${String(err).slice(0, 150)}`
        )
        result.interrompidoPorMotor = true
        result.restamPendentes = true
        pararRodada = true
        break
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

  const resultado = await runReavaliarBloqueios(options)
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
