// Um Prisma de mentira que FILTRA de verdade.
//
// POR QUE EXISTE: os testes do control-plane injetam um Prisma falso. Um falso
// que só devolve `mockResolvedValue([...])` prova que a rota CHAMOU o banco, e
// não que o `where` que ela montou seleciona as linhas certas. Foi teste desse
// tipo que deixou a régua de pronto passar por PRs mesclados "com todos os
// testes verdes" enquanto a tela dizia "0 de 50".
//
// Aqui as linhas entram como dados e saem filtradas, ordenadas e paginadas
// pelo MESMO objeto `where` que a rota manda para o Prisma de verdade. O que o
// teste confere é o conjunto de linhas — resultado, não chamada.
//
// O interpretador é GENÉRICO: não sabe nada sobre régua de pronto, entregas ou
// dev_sessions. Se soubesse, seria uma segunda implementação da regra e
// concordaria com a primeira por parentesco, não por acerto.
//
// OPERADOR DESCONHECIDO ESTOURA, de propósito. Um interpretador que ignora o
// que não entende transforma filtro errado em teste verde — mascarar o buraco
// é pior que não ter o teste.

export type Linha = Record<string, unknown>
export type Where = Record<string, unknown>

const eObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

const lista = (v: unknown): Where[] => (Array.isArray(v) ? (v as Where[]) : [v as Where])

/** Comparação de valor simples. Date compara pelo instante, não pela identidade. */
function igual(valor: unknown, alvo: unknown): boolean {
  if (valor instanceof Date && alvo instanceof Date) return valor.getTime() === alvo.getTime()
  return valor === alvo
}

/** Os operadores de campo que este interpretador conhece. */
const OPERADORES = ['equals', 'not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte'] as const

function ordenavel(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number.NaN
  return Number.NaN
}

function comparar(valor: unknown, alvo: unknown): number {
  const a = ordenavel(valor)
  const b = ordenavel(alvo)
  if (Number.isNaN(a) || Number.isNaN(b)) {
    // Strings comparam lexicograficamente; qualquer outra coisa é erro.
    if (typeof valor === 'string' && typeof alvo === 'string')
      return valor < alvo ? -1 : valor > alvo ? 1 : 0
    throw new Error(`where-em-memoria: não sei comparar ${String(valor)} com ${String(alvo)}`)
  }
  return a - b
}

function casaCampo(valor: unknown, cond: unknown): boolean {
  if (!eObjeto(cond)) return igual(valor, cond)

  for (const chave of Object.keys(cond)) {
    if (!(OPERADORES as readonly string[]).includes(chave)) {
      throw new Error(
        `where-em-memoria: operador '${chave}' desconhecido. ` +
          `Ensine-o aqui em vez de deixar o filtro passar sem ser conferido.`
      )
    }
  }

  return Object.entries(cond).every(([op, alvo]) => {
    switch (op) {
      case 'equals':
        return igual(valor, alvo)
      case 'not':
        return eObjeto(alvo) ? !casaCampo(valor, alvo) : !igual(valor, alvo)
      case 'in':
        return Array.isArray(alvo) && alvo.some((a) => igual(valor, a))
      case 'notIn':
        return Array.isArray(alvo) && !alvo.some((a) => igual(valor, a))
      case 'gt':
        return comparar(valor, alvo) > 0
      case 'gte':
        return comparar(valor, alvo) >= 0
      case 'lt':
        return comparar(valor, alvo) < 0
      case 'lte':
        return comparar(valor, alvo) <= 0
      default:
        throw new Error(`where-em-memoria: operador '${op}' sem tratamento`)
    }
  })
}

/**
 * A linha passa pelo `where`?
 *
 * `OR: []` NÃO casa nada — é o mesmo que o Prisma faz, e é do que a régua sem
 * nenhum critério ligado depende para não declarar tudo pronto por vacuidade.
 */
export function casa(linha: Linha, where: Where | undefined): boolean {
  if (where === undefined) return true
  return Object.entries(where).every(([chave, cond]) => {
    if (chave === 'AND') return lista(cond).every((w) => casa(linha, w))
    if (chave === 'OR') return lista(cond).some((w) => casa(linha, w))
    if (chave === 'NOT') return lista(cond).every((w) => !casa(linha, w))
    if (cond === undefined) return true
    return casaCampo(linha[chave], cond)
  })
}

/** Uma chave de ordenação, como o Prisma a recebe. */
export type Ordem = Record<string, 'asc' | 'desc'>

export interface ConsultaEmMemoria {
  where?: Where
  /**
   * Uma chave, ou várias em ordem de desempate — como no Prisma de verdade.
   *
   * A forma em ARRAY existe porque é a que conserta ordenação instável: uma
   * coluna que a esteira reescreve (`updatedAt`) precisa de um desempate fixo
   * (`id`), ou linhas empatadas trocam de lugar entre duas viradas de página.
   */
  orderBy?: Ordem | Ordem[]
  skip?: number
  take?: number
  select?: Record<string, boolean>
}

/** As chaves de ordenação, já achatadas e na ordem em que desempatam. */
function chavesDaOrdem(orderBy: Ordem | Ordem[]): [string, 'asc' | 'desc'][] {
  const lista = Array.isArray(orderBy) ? orderBy : [orderBy]
  return lista.flatMap((o) => Object.entries(o))
}

/**
 * Uma tabela do Prisma, em memória, com `count` e `findMany` de verdade.
 *
 * `count` e `findMany` leem o MESMO `where`: é isto que permite ao teste provar
 * que o número do cabeçalho e as linhas da página falam da mesma população.
 */
export function tabelaEmMemoria<T extends Linha>(linhas: readonly T[]) {
  const filtrar = (q: ConsultaEmMemoria | undefined) => linhas.filter((l) => casa(l, q?.where))

  return {
    linhas,
    count: async (q?: ConsultaEmMemoria): Promise<number> => filtrar(q).length,
    findMany: async (q?: ConsultaEmMemoria): Promise<T[]> => {
      let saida = filtrar(q)
      const ordem = q?.orderBy
      if (ordem) {
        const chaves = chavesDaOrdem(ordem)
        if (chaves.length === 0) throw new Error('where-em-memoria: orderBy vazio')
        // Coluna ausente nas linhas do teste ESTOURA em `comparar`, de
        // propósito: ordenar por um campo que o fixture não tem é uma
        // ordenação que não está sendo conferida.
        saida = [...saida].sort((a, b) => {
          for (const [campo, dir] of chaves) {
            const d = comparar(a[campo], b[campo]) * (dir === 'desc' ? -1 : 1)
            if (d !== 0) return d
          }
          return 0
        })
      }
      const inicio = q?.skip ?? 0
      const fim = q?.take === undefined ? undefined : inicio + q.take
      return saida.slice(inicio, fim)
    },
  }
}
