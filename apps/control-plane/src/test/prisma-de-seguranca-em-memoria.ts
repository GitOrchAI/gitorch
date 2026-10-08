// O pedaço do Prisma que a sondagem e a aplicação das melhorias de segurança
// usam (`repoItem`, `event`, `agentQuestion`), em memória, para os testes de
// unidade. O teste de integração usa o Postgres de verdade.
//
// Nada daqui é código de produção: fica em `src/test/`.

interface Ficha {
  projectId: string
  tipo: string
  numero: number
  estado: unknown
  atualizadoEm: Date
}

interface Evento {
  projectId: string
  type: string
  payload: { chave?: string; texto?: string } & Record<string, unknown>
}

interface Pergunta {
  id: string
  projectId: string
  userId: string
  text: string
  options: unknown
  dedupKey: string | null
  status: string
  answer: string | null
}

export function criarPrismaDeSegurancaEmMemoria(relogio: () => Date = () => new Date()) {
  const fichas = new Map<string, Ficha>()
  const eventos: Evento[] = []
  const perguntas: Pergunta[] = []
  const chave = (p: string, t: string, n: number) => `${p}|${t}|${n}`

  const prisma = {
    repoItem: {
      findUnique: async (args: {
        where: { projectId_tipo_numero: { projectId: string; tipo: string; numero: number } }
      }) => {
        const k = args.where.projectId_tipo_numero
        return fichas.get(chave(k.projectId, k.tipo, k.numero)) ?? null
      },
      findMany: async (args: {
        where: {
          projectId?: string | { in: string[] }
          tipo?: string | { in: string[] }
          numero?: number
        }
      }) => {
        const ids = args.where.projectId
        const tipos = args.where.tipo
        return [...fichas.values()].filter((f) => {
          if (typeof ids === 'string' && f.projectId !== ids) return false
          if (ids && typeof ids === 'object' && !ids.in.includes(f.projectId)) return false
          if (typeof tipos === 'string' && f.tipo !== tipos) return false
          if (tipos && typeof tipos === 'object' && !tipos.in.includes(f.tipo)) return false
          if (args.where.numero !== undefined && f.numero !== args.where.numero) return false
          return true
        })
      },
      upsert: async (args: {
        where: { projectId_tipo_numero: { projectId: string; tipo: string; numero: number } }
        create: { projectId: string; tipo: string; numero: number; estado: unknown }
        update: { estado?: unknown }
      }) => {
        const k = args.where.projectId_tipo_numero
        const existente = fichas.get(chave(k.projectId, k.tipo, k.numero))
        const nova: Ficha = existente
          ? {
              ...existente,
              ...(args.update.estado !== undefined ? { estado: args.update.estado } : {}),
              atualizadoEm: relogio(),
            }
          : {
              projectId: args.create.projectId,
              tipo: args.create.tipo,
              numero: args.create.numero,
              estado: args.create.estado,
              atualizadoEm: relogio(),
            }
        fichas.set(chave(k.projectId, k.tipo, k.numero), nova)
        return nova
      },
    },
    event: {
      findFirst: async (args: {
        where: {
          projectId: string
          type: string
          payload: { path: string[]; equals: string }
        }
      }) =>
        eventos.find(
          (e) =>
            e.projectId === args.where.projectId &&
            e.type === args.where.type &&
            e.payload.chave === args.where.payload.equals
        ) ?? null,
      create: async (args: { data: Evento }) => {
        eventos.push(args.data)
        return args.data
      },
    },
    agentQuestion: {
      findFirst: async (args: {
        where: {
          projectId: string
          dedupKey: string
          status?: string | { in: string[] }
          answer?: string
        }
      }) =>
        perguntas.find((p) => {
          if (p.projectId !== args.where.projectId || p.dedupKey !== args.where.dedupKey)
            return false
          const s = args.where.status
          if (typeof s === 'string' && p.status !== s) return false
          if (s && typeof s === 'object' && !s.in.includes(p.status)) return false
          if (args.where.answer !== undefined && p.answer !== args.where.answer) return false
          return true
        }) ?? null,
    },
  }

  return {
    prisma,
    fichas,
    eventos,
    perguntas,
    /** O estado guardado da ficha, ou `undefined`. */
    estadoDe: (projectId: string, tipo: string): unknown =>
      fichas.get(chave(projectId, tipo, 0))?.estado,
    chavesDeEventos: (): string[] =>
      eventos.map((e) => e.payload.chave).filter((c): c is string => typeof c === 'string'),
  }
}

/** Um `agentQuestion.ask` falso: grava a pergunta, sem mensagem real nenhuma. */
export function criarPerguntadorFalso(perguntas: Pergunta[], opcoes: { falhar?: boolean } = {}) {
  const chamadas: Array<{ userId: string; projectId: string; input: Record<string, unknown> }> = []
  return {
    chamadas,
    ask: async (
      userId: string,
      projectId: string,
      input: { text: string; options?: unknown[]; dedupKey?: string }
    ) => {
      chamadas.push({ userId, projectId, input })
      if (opcoes.falhar) throw new Error('serviço de perguntas fora do ar')
      perguntas.push({
        id: `q${perguntas.length + 1}`,
        projectId,
        userId,
        text: input.text,
        options: input.options ?? [],
        dedupKey: input.dedupKey ?? null,
        status: 'open',
        answer: null,
      })
      return { deduped: false }
    },
  }
}
