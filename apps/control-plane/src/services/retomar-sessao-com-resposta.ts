import type { PrismaDevSession, LinhaDeSessao } from './dev-session-store.js'
import { registrarResposta } from './dev-session-store.js'
import { marcarRespondida } from './pergunta-sem-resposta.js'
import { chaveDaSessaoDoDev, type PrismaParaChaveDoDev } from './chave-do-dev-assincrono.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'
// A2 (fix-up L4-T3): fonte ÚNICA do formato `duvida-dev:<repo>:<issue>:<hash>`
// — reexportado aqui para não quebrar quem já importa daqui.
import { parseDedupKeyDeDuvidaDoDev, type DuvidaDevDedupKey } from './dedup-key-de-duvida.js'

export { parseDedupKeyDeDuvidaDoDev, type DuvidaDevDedupKey }

export interface PrismaParaRetomada extends PrismaDevSession, PrismaParaChaveDoDev {
  project: {
    findFirst: (args: { where: { wingId: string } }) => Promise<{ id: string } | null>
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
    opcoes: Array<{ label: string; value: string }>
  },
  deps: DepsDeRetomada
): Promise<void> {
  const parsed = parseDedupKeyDeDuvidaDoDev(args.dedupKey)
  if (!parsed) return

  const projeto = await deps.prisma.project.findFirst({ where: { wingId: parsed.repository } })
  if (!projeto) {
    throw new Error(
      `aoResponderDuvidaDoDev: projeto ${parsed.repository} não encontrado (dedupKey ${args.dedupKey})`
    )
  }

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
  let sessao = await deps.prisma.devSession.findFirst({
    where: {
      projectId: projeto.id,
      issueNumber: parsed.issueNumber,
      state: 'AWAITING_USER_FEEDBACK',
      answeredHash: `escalada:0:${parsed.hash}`,
    },
  })
  if (!sessao) {
    sessao = await deps.prisma.devSession.findFirst({
      where: {
        projectId: projeto.id,
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
        `(dedupKey ${args.dedupKey}) — a pergunta continua open, nunca adivinha a sessão`
    )
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

  const texto = `${textoDaRespostaParaODev(args.resposta, args.opcoes)}\n\nDecisão do dono.`
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
