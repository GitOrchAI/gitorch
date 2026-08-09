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
}

/** Por que a linha saiu da vigia. `merged` é o único caminho feliz. */
export type MotivoDeFechamento = 'merged' | 'abandoned' | 'failed_final'

/**
 * O mínimo do client do Prisma que este módulo usa. Interface estreita em vez
 * do tipo gerado inteiro: é o que permite testar sem banco e deixa explícito
 * que aqui só se mexe em `devSession`.
 */
export interface PrismaDevSession {
  devSession: {
    upsert: (args: unknown) => Promise<unknown>
    update: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<LinhaDeSessao[]>
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
}): Promise<ResultadoDeAbrirSessao> {
  try {
    await deps.prisma.devSession.upsert({
      where: { sessionName: deps.sessionName },
      create: {
        projectId: deps.projectId,
        issueNumber: deps.issueNumber,
        sessionName: deps.sessionName,
        state: 'QUEUED',
        stateCheckedAt: deps.agora,
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
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { pullRequestNumber: deps.numeroDoPr, stateCheckedAt: deps.agora },
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
}): Promise<void> {
  await deps.prisma.devSession.update({
    where: { sessionName: deps.sessionName },
    data: { closedAt: deps.agora, closedReason: deps.motivo },
  })
}
