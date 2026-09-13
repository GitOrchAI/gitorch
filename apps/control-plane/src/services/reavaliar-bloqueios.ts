import { RAILS_SCHEMAS, buildStepPrompt, type PoReavaliarBloqueioForm } from '@gitorch/cadence'
import { fetchComTeto } from './fetch-com-teto.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import { arquivosDeclarados, lerSecaoDaIssue } from './secao-da-issue.js'
import { extractBlockers } from './sm-delegation.js'
import { registrarNoPainelUmaVez, type PrismaDoRegistroNoPainel } from './registro-no-painel.js'
import { lerCadenciaMs } from './cadencia-de-varredura.js'

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
 * Sem motor com cota (execute lança), a rodada PARA no par que falhou —
 * nada além disso é decidido — e devolve o que já foi aplicado; o resto fica
 * para a próxima rodada (o marcador impede reperguntar o que já foi decidido).
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
  }

  paresDeTarefas: for (const t of Array.isArray(tasks) ? tasks : []) {
    const bloqueios = lerBloqueiosComMotivo(t.body)
    const pendentes = bloqueios.filter((b) => !b.marcado)
    if (pendentes.length === 0) continue

    const decisoes: Array<{ numero: number; decisao: 'manter' | 'remover'; motivo: string }> = []

    for (const pendente of pendentes) {
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
        break paresDeTarefas
      }

      decisoes.push({ numero: pendente.numero, decisao: veredito.decisao, motivo: veredito.motivo })
    }

    if (decisoes.length === 0) continue

    // Escreve SEMPRE via `fetchDoRepositorio` (embrulhado em `gh`/`f`) —
    // nunca fetch cru. Uma autonomia "só olhar" recusa a escrita
    // (`EscritaNaoAutorizadaError`); aqui isso vira aviso e a rodada segue
    // para a próxima tarefa, sem contar a decisão como aplicada (ela
    // continua sem marcador e será reperguntada na próxima rodada).
    try {
      for (const d of decisoes) {
        if (d.decisao === 'remover') {
          await gh('POST', `/repos/${options.repository}/issues/${t.number}/comments`, {
            body: `${marcador(d.numero)}\nO PO reavaliou: esta tarefa não depende de #${d.numero} (${d.motivo}). Pode andar em paralelo.`,
          })
        }
      }
      const novoCorpo = aplicarDecisoesNoCorpo(t.body ?? '', decisoes)
      await gh('PATCH', `/repos/${options.repository}/issues/${t.number}`, { body: novoCorpo })
    } catch (err) {
      onWarn(
        `reavaliar-bloqueios: escrita recusada para a #${t.number} (autonomia do projeto) — decisão não aplicada, fica para a próxima rodada: ${String(err).slice(0, 150)}`
      )
      continue
    }

    for (const d of decisoes) {
      if (d.decisao === 'remover') result.removidos += 1
      else result.mantidos += 1
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
 * O ciclo completo por projeto: só roda se a agenda mandar; marca a
 * execução; registra o resultado UMA VEZ na timeline do painel
 * (`registrarNoPainelUmaVez`) — nada vai ao dono (sem agent_question, sem
 * Telegram); acorda o SM se algum bloqueio foi removido (vaga liberada).
 * Devolve `null` quando a agenda decidiu não rodar agora.
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
  await marcarReavaliacaoExecutada({ prisma: options.prisma, projectId: options.projectId })

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
