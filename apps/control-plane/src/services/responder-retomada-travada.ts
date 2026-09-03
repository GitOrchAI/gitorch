// C2 (fix-up L4-T5, CSO): a escalada de "PR travado em retomada" (D71 — 3
// opções objetivas + livre, `dedupKey: retomada-travada:<repo>:<pr>` — ver
// `dedup-key-de-retomada.ts` e o wiring em `plugins/scheduler.ts`) nascia,
// notificava o dono e MORRIA aí: nenhum manipulador (`ManipuladorDeResposta`,
// agent-question.ts) tratava esta dedupKey. O dono clicava um botão, a
// pergunta sumia da tela (marcada `answered`) e NADA acontecia — a mesma
// classe de defeito já corrigida para `automacao:*` (L4-T2,
// decisao-de-automacao.ts) e `duvida-dev:*` (L4-T3,
// retomar-sessao-com-resposta.ts). Este módulo é o manipulador desta terceira
// dedupKey, ligado em `plugins/telegram.ts` como as outras duas.
//
// Os VALUES reais das opções (`plugins/scheduler.ts`, `perguntarAoDono` de
// `retomarPrReprovado`): 'tentar-de-novo', 'fechar-e-recomecar',
// 'revisar-manualmente' — a 4ª opção (`buildFreeTextOption`) entrega ao dono
// um convite para responder por texto; quando ele faz isso, `resposta` chega
// aqui com o TEXTO LIVRE em si (nunca o placeholder da opção). Por isso
// qualquer valor fora das três primeiras é tratado como "Vou escrever" (D71)
// — mesmo contrato de `processarRespostaDeAutomacao` (decisao-de-automacao.ts).
//
// PURO NA DECISÃO (o switch), INJETADO NA AÇÃO (GitHub/dev assíncrono) — a
// mesma disciplina do resto desta família (`retomar-pr-reprovado.ts`,
// `retomar-sessao-com-resposta.ts`).

import { parseDedupKeyDeRetomada } from './dedup-key-de-retomada.js'
import { sanitizarRespostaLivre } from './decisao-de-automacao.js'
import {
  retomarPrReprovado,
  type DepsDeRetomadaDoPr,
  type ResultadoDeRetomada,
} from './retomar-pr-reprovado.js'

/** Marca o PR encerrado A PEDIDO DO DONO — nunca confundir com o marcador de
 *  `pr-substituido.ts` (fechado porque um PR NOVO nasceu para a mesma
 *  issue): aqui não há PR novo nenhum, é o dono quem decidiu recomeçar. */
export const MARCADOR_PR_ENCERRADO_PELO_DONO = '<!-- gitorch:pr-encerrado-pelo-dono -->'

/** Marca que o dono ASSUMIU este PR — a esteira não tenta mais retomá-lo
 *  sozinha (o PR continua aberto; o marcador é só para auditoria/idempotência
 *  de comentário, o comportamento de "não retomar" já vem de a sessão que
 *  escalou já ter fechado sem que nenhuma nova seja aberta). */
export const MARCADOR_PR_ASSUMIDO_PELO_DONO = '<!-- gitorch:pr-assumido-pelo-dono -->'

/** O mínimo do client do Prisma que este módulo usa. */
export interface PrismaParaRetomadaTravada {
  project: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; wingId: string } | null>
  }
  devSession: {
    /**
     * A linha (viva ou já fechada) que carrega este `pullRequestNumber` — é
     * dela que vem a `issueNumber` para retomar. Pega a MAIS RECENTE (várias
     * retomadas do mesmo PR compartilham `pullRequestNumber`).
     */
    findFirst: (args: unknown) => Promise<{
      issueNumber: number
      sessionName: string
      pullRequestNumber: number | null
    } | null>
  }
}

export interface DepsDeRespostaDeRetomada {
  prisma: PrismaParaRetomadaTravada
  /** Lê o ramo (`head.ref`) do PR — necessário para `tentar-de-novo`. */
  lerPr: (args: { repository: string; prNumber: number }) => Promise<{ headRef: string } | null>
  /** Comenta no PR — usado pelas 3 ações que não são "tentar de novo". */
  comentar: (args: { repository: string; prNumber: number; comentario: string }) => Promise<void>
  /** Fecha o PR (sem mesclar) — só `fechar-e-recomecar`. */
  fecharPr: (args: { repository: string; prNumber: number }) => Promise<void>
  /** Reaproveita a MESMA família de `retomarPrReprovado` — nunca uma segunda
   *  implementação de "abrir sessão do dev assíncrono". */
  criarSessaoDev: DepsDeRetomadaDoPr['criarSessaoDev']
  registrarSessaoRetomada: DepsDeRetomadaDoPr['registrarSessaoRetomada']
  onWarn?: (mensagem: string) => void
  onInfo?: (mensagem: string) => void
}

/**
 * A resposta do DONO à escalada de "PR travado em retomada" vira ação.
 *
 * Ligado em `agent-question.ts answer()` (via `manipuladoresDeResposta`, ao
 * lado de `automacao:`/`duvida-dev:`, `plugins/telegram.ts`) — a ação roda
 * ANTES de marcar a pergunta `answered`: uma falha aqui (lançada, nunca
 * engolida) mantém a pergunta `open` para nova tentativa, nunca finge
 * sucesso.
 *
 * dedupKey de outro tipo nunca aciona nada.
 */
export async function aoResponderRetomadaTravada(
  args: { dedupKey: string; resposta: string; projectId: string },
  deps: DepsDeRespostaDeRetomada
): Promise<void> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  const parsed = parseDedupKeyDeRetomada(args.dedupKey)
  if (!parsed) return

  // Mesma doutrina de `aoResponderDuvidaDoDev` (S1, CSO): o projeto vem
  // SEMPRE por `projectId` (a própria `agent_question`), nunca resolvido por
  // nome de repositório — `wingId` só é único POR DONO, dois donos podem
  // cadastrar o MESMO `acme/api`.
  const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
  if (!projeto) {
    throw new Error(
      `aoResponderRetomadaTravada: projeto ${args.projectId} não encontrado (dedupKey ${args.dedupKey})`
    )
  }
  if (projeto.wingId !== parsed.repository) {
    throw new Error(
      `aoResponderRetomadaTravada: repo do dedupKey (${parsed.repository}) diverge do wingId do ` +
        `projeto ${args.projectId} (${projeto.wingId}) — pergunta continua open`
    )
  }

  switch (args.resposta) {
    case 'tentar-de-novo': {
      // Sem `orderBy`: `DevSession` não tem `createdAt` (o schema não
      // declara — cuidado ao copiar esse `orderBy` de outros arquivos deste
      // produto). Não faz falta aqui: QUALQUER linha com este
      // `pullRequestNumber` tem a MESMA `issueNumber` (é a mesma tarefa, só
      // sessões diferentes tentando o mesmo PR) — não existe "a errada" para
      // escolher.
      const sessaoAnterior = await deps.prisma.devSession.findFirst({
        where: { projectId: args.projectId, pullRequestNumber: parsed.prNumber },
      })
      if (!sessaoAnterior) {
        throw new Error(
          `aoResponderRetomadaTravada: nenhuma sessão encontrada para o PR #${parsed.prNumber} ` +
            `(projeto ${args.projectId}) — não dá para saber a issue, a pergunta continua open`
        )
      }
      const pr = await deps.lerPr({ repository: parsed.repository, prNumber: parsed.prNumber })
      if (!pr) {
        throw new Error(
          `aoResponderRetomadaTravada: não deu para ler o PR #${parsed.prNumber} de ${parsed.repository}`
        )
      }

      const resultado: ResultadoDeRetomada = await retomarPrReprovado(
        {
          projectId: args.projectId,
          repository: parsed.repository,
          issueNumber: sessaoAnterior.issueNumber,
          pr: { number: parsed.prNumber, headRef: pr.headRef },
          parecerDoQa: 'O dono pediu para tentar mais uma vez neste pull request.',
          sessaoAnterior: { sessionName: sessaoAnterior.sessionName },
        },
        {
          // "Zera a contagem de retomadas do PR": o dono decidindo tentar de
          // novo é uma ordem explícita, não mais uma retomada AUTOMÁTICA — o
          // teto (`TETO_DE_RETOMADAS_POR_PR`) existe para não insistir
          // sozinho sem o dono saber, e ele acabou de dizer que sabe.
          contarRetomadasAnteriores: async () => 0,
          criarSessaoDev: deps.criarSessaoDev,
          registrarSessaoRetomada: deps.registrarSessaoRetomada,
          // Nunca deveria ser chamado (o teto zerado sempre decide
          // 'retomar') — se chamar, é bug de wiring, nunca finge sucesso.
          perguntarAoDono: async () => {
            warn(
              `aoResponderRetomadaTravada: retomada forçada do PR #${parsed.prNumber} escalou de ` +
                'novo mesmo com o teto zerado — bug de wiring'
            )
          },
          onWarn: warn,
          onInfo: info,
        }
      )

      if (resultado.acao !== 'retomou') {
        const motivo = resultado.acao === 'nao-retomou' ? resultado.motivo : 'escalou de novo'
        throw new Error(
          `aoResponderRetomadaTravada: retomada forçada do PR #${parsed.prNumber} não aconteceu: ${motivo}`
        )
      }
      info(
        `aoResponderRetomadaTravada: PR #${parsed.prNumber} (issue #${sessaoAnterior.issueNumber}) ` +
          `retomado a pedido do dono — sessão ${resultado.sessionName}`
      )
      return
    }

    case 'fechar-e-recomecar': {
      await deps.comentar({
        repository: parsed.repository,
        prNumber: parsed.prNumber,
        comentario:
          'O dono decidiu encerrar este pull request e recomeçar do zero.\n\n' +
          'A tarefa volta para a fila — a próxima delegação abre um pull request novo.\n\n' +
          MARCADOR_PR_ENCERRADO_PELO_DONO,
      })
      await deps.fecharPr({ repository: parsed.repository, prNumber: parsed.prNumber })
      info(`aoResponderRetomadaTravada: PR #${parsed.prNumber} encerrado a pedido do dono`)
      return
    }

    case 'revisar-manualmente': {
      await deps.comentar({
        repository: parsed.repository,
        prNumber: parsed.prNumber,
        comentario:
          'O dono assumiu este pull request — a esteira não vai mais tentar retomá-lo ' +
          'automaticamente.\n\n' +
          MARCADOR_PR_ASSUMIDO_PELO_DONO,
      })
      info(`aoResponderRetomadaTravada: PR #${parsed.prNumber} assumido pelo dono`)
      return
    }

    default: {
      // "Vou escrever" (D71): qualquer resposta fora das 3 opções conhecidas
      // é texto LIVRE do dono — mesmo tratamento de
      // `processarRespostaDeAutomacao` (decisao-de-automacao.ts): teto de
      // 2000 caracteres, `@menção`/`/comando` neutralizados, cada linha em
      // bloco de citação. Vazio/só espaço não comenta nada.
      const sanitizado = sanitizarRespostaLivre(args.resposta)
      if (sanitizado === null) {
        info(
          `aoResponderRetomadaTravada: resposta livre vazia/só espaços para o PR #${parsed.prNumber} — não comento`
        )
        return
      }
      await deps.comentar({
        repository: parsed.repository,
        prNumber: parsed.prNumber,
        comentario: `Resposta do dono:\n\n${sanitizado}`,
      })
      info(`aoResponderRetomadaTravada: resposta livre registrada no PR #${parsed.prNumber}`)
      return
    }
  }
}
