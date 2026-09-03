import type { PrismaDevSession, LinhaDeSessao } from './dev-session-store.js'
import { registrarResposta } from './dev-session-store.js'
import { lerMarca, marcarRespondida } from './pergunta-sem-resposta.js'
import { chaveDaSessaoDoDev, type PrismaParaChaveDoDev } from './chave-do-dev-assincrono.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'
// A2 (fix-up L4-T3): fonte ÚNICA do formato `duvida-dev:<repo>:<issue>:<hash>`
// — reexportado aqui para não quebrar quem já importa daqui.
import {
  parseDedupKeyDeDuvidaDoDev,
  PREFIXO_DUVIDA_DEV,
  type DuvidaDevDedupKey,
} from './dedup-key-de-duvida.js'
// Fix-up (revisão, defeito 5): só para o TIPO — `ResultadoDoManipuladorDeResposta`
// é o que `manipuladorDeResultadoDeRetomada` (abaixo) devolve para o registro
// de manipuladores de `agent-question.ts`. Import type-only: nenhum ciclo em
// tempo de execução (agent-question.ts não importa nada deste arquivo).
import type { ResultadoDoManipuladorDeResposta } from './agent-question.js'
// L4-T21: MESMA sanitização que `processarRespostaDeAutomacao` já usa para
// texto livre do dono antes de virar comentário PÚBLICO numa issue do
// cliente (neutraliza @menção e /comando de ChatOps, cerca em bloco de
// citação) — a correção do dono, quando não há sessão viva para entregá-la
// ao dev, vira exatamente esse tipo de comentário.
import { sanitizarRespostaLivre } from './decisao-de-automacao.js'

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
  /**
   * L4-T21 — defeito medido em produção (issue GitOrchAI/gitorch#309,
   * 02/09 21:07 UTC): a varredura `reprocessar-perguntas-sem-opcoes.ts`
   * marcou perguntas antigas como `assumida`, mas a sessão do dev que
   * recebeu a suposição do RA já tinha morrido — a correção do dono
   * (`ehCorrecaoDeSuposicao`) não achava nenhuma sessão viva pelo hash e
   * `throw`ava, virando HTTP 500 no painel (`routes/painel.ts`) e perdendo
   * a correção (a `agent_question` nunca virava `answered`).
   *
   * Comenta na issue do repositório do CLIENTE quando isso acontece —
   * MESMO contrato de `supor-duvida-pendente.ts`/
   * `suposicao-imediata-de-duvida.ts`: sempre pelo fetch guardado pela
   * autonomia do projeto (nunca um `fetch` cru; produção passa
   * `criarComentarNaIssue`, decisao-de-automacao.ts). BEST-EFFORT do lado
   * de quem chama esta função: a correção do dono JÁ fica durável só por
   * `answer()` gravar `answer`/`status: 'answered'` na própria
   * `agent_question` (quem chama `aoResponderDuvidaDoDev` faz isso
   * INDEPENDENTE do resultado, contanto que esta função não lance) — o
   * comentário na issue é só a segunda metade da rastreabilidade (ligar a
   * orientação à PRÓXIMA delegação daquela issue). Sem este dep configurado
   * (ou se ele falhar), avisa pelo `onWarn` e segue — NUNCA lança.
   */
  comentarNaIssue?: (args: { issueNumber: number; texto: string }) => Promise<void>
}

/**
 * L4-T21: o resultado da correção/decisão do dono. `entregue: true` é o
 * caminho feliz de sempre (sessão viva encontrada e respondida — nenhuma
 * mudança de comportamento). `entregue: false` só acontece na correção de
 * uma suposição (`statusAnterior: 'assumida'`) sem NENHUMA sessão viva
 * esperando: a correção foi registrada de forma durável (comentário na
 * issue + a própria `agent_question` respondida por quem chama), mas o dev
 * só vai vê-la quando esta issue for delegada de novo — NUNCA finge que
 * entregou ao dev quando não entregou.
 *
 * Fix-up (revisão, defeito 5): `motivo` ganhou dois valores novos para o
 * caso em que a própria CHAVE (`dedupKey`) não dá para parsear — antes os
 * dois casos abaixo devolviam o MESMO `{ entregue: false }` sem motivo, e
 * quem chama (`manipuladorDeResultadoDeRetomada`, abaixo) só sabia avisar o
 * dono quando o motivo era `'sem-sessao-viva'`: uma correção do dono numa
 * pergunta com chave malformada sumia sem NENHUM aviso.
 *   - `'nao-aplicavel'`: o `dedupKey` nem começa com `duvida-dev:` — este
 *     manipulador simplesmente não é o dono do assunto (dedupKey de outro
 *     tipo, ex.: `automacao:`). Ficar em silêncio aqui é o CERTO — não é
 *     falha nenhuma.
 *   - `'chave-malformada'`: o `dedupKey` TEM o prefixo `duvida-dev:` mas o
 *     resto não parseia (`parseDedupKeyDeDuvidaDoDev` devolveu `null`) — a
 *     `agent_question` tem uma chave corrompida. Isto É falha de verdade:
 *     `manipuladorDeResultadoDeRetomada` lança para este motivo, nunca
 *     finge sucesso com um aviso.
 */
export interface ResultadoDeRetomada {
  entregue: boolean
  motivo?: 'sem-sessao-viva' | 'nao-aplicavel' | 'chave-malformada'
}

/**
 * L4-T21: o aviso em português (leitor NÃO TÉCNICO — nunca "sessão"/"hash"/
 * "AWAITING") que quem chama `aoResponderDuvidaDoDev` (produção:
 * `plugins/telegram.ts`) devolve como `ResultadoDoManipuladorDeResposta.aviso`
 * quando `resultado.motivo === 'sem-sessao-viva'` — fonte ÚNICA do texto,
 * para o painel e o Telegram nunca divergirem na palavra.
 */
export const AVISO_CORRECAO_SEM_SESSAO_VIVA =
  'Sua orientação foi guardada e será entregue ao dev quando esta tarefa voltar a ser trabalhada.'

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
): Promise<ResultadoDeRetomada> {
  const parsed = parseDedupKeyDeDuvidaDoDev(args.dedupKey)
  if (!parsed) {
    // Fix-up (revisão, defeito 5): os dois `null` de `parseDedupKeyDeDuvidaDoDev`
    // (sem o prefixo vs. com o prefixo mas malformado) não são a MESMA coisa
    // — distinguir aqui, ANTES de qualquer efeito colateral (nenhuma query
    // roda em nenhum dos dois ramos, igual a antes).
    if (!args.dedupKey.startsWith(PREFIXO_DUVIDA_DEV)) {
      return { entregue: false, motivo: 'nao-aplicavel' }
    }
    return { entregue: false, motivo: 'chave-malformada' }
  }
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
      // L4-T21 — defeito medido em produção (issue #309, 02/09 21:07 UTC):
      // a sessão que recebeu a suposição do RA já morreu quando o dono
      // corrige. Isto NÃO É mais um erro que perde a correção do dono — o
      // dono clicou, e a orientação dele NUNCA pode desaparecer. Em vez de
      // lançar (o que virava HTTP 500 no painel e a pergunta ficava presa
      // em `assumida` para sempre, sem NENHUM registro da correção):
      //   1. Comenta na issue do repositório do CLIENTE — best-effort,
      //      pelo helper GUARDADO pela autonomia (nunca um `fetch` cru),
      //      igual a `supor-duvida-pendente.ts`/
      //      `suposicao-imediata-de-duvida.ts`. Sem este dep configurado,
      //      ou se ele falhar, só avisa — nunca lança.
      //   2. Devolve `{ entregue: false, motivo: 'sem-sessao-viva' }` —
      //      quem chama (`answer()`, agent-question.ts) NÃO trata isto como
      //      falha do manipulador: grava `answer`/`status: 'answered'` na
      //      própria `agent_question` normalmente. É ESSE registro (mais o
      //      comentário na issue, ligado à issue) que torna a correção
      //      DURÁVEL — nenhum mecanismo hoje reinjeta `agent_question` na
      //      próxima delegação (sm-delegation.ts/fila-de-delegacao.ts não
      //      leem esta tabela), então o comentário público na issue é o elo
      //      concreto que a próxima rodada de trabalho enxerga.
      const textoDaCorrecao = sanitizarRespostaLivre(
        textoDaRespostaParaODev(args.resposta, args.opcoes)
      )
      const contexto = `${parsed.repository}#${parsed.issueNumber} (projeto ${args.projectId}, hash ${parsed.hash})`
      if (deps.comentarNaIssue && textoDaCorrecao) {
        try {
          await deps.comentarNaIssue({
            issueNumber: parsed.issueNumber,
            texto:
              'GitOrch: o dono corrigiu a suposição anterior do RA para esta issue:\n\n' +
              `${textoDaCorrecao}\n\n` +
              'Nenhuma sessão do dev assíncrono estava viva agora para receber esta correção ' +
              'imediatamente — ela será usada quando este trabalho for retomado.',
          })
        } catch (err) {
          deps.onWarn?.(
            `aoResponderDuvidaDoDev: correção do dono para ${contexto} ficou registrada só na ` +
              `agent_question — não consegui comentar na issue: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      } else {
        deps.onWarn?.(
          `aoResponderDuvidaDoDev: correção do dono para ${contexto} sem sessão viva do dev — ` +
            'registrada só na agent_question (comentarNaIssue ausente ou resposta vazia)'
        )
      }
      return { entregue: false, motivo: 'sem-sessao-viva' }
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

  return { entregue: true }
}

/**
 * Fix-up (revisão, defeito 5): `plugins/telegram.ts` registra
 * `aoResponderDuvidaDoDev` (acima) como o `executar` do manipulador do
 * prefixo `duvida-dev:` em `AgentQuestionService` — e precisa decidir o que
 * FAZER com cada `ResultadoDeRetomada`. Extraído aqui (em vez de um `if`
 * solto dentro do plugin Fastify) para ser testável sem montar
 * app/prisma/telegram inteiros, mesmo padrão de
 * `parseDedupKeyDeDuvidaDoDev`/`criarComentarNaIssue`.
 *
 * Contrato de `ResultadoDoManipuladorDeResposta` (agent-question.ts):
 * `aviso` só faz sentido numa resposta de SUCESSO — um manipulador que falha
 * DE VERDADE continua LANÇANDO, nunca devolvendo aviso (senão finge sucesso
 * e `answer()` marca a pergunta `answered` mesmo a correção do dono tendo
 * se perdido).
 *
 *   - `entregue: true` (caminho feliz) — nada a devolver.
 *   - `motivo: 'sem-sessao-viva'` — sucesso durável, só não entregue de
 *     imediato: aviso em português (`AVISO_CORRECAO_SEM_SESSAO_VIVA`).
 *   - `motivo: 'nao-aplicavel'` — o dedupKey nem era assunto deste
 *     manipulador; silêncio, DE PROPÓSITO (nunca gera aviso).
 *   - `motivo: 'chave-malformada'` — falha de verdade (a `agent_question`
 *     tem uma chave corrompida): lança, para `agent-question.ts answer()`
 *     manter a pergunta `open` e o painel devolver 409 (`ERRO_AO_RESPONDER`,
 *     routes/painel.ts) em vez de fingir sucesso e a correção do dono sumir
 *     sem nenhum aviso.
 */
export function manipuladorDeResultadoDeRetomada(
  resultado: ResultadoDeRetomada
): ResultadoDoManipuladorDeResposta | void {
  if (resultado.entregue) return
  if (resultado.motivo === 'sem-sessao-viva') {
    return { aviso: AVISO_CORRECAO_SEM_SESSAO_VIVA }
  }
  if (resultado.motivo === 'chave-malformada') {
    throw new Error(
      'aoResponderDuvidaDoDev: dedupKey da pergunta tem o prefixo duvida-dev: mas está ' +
        'malformado — a correção do dono não pôde ser interpretada, pergunta continua open'
    )
  }
  // 'nao-aplicavel' (ou um motivo futuro desconhecido): silêncio, de propósito.
}
