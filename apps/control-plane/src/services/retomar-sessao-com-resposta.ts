import type { PrismaDevSession, LinhaDeSessao } from './dev-session-store.js'
import { registrarResposta } from './dev-session-store.js'
import { lerMarca, marcarRespondida } from './pergunta-sem-resposta.js'
import { chaveDaSessaoDoDev, type PrismaParaChaveDoDev } from './chave-do-dev-assincrono.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'
// A2 (fix-up L4-T3): fonte ÚNICA do formato `duvida-dev:<repo>:<issue>:<hash>`
// — reexportado aqui para não quebrar quem já importa daqui.
import { parseDedupKeyDeDuvidaDoDev, type DuvidaDevDedupKey } from './dedup-key-de-duvida.js'

export { parseDedupKeyDeDuvidaDoDev, type DuvidaDevDedupKey }

export interface PrismaParaRetomada extends PrismaDevSession, PrismaParaChaveDoDev {
  // S1 (fix-up 2, CSO): por ID — NUNCA por `wingId` (nome do repositório).
  // `wingId` só é único POR DONO (`@@unique([userId, wingId])`, schema.prisma):
  // dois donos podem cadastrar o MESMO `acme/api`, e resolver por nome
  // entregaria a resposta de um dono à sessão do dev do OUTRO.
  project: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; wingId: string } | null>
  } & PrismaParaChaveDoDev['project']
  devSession: {
    findFirst: (args: unknown) => Promise<LinhaDeSessao | null>
  } & PrismaDevSession['devSession'] &
    PrismaParaChaveDoDev['devSession']
}

export interface DepsDeRetomada {
  prisma: PrismaParaRetomada
  decifrar: (envelope: string) => string
  julesApiKeyDaInstancia: string | undefined
  responderSessaoJules?: typeof responderSessaoJulesReal
  onWarn?: (mensagem: string) => void
}

/** Acha a LABEL da opção escolhida (botão do Telegram/painel); sem bater
 *  com nenhuma (resposta livre — D71, "Outro"), usa o texto cru. */
function textoDaRespostaParaODev(
  resposta: string,
  opcoes: Array<{ label: string; value: string }>
): string {
  const escolhida = opcoes.find((o) => o.value === resposta)
  return escolhida ? escolhida.label : resposta
}

// S2 (fix-up 2, CSO — ALTO): o texto da resposta LIVRE do dono ("Outro", D71)
// não tinha teto nenhum antes de virar mensagem para o dev assíncrono — um
// texto absurdamente grande (colado por engano, ou um campo de formulário
// mal validado rio acima) ia inteiro para a API do fornecedor. Corta e avisa
// (nunca falha em silêncio: quem opera vê no log que uma resposta foi
// cortada).
const TETO_DE_CARACTERES_DA_RESPOSTA_DO_DONO = 2000
const SUFIXO_DE_RESPOSTA_TRUNCADA = '[… resposta truncada]'

function limitarTamanhoDaResposta(resposta: string, onWarn?: (mensagem: string) => void): string {
  if (resposta.length <= TETO_DE_CARACTERES_DA_RESPOSTA_DO_DONO) return resposta
  onWarn?.(
    `aoResponderDuvidaDoDev: resposta do dono truncada de ${resposta.length} para ` +
      `${TETO_DE_CARACTERES_DA_RESPOSTA_DO_DONO} caracteres antes de entregar ao dev`
  )
  const tamanhoDoConteudo =
    TETO_DE_CARACTERES_DA_RESPOSTA_DO_DONO - SUFIXO_DE_RESPOSTA_TRUNCADA.length
  return `${resposta.slice(0, tamanhoDoConteudo)}${SUFIXO_DE_RESPOSTA_TRUNCADA}`
}

/**
 * A resposta do DONO a uma dúvida escalada (L4-T3, item 3) RETOMA a sessão
 * do dev assíncrono que ficou esperando.
 *
 * Ligado em `agent-question.ts answer()` ao lado de `aoResponderAutomacao`
 * (L4-T2), MESMA ordem: a ação (entregar a resposta ao dev) roda ANTES de
 * `answer()` marcar a pergunta como `answered` — uma falha aqui mantém a
 * pergunta `open` para nova tentativa, nunca finge sucesso.
 *
 * dedupKey de outro tipo (`automacao:*`, ou qualquer coisa sem o prefixo
 * `duvida-dev:`) nunca aciona nada — é o mesmo contrato de
 * `aoResponderAutomacao`, que só roda para `automacao:*`.
 */
export async function aoResponderDuvidaDoDev(
  args: {
    dedupKey: string
    resposta: string
    // S1 (fix-up 2, CSO): `projectId`/`userId` vêm SEMPRE da própria
    // `agent_question` (`ManipuladorDeRespostaArgs`, agent-question.ts) —
    // fonte de verdade, nunca adivinhados. `userId` não entra em NENHUMA
    // query aqui (só é usado nas mensagens de erro, para auditoria) — quem
    // determina o escopo é `projectId`.
    projectId: string
    userId: string
    opcoes: Array<{ label: string; value: string }>
    /**
     * D2 (fix-up 6, task a13a42f8-2953-4259-b41f-3f8cddb304cd): status da
     * `agent_question` ANTES desta resposta (`agent-question.ts answer()`
     * sempre passa `existing.status`). `assumida` = o dono está CORRIGINDO
     * uma suposição que o RA já formou e já entregou ao dev
     * (`supor-duvida-pendente.ts`) — muda a busca da sessão (abaixo) e a
     * moldura da mensagem. Qualquer outro valor (`open`, o caso comum) usa
     * o fluxo já existente, inalterado.
     */
    statusAnterior?: string
  },
  deps: DepsDeRetomada
): Promise<void> {
  const parsed = parseDedupKeyDeDuvidaDoDev(args.dedupKey)
  if (!parsed) return
  const ehCorrecaoDeSuposicao = args.statusAnterior === 'assumida'

  // S1 (fix-up 2, CSO — CRÍTICO, cross-tenant): NUNCA resolve o projeto por
  // `wingId` (nome do repositório) — o schema só garante `wingId` único POR
  // DONO (`@@unique([userId, wingId])`), então dois donos podem cadastrar o
  // MESMO `acme/api`. Resolver por nome entregava a resposta de um dono à
  // sessão do dev do OUTRO. `projectId` já é o projeto CERTO, resolvido
  // quando a pergunta nasceu (`escalar-duvida-ao-dono.ts`).
  const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
  if (!projeto) {
    throw new Error(
      `aoResponderDuvidaDoDev: projeto ${args.projectId} (userId ${args.userId}) não encontrado ` +
        `(dedupKey ${args.dedupKey})`
    )
  }
  // O repo do dedupKey serve só para CONFERIR/logar — nunca para resolver o
  // projeto. Divergindo do wingId do projeto DA PERGUNTA é dado inconsistente
  // (dedupKey de outro projeto, ou o wingId mudou depois de escalado): erro
  // claro, a pergunta continua open, nunca adivinha.
  if (projeto.wingId !== parsed.repository) {
    throw new Error(
      `aoResponderDuvidaDoDev: repo do dedupKey (${parsed.repository}) diverge do wingId do ` +
        `projeto ${args.projectId} da pergunta (${projeto.wingId}) — pergunta continua open`
    )
  }

  let sessao: LinhaDeSessao | null
  if (ehCorrecaoDeSuposicao) {
    // D2 (fix-up 6): depois que o RA forma a suposição, a marca da sessão
    // deixa de começar por `escalada:` — `supor-duvida-pendente.ts` grava
    // `marcarRespondida(marca.hash)`, que é `respondida:0:<hash>` (MESMO
    // hash, situação diferente). A busca do fluxo comum (abaixo, por
    // `escalada:` exato e depois por `startsWith('escalada:')`) NUNCA
    // acharia essa sessão — a correção do dono falharia com "sessão
    // escalada não encontrada" mesmo com a sessão viva e esperando pelo
    // dev processar a suposição. Aqui a busca ignora a SITUAÇÃO da marca
    // (`respondida`/`escalada`/`tentando`/`desisti` — qualquer uma) e casa
    // só pelo HASH, que identifica ESTA pergunta de forma estável entre a
    // suposição e a correção. Continua restrito a AWAITING_USER_FEEDBACK
    // do mesmo projeto/issue — mesma garantia de nunca adivinhar entre
    // issues diferentes.
    const candidatas = await deps.prisma.devSession.findMany({
      where: {
        projectId: args.projectId,
        issueNumber: parsed.issueNumber,
        state: 'AWAITING_USER_FEEDBACK',
      },
    })
    sessao = candidatas.find((s) => lerMarca(s.answeredHash)?.hash === parsed.hash) ?? null
    if (!sessao) {
      throw new Error(
        `aoResponderDuvidaDoDev: sessão da suposição não encontrada para ${parsed.repository}#${parsed.issueNumber} ` +
          `(projeto ${args.projectId}, hash ${parsed.hash}) — a correção do dono não foi entregue, a pergunta continua assumida`
      )
    }
  } else {
    // Primeiro tenta a sessão com o hash EXATO desta pergunta (a marca
    // `escalada:0:<hash>` gravada por `escalar-duvida-ao-dono.ts`). Sem achar
    // (a sessão pode ter progredido/mudado de marca entretanto), cai para a
    // mais recente sessão do MESMO projeto ainda AWAITING_USER_FEEDBACK **E
    // marcada `escalada:`** — nunca a mais recente AWAITING qualquer.
    //
    // C1 (fix-up L4-T3): com DUAS sessões AWAITING_USER_FEEDBACK na mesma
    // issue — uma escalada de verdade (esperando o dono) e outra só esperando
    // o QA responder algo comum — a busca reserva sem o filtro de marca podia
    // entregar a decisão do dono à sessão ERRADA (a que nem tinha perguntado
    // nada ao dono). A regra agora: só sessão com `answeredHash` começando por
    // `escalada:` é candidata à reserva; sem nenhuma, LANÇA — nunca adivinha.
    sessao = await deps.prisma.devSession.findFirst({
      where: {
        projectId: args.projectId,
        issueNumber: parsed.issueNumber,
        state: 'AWAITING_USER_FEEDBACK',
        answeredHash: `escalada:0:${parsed.hash}`,
      },
    })
    if (!sessao) {
      sessao = await deps.prisma.devSession.findFirst({
        where: {
          projectId: args.projectId,
          issueNumber: parsed.issueNumber,
          state: 'AWAITING_USER_FEEDBACK',
          answeredHash: { startsWith: 'escalada:' },
        },
        orderBy: { createdAt: 'desc' },
      })
    }
    if (!sessao) {
      throw new Error(
        `aoResponderDuvidaDoDev: sessão escalada não encontrada para ${parsed.repository}#${parsed.issueNumber} ` +
          `(projeto ${args.projectId}, dedupKey ${args.dedupKey}) — a pergunta continua open, nunca adivinha a sessão`
      )
    }
  }

  const apiKey = await chaveDaSessaoDoDev(
    {
      prisma: deps.prisma,
      decifrar: deps.decifrar,
      chaveDaInstancia: deps.julesApiKeyDaInstancia,
      ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    },
    sessao.sessionName
  )

  // S2 (fix-up 2, CSO — ALTO): teto de 2000 caracteres na resposta do dono
  // ANTES de montar a mensagem e chamar `responderSessaoJules` — a moldura
  // "Decisão do dono." continua fora do teto (é sempre curta e fixa).
  const respostaLimitada = limitarTamanhoDaResposta(
    textoDaRespostaParaODev(args.resposta, args.opcoes),
    deps.onWarn
  )
  // D2 (fix-up 6): a correção de uma suposição usa uma moldura DIFERENTE do
  // fluxo comum — o dev já recebeu a suposição do RA (`suporSemODono`,
  // `supor-duvida-pendente.ts`) e seguiu a partir dela; sem avisar que isto
  // SUBSTITUI aquilo, o dev não teria como saber que a suposição anterior
  // deixou de valer.
  const texto = ehCorrecaoDeSuposicao
    ? `Correção do dono (substitui a suposição do RA): ${respostaLimitada}`
    : `${respostaLimitada}\n\nDecisão do dono.`
  const responder = deps.responderSessaoJules ?? responderSessaoJulesReal
  const saiu = await responder({
    apiKey,
    sessionName: sessao.sessionName,
    texto,
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
  })
  if (!saiu) {
    throw new Error(
      `aoResponderDuvidaDoDev: não deu para entregar a resposta do dono à sessão ${sessao.sessionName}`
    )
  }

  await registrarResposta({
    prisma: deps.prisma,
    sessionName: sessao.sessionName,
    hashDaPergunta: marcarRespondida(parsed.hash),
    agora: new Date(),
  })
}
