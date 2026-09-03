// A porta ÚNICA de escrita e leitura da ligação issue ↔ sessão do dev
// assíncrono ↔ PR.
//
// Única de propósito. A ligação já existia — a delegação a imprimia como texto
// na saída da missão ("#24 → sessions/…") — e evaporava com o log, porque não
// havia lugar nenhum guardando. Se cada chamador voltasse a escrever do seu
// jeito, o próximo caminho de delegação nasceria fora da vigia e o defeito
// voltaria pela porta dos fundos.
//
// Nada aqui conhece rede. Quem fala com o serviço externo é o cliente; quem
// decide é a função pura de estado. Este módulo só guarda e devolve.

import { Prisma } from '@prisma/client'
import { marcarEscalada } from './pergunta-sem-resposta.js'

/** Uma linha viva da vigia, com o que a decisão precisa saber. */
export interface LinhaDeSessao {
  id: string
  projectId: string
  issueNumber: number
  sessionName: string
  state: string
  answeredHash: string | null
  pullRequestNumber: number | null
  attempts: number
  nudges: number
  lastProgressAt: Date | null
  /**
   * Última vez que a vigia examinou esta sessão. É o que dá a cadência: sem
   * ele, cada tick reexaminaria toda sessão viva a cada minuto, gastando
   * chamada ao serviço externo (e, pior, potencialmente motor) sem que nada
   * tivesse mudado desde a última olhada.
   */
  stateCheckedAt: Date | null
  /**
   * O pedido de retrabalho que o QA emitiu e que NÃO chegou ao dev. Guardado
   * INTEIRO de propósito: reentregar um recado vazio não faz ninguém
   * retrabalhar, e um booleano só diria que existiu um recado.
   */
  reworkNoticePending: string | null
  /** Quantas vezes já tentamos reentregar esse pedido — o teto vive aqui. */
  reworkNoticeAttempts: number
  /**
   * BYOK (D34): a conta do dev assíncrono em que esta sessão NASCEU. É por ela
   * que a vigília sabe com qual chave falar sobre esta sessão — a conta do
   * projeto não serve, porque ela muda quando o cliente conecta, troca ou
   * desconecta a dele, e a sessão continua viva lá fora na conta antiga.
   * Nulo = conta da instância.
   */
  devAccountId?: string | null
  /**
   * Desde quando esta entrega está com a verificação automática pendente —
   * `null` enquanto nunca esteve, ou depois que `limparPendencia` apaga a
   * marca. É a partir dela que `decidirSobreVerificacao`
   * (vigia-da-verificacao.ts) conta o teto de espera antes de avisar o dono.
   */
  pendingSince: Date | null
  /**
   * SHA do commit que foi de fato mesclado — a Tarefa 12 usa para casar a
   * execução de CD com a entrega certa (nunca declarar publicado um commit
   * antigo).
   */
  mergeCommitSha: string | null
  /** Último estado de publicação lido no ambiente do cliente (Tarefa 13). */
  deployState: string | null
  /** Quando `deployState` foi lido pela última vez (Tarefa 13). */
  deployCheckedAt: Date | null
  /**
   * Fracassos SEGUIDOS de mescla contra o COMMIT ATUAL (Tarefa 10) — zera
   * quando o commit muda. É o que decide, no laço de descoberta de
   * `qa-rails-mission.ts`, se uma aprovação ainda sem mescla continua sendo
   * reprocessada ou já bateu o teto (`MAX_TENTATIVAS_DE_MERGE`) e volta a
   * ser pulada até o dev empurrar um commit novo.
   */
  mergeFailures: number
  /** Quando o último fracasso de mescla aconteceu (Tarefa 10). */
  mergeLastFailedAt: Date | null
  /**
   * Marca da tarefa de conserto já aberta para esta sessão
   * (`gitorch:conserto:<origem>:<commit>`, `conserto-de-publicacao.ts`).
   * `null` enquanto nenhuma foi aberta. É o dedup que impede a vigília de
   * abrir uma issue por tique no repositório do CLIENTE: uma publicação que
   * falha é reexaminada a cada varredura, para sempre, até virar outra coisa.
   */
  deployFixKey: string | null
  /**
   * Veredito da ÚLTIMA leitura do ambiente publicado (`testarAmbiente`).
   * `null` enquanto nunca foi lido. Só existe para exigir repetição antes de
   * abrir tarefa por ambiente inalcançável — uma leitura só não separa
   * serviço fora do ar de queda de rede momentânea.
   */
  envLastVerdict: string | null
  /**
   * Quando a linha foi de fato encerrada (`fecharSessao`) — `null` enquanto
   * viva. Crítico 2 (leva C, `pos-merge.ts`): `sessoesParaAcompanharPublicacao`
   * usa este campo para distinguir "veredito final registrado" de "linha
   * fechada de verdade" — as duas coisas normalmente acontecem juntas, mas
   * um restart entre `registrarEstadoDaPublicacao` e `fecharSessao` pode
   * deixar a primeira sem a segunda, e sem este campo a sessão órfã ficava
   * invisível para a vigília para sempre.
   */
  closedAt: Date | null
  /**
   * Quantas vezes ESTA issue já foi redelegada por entrega que não mesclou.
   * Carregado em `abrirSessao` a partir das linhas fechadas anteriores da
   * mesma issue. É o que `decidirSessaoTerminal` usa para decidir "tenta de
   * novo" vs. "entende por que antes da 3ª" (D51). Opcional como `devAccountId`:
   * o dado real (Prisma) sempre traz, os fakes de teste nem sempre.
   */
  requeueCount?: number
  /**
   * Quando a análise de "por que o Jules falhou nesta issue" rodou. `null` =
   * nunca. Também carregado adiante em `abrirSessao`, para a 3ª tentativa não
   * re-disparar a análise que acabou de acontecer.
   */
  analysisDoneAt?: Date | null
}

/**
 * Por que a linha saiu da vigia. `merged` é o único caminho feliz.
 *
 * Os quatro últimos são do ciclo TERMINAL (D51, sessao-terminal.ts): a sessão
 * fechou mas a issue VOLTA para a fila — a esteira nunca abandona de vez.
 *  - `dev-concluiu-sem-entrega` : o Jules deu COMPLETED sem abrir PR.
 *  - `dev-falhou`               : o Jules deu FAILED/CANCELLED.
 *  - `pr-descartado`            : o PR foi fechado sem mesclar.
 *  - `pr-rejeitado-sem-retomada`: PR aberto, reprovado por nós, e o Jules
 *                                 (terminal) não vai empurrar commit novo.
 *  - `pergunta-sem-resposta`    : o Jules ficou em AWAITING_USER_FEEDBACK, a
 *                                 pergunta já foi respondida e mesmo assim
 *                                 nada andou por 24h.
 */
export type MotivoDeFechamento =
  | 'merged'
  | 'abandoned'
  | 'failed_final'
  | 'dev-concluiu-sem-entrega'
  | 'dev-falhou'
  | 'pr-descartado'
  | 'pr-rejeitado-sem-retomada'
  | 'pergunta-sem-resposta'

/** Os motivos que devolvem a issue para a fila — ela será redelegada. */
export const MOTIVOS_QUE_REDELEGAM: ReadonlySet<MotivoDeFechamento> = new Set([
  'dev-concluiu-sem-entrega',
  'dev-falhou',
  'pr-descartado',
  'pr-rejeitado-sem-retomada',
  'pergunta-sem-resposta',
])

/**
 * O mínimo do client do Prisma que este módulo usa. Interface estreita em vez
 * do tipo gerado inteiro: é o que permite testar sem banco e deixa explícito
 * que aqui só se mexe em `devSession`.
 */
export interface PrismaDevSession {
  /**
   * Roda tudo dentro da mesma transação. Só `reservarVagaNaConta` usa — é o
   * que impede duas delegações de furarem o teto da conta ao mesmo tempo.
   */
  $transaction?: <T>(
    fn: (tx: PrismaDevSession) => Promise<T>,
    opcoes?: { isolationLevel?: string }
  ) => Promise<T>
  devSession: {
    count?: (args: unknown) => Promise<number>
    upsert: (args: unknown) => Promise<unknown>
    update: (args: unknown) => Promise<unknown>
    /** Só `registrarPendencia` usa — é o que permite gravar "primeiro avistamento" sem um read antes. */
    updateMany: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<LinhaDeSessao[]>
    /** Tarefa 17 (`aoMesclarUmaEntrega`, scheduler.ts): acha a linha viva pelo número do PR mesclado. */
    findFirst: (args: unknown) => Promise<LinhaDeSessao | null>
  }
  /**
   * L4-T1: só `registrarPr` usa, e só quando a issue tem `projectId`/
   * `issueNumber` — é o que liga o PR da entrega ao incidente de infra aberto
   * pela mesma issue. Opcional porque os demais chamadores de
   * `PrismaDevSession` (github-webhook.ts, testes mais antigos) nunca tocam
   * nisto e não precisam mockar este model.
   */
  infraIncident?: {
    updateMany: (args: unknown) => Promise<unknown>
  }
}

/** Por que `abrirSessao` não abriu a linha. */
export type MotivoDeRecusa = 'ja-existe-sessao-viva'

/** Resultado tipado de `abrirSessao` — nunca uma exceção crua do Prisma. */
export type ResultadoDeAbrirSessao = { ok: true } | { ok: false; motivo: MotivoDeRecusa }

/**
 * Registra que uma issue passou a ter sessão de trabalho.
 *
 * `upsert` e não `create` porque re-delegar a MESMA sessão (mesmo
 * `sessionName`) não pode explodir contra o índice único de `sessionName`, e
 * porque a contagem de tentativas é o que alimenta o teto que impede a
 * esteira de girar para sempre numa tarefa que não sai.
 *
 * Isso não cobre a OUTRA colisão possível: duas delegações da MESMA issue
 * geram `sessionName` DIFERENTES, então as duas caem no ramo `create` do
 * upsert — e a segunda esbarra no índice único PARCIAL
 * `dev_sessions_open_per_issue` (uma issue, uma linha viva por vez), que é
 * uma constraint diferente da usada no `where` do upsert, então o
 * `ON CONFLICT` dele não a absorve. Aqui essa violação (Prisma `P2002`) é
 * capturada e devolvida como resultado tipado — nunca vaza como exceção
 * crua. Isto é garantia do MÓDULO, não do chamador: antes, só não quebrava
 * porque quem chamava embrulhava a chamada em try/catch por conta própria.
 * Qualquer OUTRO erro (fora `P2002`) continua sendo lançado.
 */
export async function abrirSessao(deps: {
  prisma: PrismaDevSession
  projectId: string
  issueNumber: number
  sessionName: string
  agora: Date
  /**
   * BYOK (D34): a conta do dev assíncrono que está abrindo esta sessão. Fica
   * GRAVADA na linha porque a conta do projeto muda depois (o cliente conecta,
   * troca ou desconecta a dele) e a sessão continua viva lá fora na conta
   * antiga: consultar, avisar ou arquivar com a chave da conta nova volta 404
   * e a vaga fica presa na conta que a pessoa paga. Ausente = conta da
   * instância.
   */
  devAccountId?: string | null
}): Promise<ResultadoDeAbrirSessao> {
  // Carrega o histórico da issue para a linha nova (ciclo terminal, D51): quantas
  // vezes esta issue já foi redelegada por entrega que não mesclou, e se a
  // análise de "por que o Jules falhou" já rodou. É por esses números que
  // `decidirSessaoTerminal` decide "redelegar de novo" vs. "entender antes da
  // 3ª". Best-effort: falha aqui não pode barrar a delegação — cai no zero.
  let requeueCount = 0
  let analysisDoneAt: Date | null = null
  try {
    const anteriores = (await deps.prisma.devSession.findMany({
      where: {
        projectId: deps.projectId,
        issueNumber: deps.issueNumber,
        closedReason: { in: [...MOTIVOS_QUE_REDELEGAM] },
      },
      select: { analysisDoneAt: true },
      orderBy: { closedAt: 'desc' },
    })) as unknown as Array<{ analysisDoneAt: Date | null }>
    requeueCount = anteriores.length
    analysisDoneAt = anteriores[0]?.analysisDoneAt ?? null
  } catch {
    // sem histórico utilizável — a linha nasce do zero
  }

  try {
    await deps.prisma.devSession.upsert({
      where: { sessionName: deps.sessionName },
      create: {
        projectId: deps.projectId,
        issueNumber: deps.issueNumber,
        sessionName: deps.sessionName,
        state: 'QUEUED',
        stateCheckedAt: deps.agora,
        devAccountId: deps.devAccountId ?? null,
        requeueCount,
        analysisDoneAt,
        // Nasce com progresso marcado: sem isto a vigia leria "sem avanço
        // desde sempre" e trataria como parada uma sessão que acabou de
        // começar.
        lastProgressAt: deps.agora,
      },
      update: {
        attempts: { increment: 1 },
        closedAt: null,
        closedReason: null,
        stateCheckedAt: deps.agora,
        // A retomada pode acontecer depois de o cliente ter trocado de conta:
        // quem reabre a linha é quem passa a responder por ela.
        devAccountId: deps.devAccountId ?? null,
      },
    })
    return { ok: true }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, motivo: 'ja-existe-sessao-viva' }
    }
    throw err
  }
}

/**
 * As sessões que a vigia deve olhar neste ciclo.
 *
 * Só linha aberta. É isto que torna a vigia escopada em vez de global: sem
 * sessão viva, o passo não faz uma única chamada ao serviço externo.
 *
 * `projectId` é OBRIGATÓRIO — fail-closed. Produto multi-inquilino: sem o
 * filtro por projeto sempre entrando na consulta, um chamador que esquecesse
 * de passá-lo varreria a vigia de TODOS os projetos, não só o dele. Não há
 * caso de uso legítimo hoje para essa varredura entre projetos.
 */
export async function sessoesVivas(deps: {
  prisma: PrismaDevSession
  projectId: string
}): Promise<LinhaDeSessao[]> {
  return deps.prisma.devSession.findMany({
    where: {
      closedAt: null,
      projectId: deps.projectId,
    },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Os NOMES de todas as sessões vivas desta instalação, de todos os projetos.
 *
 * Sim, isto contraria o fail-closed de `sessoesVivas` logo acima — de
 * propósito, e o comentário de lá dizia que não havia caso de uso legítimo
 * para uma varredura entre projetos. Agora há exatamente um, e é o oposto de
 * agir sobre os projetos alheios: a reconciliação de vagas precisa saber tudo
 * o que está vivo AQUI justamente para não arquivar lá fora o trabalho de
 * ninguém. Cruzar a lista completa do fornecedor contra as sessões vivas de um
 * projeto só marcaria como órfão o trabalho em andamento de todos os outros.
 *
 * Devolve só os nomes, nunca as linhas: quem varre não tem o que fazer com
 * dados de projeto alheio, e o tipo estreito garante que não vai ter.
 */
export async function nomesDeSessoesVivasDaInstancia(deps: {
  prisma: PrismaDevSession
  /**
   * BYOK (D34): restringe à conta indicada (`null` = conta da instância).
   * Omitir devolve TODAS as contas, que é o certo para quem só quer saber o
   * que está vivo aqui dentro — mas ERRADO para cruzar contra a lista de um
   * fornecedor, porque cada conta enxerga só as próprias sessões: sem o
   * filtro, a reconciliação de uma conta acharia órfã a sessão viva de outra
   * e arquivaria trabalho em andamento alheio.
   */
  devAccountId?: string | null
}): Promise<string[]> {
  const linhas = await deps.prisma.devSession.findMany({
    where:
      deps.devAccountId === undefined
        ? { closedAt: null }
        : { closedAt: null, devAccountId: deps.devAccountId },
    select: { sessionName: true },
  })
  return linhas.map((l) => l.sessionName)
}

/**
 * As linhas vivas da INSTÂNCIA com o que a decisão de abandono precisa.
 *
 * Da instância inteira, e não de um projeto: a vaga que trava a esteira é
 * contada por instância, e uma varredura por projeto deixaria zumbi de outro
 * projeto segurando a mesma fila.
 */
export async function linhasVivasParaJulgarAbandono(deps: { prisma: PrismaDevSession }): Promise<
  Array<{
    sessionName: string
    issueNumber: number
    state: string
    lastProgressAt: Date | null
    createdAt: Date | null
    closedAt: Date | null
  }>
> {
  return (await deps.prisma.devSession.findMany({
    where: { closedAt: null },
    select: {
      sessionName: true,
      issueNumber: true,
      state: true,
      lastProgressAt: true,
      createdAt: true,
      closedAt: true,
    },
  })) as unknown as Array<{
    sessionName: string
    issueNumber: number
    state: string
    lastProgressAt: Date | null
    createdAt: Date | null
    closedAt: Date | null
  }>
}

/** O que a decisão do ciclo TERMINAL precisa de cada linha viva (sessao-terminal.ts). */
export interface LinhaParaCicloTerminal {
  sessionName: string
  projectId: string
  issueNumber: number
  state: string
  pullRequestNumber: number | null
  lastProgressAt: Date | null
  requeueCount: number
  analysisDoneAt: Date | null
  devAccountId: string | null
}

/**
 * As linhas vivas da INSTÂNCIA com o que a decisão terminal precisa.
 *
 * Da instância inteira pelo MESMO motivo de `linhasVivasParaJulgarAbandono`: a
 * vaga que trava a esteira é contada por instância. São funções irmãs — esta
 * trata COMPLETED/FAILED (o Jules terminou), aquela trata a sessão que ficou
 * parada sem terminar.
 */
export async function linhasVivasParaCicloTerminal(deps: {
  prisma: PrismaDevSession
}): Promise<LinhaParaCicloTerminal[]> {
  return (await deps.prisma.devSession.findMany({
    where: { closedAt: null },
    select: {
      sessionName: true,
      projectId: true,
      issueNumber: true,
      state: true,
      pullRequestNumber: true,
      lastProgressAt: true,
      requeueCount: true,
      analysisDoneAt: true,
      devAccountId: true,
    },
  })) as unknown as LinhaParaCicloTerminal[]
}

/**
 * Marca que a análise de "por que o Jules falhou nesta issue" rodou para esta
 * sessão. É o que impede a 3ª tentativa de re-disparar a análise, e o que
 * `abrirSessao` carrega para a linha seguinte.
 */
export async function marcarAnaliseFeita(deps: {
  prisma: PrismaDevSession
  sessionName: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { analysisDoneAt: deps.agora },
  })
}

/**
 * Marca a análise como feita para TODAS as linhas (fechadas) de uma issue — é
 * o que `abrirSessao` vai carregar para a próxima sessão. Chamado pela missão
 * de análise (analisar-falhas-pendentes.ts) depois de entender o porquê.
 */
export async function marcarAnaliseFeitaDaIssue(deps: {
  prisma: PrismaDevSession
  projectId: string
  issueNumber: number
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.updateMany({
    where: { projectId: deps.projectId, issueNumber: deps.issueNumber },
    data: { analysisDoneAt: deps.agora },
  })
}

/**
 * As issues que já falharam 2× (`requeue_count >= 2`) e cuja análise ainda NÃO
 * rodou (`analysis_done_at IS NULL`). Enquanto uma issue está nesta lista, o SM
 * NÃO a redelega — espera a análise (D51). Escopado por projeto.
 */
export async function issuesComAnalisePendente(deps: {
  prisma: PrismaDevSession
  projectId: string
}): Promise<number[]> {
  const linhas = (await deps.prisma.devSession.findMany({
    where: {
      projectId: deps.projectId,
      requeueCount: { gte: 2 },
      analysisDoneAt: null,
    },
    select: { issueNumber: true },
  })) as unknown as Array<{ issueNumber: number }>
  return [...new Set(linhas.map((l) => l.issueNumber))]
}

/**
 * Anota o estado lido e quando foi lido.
 *
 * `progrediu` move a marca de progresso, e só ela. A API do serviço não tem
 * estado para "trabalhando mas empacado", e não oferece retomada — a única
 * forma de detectar sessão parada é comparar o relógio contra a última vez que
 * algo de fato andou. Mexer nessa marca a cada leitura apagaria justamente o
 * sinal que se quer medir.
 */
export async function registrarEstado(deps: {
  prisma: PrismaDevSession
  sessionName: string
  estado: string
  agora: Date
  progrediu?: boolean
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: {
      state: deps.estado,
      stateCheckedAt: deps.agora,
      ...(deps.progrediu ? { lastProgressAt: deps.agora } : {}),
    },
  })
}

/**
 * Marca que esta pergunta já foi respondida.
 *
 * Guardar o hash é o que impede responder duas vezes: a sessão pode levar mais
 * de um ciclo de vigia para sair de "esperando resposta" depois de receber a
 * nossa, e sem esta marca o ciclo seguinte mandaria a mesma coisa de novo,
 * gastando motor e confundindo quem está do outro lado.
 */
export async function registrarResposta(deps: {
  prisma: PrismaDevSession
  sessionName: string
  hashDaPergunta: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: {
      answeredHash: deps.hashDaPergunta,
      nudges: { increment: 1 },
      stateCheckedAt: deps.agora,
    },
  })
}

/**
 * Marca que esta pergunta ESCALOU DE VERDADE ao dono (L4-T3).
 *
 * Nunca `registrarResposta`: escalar não é responder — ninguém respondeu
 * ainda, é o dono quem vai decidir (e a decisão dele RETOMA a sessão, ver
 * `services/retomar-sessao-com-resposta.ts`). Por isso a marca própria
 * `escalada:0:<hash>` (`marcarEscalada`), que `decidirSobreAPergunta` lê como
 * "não tenta de novo" e `session-watch.ts` lê como "NÃO conta como
 * respondida" (a sessão fica aguardando o dono, sem fechar em 24h — L4-T4
 * decide o que fazer quando vencer).
 *
 * DE PROPÓSITO não incrementa `nudges`, pelo mesmo raciocínio de
 * `registrarInvestigacao`: `nudges` mede "quantas vezes pedimos para a
 * sessão CONTINUAR" — é o contador que `jules-session-loop.ts` usa para
 * decidir abandono (`MAX_NUDGES`). Escalar é o oposto de insistir: é parar e
 * esperar uma decisão de negócio. Contar como nudge aproximaria do abandono
 * uma sessão que está parada por um motivo que não tem nada a ver com "a
 * sessão não andou apesar de pedirmos".
 */
export async function registrarEscalada(deps: {
  prisma: PrismaDevSession
  sessionName: string
  hashDaPergunta: string
  agora: Date
}): Promise<void> {
  // C4 (fix-up L4-T3): sem esta guarda, um `hashDaPergunta` vazio/nulo (bug
  // de quem chama) gravaria `escalada:0:` ou `escalada:0:null` — uma marca
  // sem pergunta real por trás, que `retomar-sessao-com-resposta.ts` (busca
  // pelo hash exato) e a reconciliação nunca conseguem casar de volta com
  // nenhuma `agent_question`. Recusa alto e cedo, nunca grava lixo.
  if (!deps.hashDaPergunta || !deps.hashDaPergunta.trim()) {
    throw new Error(
      `registrarEscalada: hashDaPergunta vazio/nulo para ${deps.sessionName} — recusa gravar ` +
        'marca de escalada sem pergunta real'
    )
  }
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: {
      answeredHash: marcarEscalada(deps.hashDaPergunta),
      stateCheckedAt: deps.agora,
    },
  })
}

/**
 * Guarda o PR que a sessão entregou.
 *
 * Só o NÚMERO. A URL vem do serviço externo, e transformá-la em destino de
 * chamada nossa é a mesma classe de falha que já custou caro aqui. Com o
 * número, toda busca é pela rota do próprio repositório.
 */
export async function registrarPr(deps: {
  prisma: PrismaDevSession
  sessionName: string
  numeroDoPr: number
  agora: Date
  /**
   * L4-T1: quando a issue trabalhada tem um incidente de infra aberto
   * (`infra_incidents`), passar `projectId`/`issueNumber` liga o PR a ele —
   * sem isto, `situacaoDoIncidente` (fechar-incidente-resolvido.ts) nunca via
   * o PR e o incidente nunca fechava sozinho mesmo com o workflow são de
   * novo. Os dois precisam vir juntos; faltando um, não toca `infra_incidents`.
   */
  projectId?: string
  issueNumber?: number
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { pullRequestNumber: deps.numeroDoPr, stateCheckedAt: deps.agora },
  })
  if (deps.projectId !== undefined && deps.issueNumber !== undefined) {
    await deps.prisma.infraIncident?.updateMany({
      where: { projectId: deps.projectId, issueNumber: deps.issueNumber, prNumber: null },
      data: { prNumber: deps.numeroDoPr },
    })
  }
}

/**
 * Marca que a vigia já avisou o dono sobre ESTE estado de falha desta sessão.
 *
 * Reaproveita o campo `answeredHash` no mesmo espírito de `registrarResposta`:
 * comparar o hash guardado com o hash calculado é o que evita repetir a ação.
 * `investigar` só dispara para estados (COMPLETED sem PR, FAILED, CANCELLED)
 * que nunca coincidem com AWAITING_USER_FEEDBACK — o único outro caminho que
 * lê `answeredHash` — então reaproveitar o campo não colide com uma pergunta
 * real do dev.
 *
 * De propósito NÃO incrementa `nudges`: nudges é "quantas vezes pedimos para
 * a sessão continuar" (o teto que decide abandono); investigar é outra
 * categoria de evento e não deve empurrar a sessão para o abandono mais
 * rápido. Por isso não reaproveita `registrarResposta` (que incrementa
 * nudges como efeito colateral) e ganha uma função própria.
 */
export async function registrarInvestigacao(deps: {
  prisma: PrismaDevSession
  sessionName: string
  hash: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { answeredHash: deps.hash },
  })
}

/**
 * Tira a linha da vigia.
 *
 * O motivo fica registrado porque a diferença entre "mesclou" e "desistimos"
 * é a única forma de enxergar, depois, se a esteira está entregando ou só
 * girando.
 */
export async function fecharSessao(deps: {
  prisma: PrismaDevSession
  sessionName: string
  motivo: MotivoDeFechamento
  agora: Date
  /**
   * Encerra a conversa no fornecedor, liberando a vaga. Opcional só para os
   * testes que não se importam com isso — em produção é sempre injetado.
   */
  arquivarNoFornecedor?: (sessionName: string) => Promise<boolean>
  onWarn?: (mensagem: string) => void
}): Promise<void> {
  // A ORDEM importa: arquivar ANTES de fechar a linha. Fechar primeiro e
  // falhar no arquivamento deixaria a vaga presa sem NINGUÉM sabendo que ela
  // existiu — a linha some daqui e a conversa continua viva lá fora.
  //
  // Foi essa falta que quase matou a delegação: o produto criava sessão e
  // nunca encerrava, e em 21/08/2026 as dezoito vagas do fornecedor estavam
  // ocupadas, com onze recusas de criação por `FAILED_PRECONDITION`.
  if (deps.arquivarNoFornecedor) {
    const arquivou = await deps.arquivarNoFornecedor(deps.sessionName).catch(() => false)
    if (!arquivou) {
      // BARULHENTO de propósito, e com o nome da sessão no texto: é por ele
      // que a varredura de reconciliação (e uma pessoa, se precisar) acha a
      // vaga presa. Não segura o fechamento da linha — a entrega de fato
      // terminou, e represar o registro só faria o quadro mentir ao contrário.
      const avisar = deps.onWarn ?? console.warn
      avisar(
        `[jules] a sessão ${deps.sessionName} NÃO foi arquivada no fornecedor — a vaga ` +
          'segue presa até a varredura de reconciliação passar'
      )
    }
  }

  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { closedAt: deps.agora, closedReason: deps.motivo },
  })
}

/**
 * Guarda o pedido de retrabalho que não chegou ao dev.
 *
 * Existe por um caso medido: 21/08/2026, o QA reprovou o PR #157 e a entrega
 * da reprovação na sessão falhou com um 429 passageiro. O produto avisou no
 * log e parou — e o encalhe virou permanente, porque o parecer JÁ estava
 * postado e o laço de descoberta passa a pular a entrega como "já julgada".
 * Reenviado à mão minutos depois, o MESMO recado foi aceito na hora. Uma
 * repetição teria resolvido; o que faltava era lembrar dele.
 */
export async function registrarAvisoDeRetrabalhoPendente(deps: {
  prisma: PrismaDevSession
  sessionName: string
  texto: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    // O contador ZERA junto: recado NOVO merece o teto cheio. Sem isto ele
    // herdaria as tentativas do recado anterior e poderia nascer já esgotado.
    data: { reworkNoticePending: deps.texto, reworkNoticeAttempts: 0 },
  })
}

/** O recado chegou: apaga a pendência e zera o contador de tentativas. */
export async function limparAvisoDeRetrabalho(deps: {
  prisma: PrismaDevSession
  sessionName: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { reworkNoticePending: null, reworkNoticeAttempts: 0 },
  })
}

/**
 * Conta mais uma tentativa fracassada de reentrega.
 *
 * `increment` e não leitura-e-escrita: duas passagens da vigília no mesmo
 * instante contariam a mesma tentativa duas vezes de um jeito, e nenhuma do
 * outro. O banco resolve isso melhor que nós.
 */
export async function contarTentativaDeAviso(deps: {
  prisma: PrismaDevSession
  sessionName: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { reworkNoticeAttempts: { increment: 1 } },
  })
}

/**
 * Marca que esta entrega está com a verificação automática pendente.
 *
 * Só grava se `pending_since` ainda for nulo — a marca é do PRIMEIRO
 * avistamento, e é dela que o teto de espera (`TETO_DE_ESPERA_MS`,
 * vigia-da-verificacao.ts) conta o tempo até avisar o dono. `updateMany` com
 * o próprio campo nulo no `where` faz essa checagem de forma atômica, sem um
 * read antes: chamar de novo a cada ciclo, enquanto a pendência continua, não
 * regrava nada — sem isso o relógio reiniciaria a cada chamada e o aviso de
 * demora nunca dispararia.
 */
export async function registrarPendencia(deps: {
  prisma: PrismaDevSession
  sessionName: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.updateMany({
    where: { sessionName: deps.sessionName, pendingSince: null },
    data: { pendingSince: deps.agora },
  })
}

/**
 * Apaga a marca de pendência.
 *
 * Chamada de dentro do laço do juiz, no exato instante em que a decisão da
 * verificação (`decidirSobreVerificacao`) devolve `julgar` — nunca por um
 * gatilho externo, nunca por uma varredura própria desta função.
 */
export async function limparPendencia(deps: {
  prisma: PrismaDevSession
  sessionName: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { pendingSince: null },
  })
}

/**
 * Marca que o dono já foi avisado da verificação parada, para ESTE commit.
 *
 * Achado 2 da revisão da Tarefa 7: `avisar-demora` dispara a cada tick do
 * scheduler (~1min) enquanto a verificação continuar parada — sem uma marca
 * de "já avisei isto", o dono seria avisado a cada minuto, para sempre.
 *
 * Reaproveita `answeredHash` — o MESMO campo e a mesma disciplina que
 * `registrarInvestigacao` já usa para não repetir aviso a cada ciclo
 * (session-watch.ts: "SPAM apaga sinal tanto quanto silêncio"), aplicada a
 * um sinal diferente: aqui o hash amarra o aviso ao COMMIT que está parado
 * (`hashDaMensagem` de `avisar-demora:${sha}`, ver qa-rails-mission.ts). Se
 * um push novo mudar o head enquanto a verificação ainda está pendente, o
 * hash muda e o dono é avisado de novo — a situação mudou de verdade, não é
 * o mesmo silêncio de sempre.
 *
 * Não colide com o uso de `registrarInvestigacao`: os dois só escrevem
 * `answeredHash` em janelas da sessão que não coincidem (`julgar`, o ramo do
 * QA que leva a esta chamada, nunca é a mesma decisão que `investigar`, o
 * ramo do SM — ver `decidirRespostaDaSessao` em jules-session-loop.ts).
 */
export async function registrarAvisoDeDemora(deps: {
  prisma: PrismaDevSession
  sessionName: string
  hash: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { answeredHash: deps.hash },
  })
}

/**
 * Registra um fracasso de mescla contra o commit atual (Tarefa 10).
 *
 * `contador` já chega PRONTO de quem chama (`qa-rails-mission.ts`): é lá que
 * mora a decisão de somar sobre o valor anterior (mesma tentativa, mesmo
 * commit) ou recomeçar do 1 (o commit mudou desde o último fracasso) — esta
 * função só persiste o número final, mesmo espírito de `registrarPr` (o dado
 * já resolvido chega, o depósito não reinterpreta nada).
 *
 * Não reaproveita `answeredHash`: aquele campo já serve a dois controles
 * diferentes (pergunta respondida e aviso de verificação parada) e um
 * terceiro uso ali arriscaria um clobber entre guardas que hoje não colidem
 * por sorte de janela temporal. `mergeFailures`/`mergeLastFailedAt` são
 * colunas PRÓPRIAS — criadas pela Tarefa 7 exatamente para isto — então o
 * teto de mescla tem seu próprio estado, sem disputar campo com ninguém.
 */
export async function registrarFracassoDeMerge(deps: {
  prisma: PrismaDevSession
  sessionName: string
  contador: number
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { mergeFailures: deps.contador, mergeLastFailedAt: deps.agora },
  })
}

/**
 * Grava o commit que foi de fato mesclado (Tarefa 17).
 *
 * NÃO fecha a linha. Antes desta tarefa, o merge encerrava a sessão na hora
 * (`fecharSessao` com `'merged'`) — o produto declarava a entrega concluída
 * sem nunca saber se aquele código chegou ao ar. Agora o merge só grava a
 * chave que a vigília da publicação (`varrerPublicacoes`, scheduler.ts) usa
 * para achar a execução certa (Tarefa 13, `acompanharPublicacao`); quem
 * fecha é aquela vigília, quando há veredito.
 *
 * `numeroDoPr` também é gravado aqui (Leva B — "o quadro do cliente não pode
 * dizer entregue antes da hora"): `varrerPublicacoes` precisa do número do
 * PR para comentar/fechar a tarefa quando a publicação confirma, e o recuo
 * pela issue de origem (Importante 4 da revisão final da branch) acha a
 * linha SEM nunca ter passado por `registrarPr` — sem gravar aqui, de novo,
 * a partir do próprio evento de merge (a fonte mais autoritativa que existe:
 * é o número que o GitHub acabou de aceitar), a linha ficaria com
 * `pullRequestNumber` nulo justamente na janela em que esse recuo era
 * necessário.
 */
export async function registrarMescla(deps: {
  prisma: PrismaDevSession
  sessionName: string
  mergeCommitSha: string
  numeroDoPr: number
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: {
      mergeCommitSha: deps.mergeCommitSha,
      pullRequestNumber: deps.numeroDoPr,
      stateCheckedAt: deps.agora,
    },
  })
}

/**
 * Grava o veredito mais recente sobre a publicação do commit mesclado, e
 * quando foi checado.
 *
 * `deployCheckedAt` é o que dá a cadência de `sessoesParaAcompanharPublicacao`
 * (pos-merge.ts): sem ele, cada tique do relógio reexaminaria a publicação
 * de toda sessão mesclada, gastando a quota do GitHub do cliente à toa.
 */
export async function registrarEstadoDaPublicacao(deps: {
  prisma: PrismaDevSession
  sessionName: string
  estado: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { deployState: deps.estado, deployCheckedAt: deps.agora },
  })
}

/**
 * Marca só a CADÊNCIA da vigília da publicação, sem afirmar nenhum veredito
 * — usada quando a varredura desta sessão FALHA antes de conseguir uma
 * leitura real (sem credencial do GitHub, ou uma exceção no meio do
 * caminho).
 *
 * Importante 3 da revisão final da branch: antes desta função,
 * `deployCheckedAt` só era gravado no caminho de SUCESSO
 * (`registrarEstadoDaPublicacao`) — todo caminho de erro pulava o carimbo, e
 * `sessoesParaAcompanharPublicacao` (pos-merge.ts) trata carimbo nulo ou
 * antigo como "vencido agora". Uma falha PERSISTENTE (projeto suspenso,
 * instalação revogada, 403 do GitHub) virava, então, reexame a cada
 * `GITORCH_SCHEDULER_TICK_MS` (~60s) em vez de `CADENCIA_DE_PUBLICACAO_MS`
 * (dez minutos) — e sob limite de taxa do GitHub, o próprio laço alimentava
 * o limite que o derrubou.
 *
 * `deployState` fica INTOCADO de propósito: uma falha de leitura não é um
 * veredito, e sobrescrever o último estado conhecido com "não sei" quebraria
 * o dedupe de aviso por transição de estado (`estadoAnterior`,
 * scheduler.ts) e a lista de estados finais (`ESTADOS_FINAIS`, pos-merge.ts).
 */
export async function registrarCadenciaDePublicacao(deps: {
  prisma: PrismaDevSession
  sessionName: string
  agora: Date
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { deployCheckedAt: deps.agora },
  })
}

/**
 * Grava a marca da tarefa de conserto recém-aberta para esta sessão.
 *
 * Escrita DEPOIS de a issue existir de verdade no repositório do cliente, e
 * não antes: gravar primeiro e falhar na escrita da issue deixaria a sessão
 * marcada como "já consertada" sem nenhuma tarefa existir — silêncio, que é
 * a falha exata que este mecanismo veio acabar. A ordem inversa deixa uma
 * janela estreita (issue criada, marca não gravada) em que a varredura
 * seguinte abriria uma segunda issue; por isso o corpo da issue também
 * carrega a mesma chave como marcador, e a falha desta gravação é registrada
 * como erro, nunca engolida.
 */
export async function registrarConsertoDePublicacao(deps: {
  prisma: PrismaDevSession
  sessionName: string
  chave: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { deployFixKey: deps.chave },
  })
}

/**
 * Grava o veredito da leitura mais recente do ambiente publicado.
 *
 * Não carimba cadência nem toca em `deployState`: o estado da PUBLICAÇÃO e o
 * do AMBIENTE são coisas diferentes (a publicação pode estar confirmada e o
 * site fora do ar — foi assim que o buraco apareceu), e misturá-los quebraria
 * tanto o dedupe de aviso por transição quanto a lista de estados finais.
 */
export async function registrarVereditoDeAmbiente(deps: {
  prisma: PrismaDevSession
  sessionName: string
  veredito: string
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { envLastVerdict: deps.veredito },
  })
}

/** Por que a vaga não foi reservada. */
export type MotivoDeRecusaDaVaga = 'sem-vaga-na-conta' | 'ja-existe-sessao-viva'

export type ResultadoDaReserva = { ok: true } | { ok: false; motivo: MotivoDeRecusaDaVaga }

/**
 * Reserva uma vaga da CONTA e abre a linha, no MESMO comando.
 *
 * O produto contava as vagas e criava a sessão em dois passos. Entre um e
 * outro cabe outra delegação: com um processo só isso já é uma corrida fraca
 * (duas delegações do mesmo tique, projetos diferentes, correndo em paralelo);
 * com mais de uma instância do control-plane vira garantido. O próprio
 * scheduler já documenta essa classe de defeito num comentário sobre outro
 * mecanismo: "se um dia existirem N processos... CADA processo tem o seu
 * próprio Map".
 *
 * Não adianta mover o mutex para o banco — o que resolve é contar e criar
 * dentro da mesma transação, com isolamento que impede duas leituras
 * concorrentes de verem o mesmo total e ambas acharem que cabe.
 *
 * `serializable` é o nível certo aqui, e não um exagero: o problema é
 * exatamente uma leitura que deixa de valer por causa de uma escrita que
 * aconteceu depois dela. O custo é uma transação que pode ser recusada e
 * precisa ser tentada de novo — e recusar é o comportamento desejado, porque
 * significa que o teto foi respeitado.
 */
export async function reservarVagaNaConta(deps: {
  prisma: PrismaDevSession
  /**
   * BYOK (D34): a conta cujo teto está sendo conferido. A contagem é pela
   * CONTA QUE ABRIU cada sessão, e não pelos projetos que hoje dividem a
   * conta: um projeto que acabou de conectar a conta própria carrega consigo
   * as sessões que abriu na conta do dono, e contá-las faria o teto novo do
   * cliente nascer consumido por trabalho que nunca tocou a conta dele — e,
   * na desconexão, faria essas sessões roubarem vaga de todo mundo que divide
   * a conta da instância. Nulo = conta da instância.
   */
  devAccountId?: string | null
  projectId: string
  issueNumber: number
  sessionName: string
  tetoConcorrentes: number
  agora: Date
}): Promise<ResultadoDaReserva> {
  const conta = deps.devAccountId ?? null
  const executar = async (tx: PrismaDevSession): Promise<ResultadoDaReserva> => {
    // Sem `count` disponível não há como conferir o teto. Abrir sem conferir
    // seria pior que recusar: o produto voltaria a pedir mais do que a conta
    // tem, que é o defeito que isto existe para matar.
    if (!tx.devSession.count) {
      return { ok: false, motivo: 'sem-vaga-na-conta' }
    }
    const vivas = await tx.devSession.count({
      where: { devAccountId: conta, closedAt: null },
    })
    if (vivas >= deps.tetoConcorrentes) {
      return { ok: false, motivo: 'sem-vaga-na-conta' }
    }
    return abrirSessao({
      prisma: tx,
      projectId: deps.projectId,
      issueNumber: deps.issueNumber,
      sessionName: deps.sessionName,
      agora: deps.agora,
      devAccountId: conta,
    })
  }

  // Sem suporte a transação (um fake de teste, por exemplo), roda direto: o
  // comportamento é o de antes, e é melhor que não funcionar.
  if (!deps.prisma.$transaction) return executar(deps.prisma)

  return deps.prisma.$transaction(executar, { isolationLevel: 'Serializable' })
}
