import type { StepExecutor } from './role-rails.js'
import {
  suporSemODono,
  textoDaSuposicaoParaODev,
  textoDoComentarioDeSuposicao,
  type SuposicaoDoRa,
} from './duvida-rails-mission.js'
import { lerMarca, marcarRespondida } from './pergunta-sem-resposta.js'
import {
  registrarResposta,
  type PrismaDevSession,
  type LinhaDeSessao,
} from './dev-session-store.js'
import {
  responderSessaoJules as responderSessaoJulesReal,
  ultimaMensagemDoDevJules as ultimaMensagemDoDevJulesReal,
} from './jules-client.js'
import type { NotifiableProject } from './telegram-link.js'
import { HORAS_ATE_TIMEOUT_PERGUNTA_MS } from './session-watch.js'

export interface PrismaParaSuporDuvidaPendente extends PrismaDevSession {
  project: {
    findUnique: (args: {
      where: { id: string }
    }) => Promise<(NotifiableProject & { id: string; wingId: string }) | null>
  }
}

export interface DepsDeSuporDuvidaPendente {
  prisma: PrismaParaSuporDuvidaPendente
  /** BYOK (D34): a chave da conta em que a sessão nasceu. */
  chaveDaSessao: (sessionName: string) => Promise<string | undefined>
  /** Injetável para teste; produção passa `ultimaMensagemDoDevJules` de verdade. */
  ultimaMensagem?: typeof ultimaMensagemDoDevJulesReal
  /** Injetável para teste; produção passa `responderSessaoJules` de verdade. */
  responder?: typeof responderSessaoJulesReal
  /**
   * Comenta na issue do repositório do CLIENTE — sempre pelo fetch guardado
   * pela autonomia do projeto (`guarda-de-autonomia.ts`), nunca um `fetch`
   * cru. Best-effort do lado de quem chama: a suposição já foi entregue ao
   * dev quando isto roda, e uma falha aqui não desfaz isso.
   */
  comentarNaIssue: (args: { issueNumber: number; texto: string }) => Promise<void>
  /**
   * Marca a pergunta ESCALADA como ASSUMIDA pelo RA — `agent-question.ts
   * marcarAssumida`, nunca `answer()`: isto não é uma decisão do dono, é uma
   * suposição provisória que ele ainda pode corrigir.
   */
  marcarAssumida: (args: { issueNumber: number; hash: string; suposicao: string }) => Promise<void>
  avisarDono?: (
    projeto: NotifiableProject & { id: string; wingId: string },
    mensagem: string
  ) => Promise<boolean>
  onWarn: (mensagem: string) => void
  /** O relógio, injetado — sem ele, testar o limiar de 24h dependeria de `Date.now()` real. */
  agora: Date
}

/**
 * A SUPOSIÇÃO do RA quando a dúvida ESCALADA ao dono venceu 24h em silêncio
 * (L4-T4, D64 — fix-up da task a13a42f8-2953-4259-b41f-3f8cddb304cd).
 *
 * Extraído de `plugins/scheduler.ts` para virar testável sem a máquina de
 * missão/motor — MESMA razão e MESMO padrão de `escalar-duvida-ao-dono.ts`
 * (que fez a extração equivalente para o ramo `perguntar-ao-dono` de
 * `responderDuvidaPendente`). Chamado de dentro da MESMA missão de QA que já
 * responde dúvida pendente, logo depois dela, com o `execute:
 * StepExecutor` REAL: é o único lugar do produto onde esse `execute`
 * existe (nasce em `executeMissionWithFailover`, depois do teto diário da
 * instância, do orçamento do plano e da guarda de gasto já terem sido
 * checados — ver `runTrigger`, scheduler.ts). `session-watch.ts`
 * (`vigiarSessoes`) roda no seu próprio `setInterval`
 * (`varrerSessoesDoDev`), fora de qualquer missão, e por isso NUNCA teve um
 * `execute` para chamar: antes desta correção, o hook equivalente
 * (`VigiaDeps.suporSemODono`) era opcional e a produção nunca o fornecia —
 * todo tique caía sempre em "sem suposição concreta".
 *
 * `responderDuvidaPendente` já pula toda sessão com marca `escalada:` —
 * `decidirSobreAPergunta` devolve 'nada' para ela (a pergunta está na mesa
 * do dono, não é "responder de novo"). Esta função faz o oposto: só olha
 * para as marcas `escalada:` que passaram do prazo de 24h
 * (`HORAS_ATE_TIMEOUT_PERGUNTA_MS`, a MESMA constante que `session-watch.ts`
 * usava antes de a decisão se mudar para cá).
 *
 * Erro do MOTOR ao formar a suposição (`suporSemODono` lança) é tratado como
 * "sem suposição concreta" — mesmo comportamento já testado desta função
 * quando ela vivia em `session-watch.ts` (nunca derruba o chamador, avisa o
 * dono uma vez, a próxima acordada tenta de novo).
 */
export async function suporDuvidaPendente(
  args: {
    projectId: string
    repository: string
    execute: StepExecutor
    contextBlocks: string[]
  },
  deps: DepsDeSuporDuvidaPendente
): Promise<void> {
  const ultimaMensagem = deps.ultimaMensagem ?? ultimaMensagemDoDevJulesReal
  const responder = deps.responder ?? responderSessaoJulesReal

  // MESMA consulta que `responderDuvidaPendente` faz: a marca `escalada:`
  // mora na MESMA coluna `answered_hash` que `respondida:`/`tentando:`/
  // `desisti:` (ver pergunta-sem-resposta.ts) — o que muda é o FILTRO
  // aplicado depois, em `lerMarca`.
  const candidatas: LinhaDeSessao[] = await deps.prisma.devSession.findMany({
    where: { projectId: args.projectId, state: 'AWAITING_USER_FEEDBACK', closedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  if (candidatas.length === 0) return

  for (const esperando of candidatas) {
    const marca = lerMarca(esperando.answeredHash)
    if (!marca || marca.situacao !== 'escalada') continue

    const paradoHaMs = esperando.lastProgressAt
      ? deps.agora.getTime() - esperando.lastProgressAt.getTime()
      : Number.POSITIVE_INFINITY
    if (paradoHaMs < HORAS_ATE_TIMEOUT_PERGUNTA_MS) continue

    // Idempotência do AVISO (não da tentativa de suposição): reusa o MESMO
    // formato de três partes que `escalada:0:<hash>` já usa —
    // `escalada:1:<hash>` diz "já avisamos o dono que não achamos suposição
    // concreta para esta pergunta". Sem contar, o aviso se repetiria a cada
    // acordada do QA para sempre — SPAM apaga sinal tanto quanto silêncio.
    const jaAvisadoSemSuposicao = marca.tentativas >= 1

    const apiKey = await deps.chaveDaSessao(esperando.sessionName)
    const pergunta = await ultimaMensagem({
      apiKey,
      sessionName: esperando.sessionName,
      onWarn: deps.onWarn,
    })
    if (!pergunta || pergunta.trim() === '') {
      deps.onWarn(
        `${esperando.sessionName} está escalada e vencida, mas não deu para reler a pergunta`
      )
      continue
    }

    let suposicao: SuposicaoDoRa | null
    try {
      suposicao = await suporSemODono({
        pergunta,
        repository: args.repository,
        issueNumber: esperando.issueNumber,
        execute: args.execute,
        contextBlocks: args.contextBlocks,
      })
    } catch (err) {
      deps.onWarn(
        `suporSemODono falhou para ${esperando.sessionName}: ${err instanceof Error ? err.message : String(err)}`
      )
      suposicao = null
    }

    if (suposicao) {
      const suposicaoFormada = suposicao
      const entregue = await responder({
        apiKey,
        sessionName: esperando.sessionName,
        texto: textoDaSuposicaoParaODev(suposicaoFormada),
        onWarn: deps.onWarn,
      })

      if (!entregue) {
        deps.onWarn(
          `formei uma suposição do RA para ${esperando.sessionName} mas não consegui entregá-la ao dev`
        )
        return
      }

      // Best-effort a partir daqui: a suposição JÁ foi entregue ao dev — uma
      // falha em comentar/marcar não desfaz isso, só fica menos rastreável.
      await deps
        .comentarNaIssue({
          issueNumber: esperando.issueNumber,
          texto: textoDoComentarioDeSuposicao(suposicaoFormada),
        })
        .catch((err: unknown) =>
          deps.onWarn(
            `suposição entregue ao dev, mas não consegui comentar na issue #${esperando.issueNumber}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          )
        )
      await deps
        .marcarAssumida({
          issueNumber: esperando.issueNumber,
          hash: marca.hash,
          suposicao: suposicaoFormada.suposicao,
        })
        .catch((err: unknown) =>
          deps.onWarn(
            `suposição entregue ao dev, mas não consegui marcar a pergunta como assumida ` +
              `(issue #${esperando.issueNumber}): ${err instanceof Error ? err.message : String(err)}`
          )
        )

      // A marca deixa de ser `escalada:` — respondida de verdade (pelo RA,
      // não pelo dono), do MESMO jeito que `retomar-sessao-com-resposta.ts`
      // marca quando é o dono quem responde. Nada disto volta a rodar para
      // esta pergunta, e a sessão NÃO fecha.
      await registrarResposta({
        prisma: deps.prisma,
        sessionName: esperando.sessionName,
        hashDaPergunta: marcarRespondida(marca.hash),
        agora: deps.agora,
      })
      return
    }

    // Sem suposição concreta: mantém a espera — NUNCA fecha, NUNCA inventa.
    // Avisa o dono e grava a marca de "já avisei" NA MESMA passagem, só a
    // PRIMEIRA vez que isto acontecer para esta pergunta.
    if (!jaAvisadoSemSuposicao) {
      if (deps.avisarDono) {
        const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
        if (projeto) {
          await deps
            .avisarDono(
              projeto,
              `GitOrch: a issue #${esperando.issueNumber} ficou 24h esperando sua decisão e eu não ` +
                'consegui formar uma suposição segura para seguir sozinho. O trabalho continua ' +
                'parado até você responder.'
            )
            .catch(() => undefined)
        }
      }
      await registrarResposta({
        prisma: deps.prisma,
        sessionName: esperando.sessionName,
        hashDaPergunta: `escalada:1:${marca.hash}`,
        agora: deps.agora,
      })
    }
    return
  }
}
