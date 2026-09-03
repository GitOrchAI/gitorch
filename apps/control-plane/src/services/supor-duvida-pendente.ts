import type { StepExecutor } from './role-rails.js'
import {
  suporSemODono,
  textoDaSuposicaoParaODev,
  textoDoComentarioDeSuposicao,
  type SuposicaoDoRa,
} from './duvida-rails-mission.js'
import { lerMarca, marcarRespondida, ehMarcaDeEscalada } from './pergunta-sem-resposta.js'
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
import { dedupKeyDeDuvidaDoDev } from './dedup-key-de-duvida.js'

export interface PrismaParaSuporDuvidaPendente extends PrismaDevSession {
  project: {
    findUnique: (args: {
      where: { id: string }
    }) => Promise<(NotifiableProject & { id: string; wingId: string }) | null>
  }
  /**
   * C6a (fix-up 3): quando o Jules não devolve mais a última mensagem do dev
   * (sessão "emudecida" — ver `ultimaMensagem` abaixo), a pergunta original
   * ainda existe como `text` da `agent_question` que
   * `escalar-duvida-ao-dono.ts` criou (dedupKey `duvida-dev:<repo>:<issue>:
   * <hash>`, MESMO hash da marca) — é o fallback antes de desistir de vez
   * desta pergunta.
   */
  agentQuestion: {
    findFirst: (args: {
      where: { projectId: string; dedupKey: string; status: 'open' }
      orderBy: { createdAt: 'desc' }
    }) => Promise<{ id: string; text: string } | null>
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
 * C6b (fix-up 3, task a13a42f8-2953-4259-b41f-3f8cddb304cd): padrão do teto
 * de espera antes de avisar o dono que a sessão está "parada há N dias" —
 * ver `GITORCH_DUVIDA_ESCALADA_TETO_MS` (`lerCadenciaMs`, scheduler.ts).
 * Sete dias: bem além do prazo de 24h que já forma a primeira suposição —
 * este é o teto de uma escalada que NUNCA conseguiu formar suposição
 * concreta nenhuma, ciclo após ciclo, e continuaria "imortal" sem um segundo
 * aviso mais grave.
 */
export const PADRAO_TETO_DE_ESPERA_ESCALADA_MS = 7 * 24 * 60 * 60 * 1000

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
 *
 * FIX-UP 3 acrescentou três guardas para a sessão escalada nunca virar
 * "imortal": (C4) uma marca truncada (hash vazio) nunca chega a
 * `marcarAssumida`/`registrarResposta`; (C6a) o dev "emudecido" (Jules não
 * devolve mais a última mensagem) cai para o texto da `agent_question`
 * original antes de desistir; (C6b) uma escalada que nunca forma suposição
 * concreta, ciclo após ciclo, ganha um SEGUNDO aviso ao dono ao passar de
 * `tetoDeEsperaMs` (padrão sete dias) — nunca fecha a sessão (a decisão de
 * fechar é do dono), só garante que ele saiba que ainda está parada.
 */
export async function suporDuvidaPendente(
  args: {
    projectId: string
    repository: string
    execute: StepExecutor
    contextBlocks: string[]
    /**
     * C6b: teto de espera antes do aviso "está parada há N dias". Injetável
     * para teste; produção lê de `GITORCH_DUVIDA_ESCALADA_TETO_MS`
     * (`lerCadenciaMs`, scheduler.ts) com o padrão de sete dias.
     */
    tetoDeEsperaMs?: number
  },
  deps: DepsDeSuporDuvidaPendente
): Promise<void> {
  const ultimaMensagem = deps.ultimaMensagem ?? ultimaMensagemDoDevJulesReal
  const responder = deps.responder ?? responderSessaoJulesReal
  const tetoDeEsperaMs = args.tetoDeEsperaMs ?? PADRAO_TETO_DE_ESPERA_ESCALADA_MS

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
    // C5 (fix-up 3): `ehMarcaDeEscalada` é a fonte ÚNICA desta checagem —
    // MESMA leitura que `sessao-abandonada.ts`/`session-watch.ts` usam.
    const marca = lerMarca(esperando.answeredHash)
    if (!marca || !ehMarcaDeEscalada(esperando.answeredHash)) continue

    // C4 (fix-up 3): uma marca `escalada:0:` truncada (hash vazio/undefined)
    // não tem pergunta real por trás — `marcarAssumida`/`registrarResposta`
    // NUNCA podem receber um hash vazio (gravaria `escalada:1:` ou
    // `respondida:0:` igualmente truncados, e `retomar-sessao-com-
    // resposta.ts` nunca conseguiria casar essa marca de volta com nada).
    // Pula com um aviso interno — não é um caso para incomodar o dono, é um
    // bug de quem gravou a marca.
    if (!marca.hash) {
      deps.onWarn(`${esperando.sessionName} tem marca de escalada truncada (sem hash) — pulando`)
      continue
    }

    const paradoHaMs = esperando.lastProgressAt
      ? deps.agora.getTime() - esperando.lastProgressAt.getTime()
      : Number.POSITIVE_INFINITY
    if (paradoHaMs < HORAS_ATE_TIMEOUT_PERGUNTA_MS) continue

    // Idempotência do AVISO (não da tentativa de suposição): reusa o MESMO
    // formato de três partes que `escalada:0:<hash>` já usa —
    // `escalada:1:<hash>` diz "já avisamos o dono que não achamos suposição
    // concreta (ou nem a pergunta) para esta pergunta"; `escalada:2:<hash>`
    // (C6b) diz "já avisamos que está parada há tetoDeEsperaMs". Sem contar,
    // o aviso se repetiria a cada acordada do QA para sempre — SPAM apaga
    // sinal tanto quanto silêncio.
    const jaAvisadoSemSuposicao = marca.tentativas >= 1
    const jaAvisadoTetoDeEspera = marca.tentativas >= 2

    const apiKey = await deps.chaveDaSessao(esperando.sessionName)
    let pergunta = await ultimaMensagem({
      apiKey,
      sessionName: esperando.sessionName,
      onWarn: deps.onWarn,
    })

    if (!pergunta || pergunta.trim() === '') {
      // C6a (fix-up 3): o dev "emudeceu" (Jules não devolve mais a última
      // mensagem) — antes de desistir, tenta o texto ORIGINAL da
      // `agent_question` que `escalar-duvida-ao-dono.ts` criou (MESMO
      // dedupKey, MESMO hash da marca).
      let perguntaDeFallback: string | undefined
      try {
        const dedupKey = dedupKeyDeDuvidaDoDev({
          repo: args.repository,
          issue: esperando.issueNumber,
          hash: marca.hash,
        })
        const question = await deps.prisma.agentQuestion.findFirst({
          where: { projectId: args.projectId, dedupKey, status: 'open' },
          orderBy: { createdAt: 'desc' },
        })
        perguntaDeFallback = question?.text?.trim() || undefined
      } catch (err) {
        deps.onWarn(
          `${esperando.sessionName}: não deu para buscar a agent_question de fallback: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      }

      if (perguntaDeFallback) {
        pergunta = perguntaDeFallback
      } else {
        // Nem o Jules, nem a agent_question têm a pergunta — não dá para
        // formar suposição nenhuma. Aviso ÚNICO ao dono (idempotente pela
        // MESMA marca `escalada:1:`) e NUNCA fecha a sessão (D64).
        deps.onWarn(
          `${esperando.sessionName} está escalada e vencida, mas não deu para reler a pergunta ` +
            '(nem pelo Jules, nem pela agent_question original)'
        )
        if (!jaAvisadoSemSuposicao) {
          if (deps.avisarDono) {
            const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
            if (projeto) {
              await deps
                .avisarDono(
                  projeto,
                  `GitOrch: a issue #${esperando.issueNumber} ficou 24h esperando sua decisão e eu ` +
                    'não consegui nem reler a pergunta original para tentar formar uma suposição. ' +
                    'O trabalho continua parado até você responder.'
                )
                .catch((err: unknown) =>
                  deps.onWarn(
                    `aviso ao dono sobre ${args.repository}#${esperando.issueNumber} falhou: ` +
                      `${err instanceof Error ? err.message : String(err)}`
                  )
                )
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

      // C1 (fix-up 3) — ORDEM e por quê, documentada porque é fácil inverter
      // por engano:
      //  1. `responder` (entrega ao DEV) já teve que ter sucesso, acima —
      //     sem isso não faz sentido gravar mais nada.
      //  2. `comentarNaIssue` e `marcarAssumida` são BEST-EFFORT (`onWarn`,
      //     NUNCA `.catch(() => undefined)`): a suposição JÁ chegou ao dev
      //     quando eles rodam — uma falha aqui só piora a RASTREABILIDADE
      //     (a issue fica sem o comentário, ou a agent_question nunca vira
      //     `assumida`), nunca desfaz a entrega. Rodam ANTES de
      //     `registrarResposta` de propósito: é o `registrarResposta` que
      //     tira esta sessão da lista de candidatas do próximo tique — se
      //     rodassem depois dele, uma falha no meio deixaria a marca já
      //     `respondida:` mas a issue sem comentário e a pergunta sem
      //     `assumida`, e o próximo tique NUNCA tentaria de novo (a marca
      //     já não é mais `escalada:`).
      //  3. `registrarResposta` é OBRIGATÓRIO: se falhar, loga ERRO (com
      //     repositório/issue) e RELANÇA — nunca silêncio. Sem a marca
      //     atualizada, o PRÓXIMO tique lê `escalada:` de novo e REENVIA a
      //     MESMA suposição ao dev — um reenvio duplicado (o dev vê a
      //     mesma mensagem duas vezes) é pior estética, mas MUITO melhor
      //     que uma sessão presa para sempre com uma marca que nunca
      //     reflete o que já foi entregue.
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
      try {
        await registrarResposta({
          prisma: deps.prisma,
          sessionName: esperando.sessionName,
          hashDaPergunta: marcarRespondida(marca.hash),
          agora: deps.agora,
        })
      } catch (err) {
        const mensagem =
          `CRÍTICO: suposição JÁ entregue ao dev para ${args.repository}#${esperando.issueNumber} ` +
          `(sessão ${esperando.sessionName}), mas registrarResposta falhou — a marca continua ` +
          `'escalada:', então o PRÓXIMO tique vai REENVIAR a mesma suposição ao dev (reenvio ` +
          `duplicado é melhor que sessão presa para sempre): ` +
          `${err instanceof Error ? err.message : String(err)}`
        deps.onWarn(mensagem)
        throw err
      }
      return
    }

    // C6b (fix-up 3): a escalada NUNCA formou suposição concreta, ciclo após
    // ciclo, e já passou do teto de espera (padrão sete dias) — um SEGUNDO
    // aviso, mais grave, para o dono não esquecer que o trabalho continua
    // parado. Idempotente pela MESMA disciplina de `escalada:1:` (marca
    // própria, `escalada:2:`). NUNCA fecha a sessão — fechar é decisão do
    // dono, não do produto (D64).
    if (paradoHaMs >= tetoDeEsperaMs && !jaAvisadoTetoDeEspera) {
      const dias = Math.floor(tetoDeEsperaMs / (24 * 60 * 60 * 1000))
      if (deps.avisarDono) {
        const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
        if (projeto) {
          await deps
            .avisarDono(
              projeto,
              `GitOrch: a sessão da issue #${esperando.issueNumber} está parada há ${dias} dias ` +
                'esperando sua decisão. Eu não consegui formar uma suposição segura para seguir ' +
                'sozinho — só você decide o que fazer com este trabalho parado (não vou fechar a ' +
                'sessão sozinho).'
            )
            .catch((err: unknown) =>
              deps.onWarn(
                `aviso de ${dias} dias parada (${args.repository}#${esperando.issueNumber}) falhou: ` +
                  `${err instanceof Error ? err.message : String(err)}`
              )
            )
        }
      }
      await registrarResposta({
        prisma: deps.prisma,
        sessionName: esperando.sessionName,
        hashDaPergunta: `escalada:2:${marca.hash}`,
        agora: deps.agora,
      })
      return
    }

    // Sem suposição concreta (e ainda dentro do teto de espera maior):
    // mantém a espera — NUNCA fecha, NUNCA inventa. Avisa o dono e grava a
    // marca de "já avisei" NA MESMA passagem, só a PRIMEIRA vez que isto
    // acontecer para esta pergunta.
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
            // C8 (fix-up 3): nunca `.catch(() => undefined)` — uma falha
            // aqui não pode desaparecer sem rastro; loga com repositório e
            // issue para quem for investigar depois.
            .catch((err: unknown) =>
              deps.onWarn(
                `aviso ao dono sobre ${args.repository}#${esperando.issueNumber} falhou: ` +
                  `${err instanceof Error ? err.message : String(err)}`
              )
            )
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
