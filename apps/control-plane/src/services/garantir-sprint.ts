// Garante que o quadro do cliente tenha uma sprint de verdade.
//
// A sprint do GitOrch é o campo de ITERAÇÃO do Projects V2. Sem ele, a visão
// Roadmap do GitHub abre com "Dates: none" e não desenha nada — foi exatamente
// o que o dono viu no quadro do gitorch.
//
// Três estados encontrados na conta dele em 29/08, e os três precisam de
// tratamento diferente:
//   sem campo      → criar          (quadro do gitorch)
//   campo vazio    → configurar     (quadro do Jardim: existe, duração 0)
//   campo pronto   → NÃO TOCAR      (mexer apagaria a sprint em andamento)

/** Duração padrão da sprint, em dias. Decisão do dono (29/08): trabalhamos
 *  100% com IA, então o ciclo é curto. O cliente pode mudar. */
export const DIAS_DE_SPRINT_PADRAO = 3

/** Nome do campo de iteração no quadro do cliente. */
export const CAMPO_DE_SPRINT = 'Sprint'

export interface Iteracao {
  id: string
  title: string
  startDate: string
  duration: number
}

export interface ClienteDeQuadro {
  /** Lê o campo de iteração pelo nome. Lança quando o campo não existe. */
  getIterationField(input: {
    projectId: string
    fieldName: string
  }): Promise<{ fieldId: string; iterations: Iteracao[] }>
  criarCampoDeIteracao(input: {
    projectId: string
    fieldName: string
    duracaoEmDias: number
    inicio: string
  }): Promise<{ fieldId: string; name: string }>
  configurarCampoDeIteracao(input: {
    projectId: string
    fieldId: string
    fieldName: string
    duracaoEmDias: number
    inicio: string
  }): Promise<string>
}

export type ResultadoDaSprint =
  | { estado: 'criado'; fieldId: string; motivo: string }
  | { estado: 'configurado'; fieldId: string; motivo: string }
  | { estado: 'ja_pronto'; fieldId: string; iteracoes: number; motivo: string }

/**
 * Garante o campo Sprint no quadro. Idempotente: rodar de novo não duplica
 * campo nem mexe em sprint que já está rodando.
 *
 * `hoje` entra por parâmetro porque data de sistema dentro de regra deixa o
 * teste refém do relógio.
 */
export async function garantirSprintNoQuadro(
  cliente: ClienteDeQuadro,
  args: {
    projectId: string
    /** Padrão: 3 dias. */
    duracaoEmDias?: number
    /** Data base (YYYY-MM-DD). Padrão: hoje. */
    hoje?: string
  }
): Promise<ResultadoDaSprint> {
  const duracaoEmDias = args.duracaoEmDias ?? DIAS_DE_SPRINT_PADRAO
  const inicio = args.hoje ?? new Date().toISOString().slice(0, 10)

  let campo: { fieldId: string; iterations: Iteracao[] } | null = null
  try {
    campo = await cliente.getIterationField({
      projectId: args.projectId,
      fieldName: CAMPO_DE_SPRINT,
    })
  } catch {
    // O cliente lança quando o campo não existe — é o caminho normal do quadro
    // que nunca teve sprint, não um erro de verdade.
    campo = null
  }

  if (!campo) {
    const criado = await cliente.criarCampoDeIteracao({
      projectId: args.projectId,
      fieldName: CAMPO_DE_SPRINT,
      duracaoEmDias,
      inicio,
    })
    return {
      estado: 'criado',
      fieldId: criado.fieldId,
      motivo: `O quadro não tinha campo de sprint. Criado com ciclo de ${duracaoEmDias} dias.`,
    }
  }

  if (campo.iterations.length === 0) {
    // Existe e não funciona. Recriar perderia o vínculo dos itens que já
    // apontam para este campo, então a operação é de atualização.
    const fieldId = await cliente.configurarCampoDeIteracao({
      projectId: args.projectId,
      fieldId: campo.fieldId,
      fieldName: CAMPO_DE_SPRINT,
      duracaoEmDias,
      inicio,
    })
    return {
      estado: 'configurado',
      fieldId,
      motivo: `O campo de sprint existia mas estava vazio. Configurado com ciclo de ${duracaoEmDias} dias.`,
    }
  }

  return {
    estado: 'ja_pronto',
    fieldId: campo.fieldId,
    iteracoes: campo.iterations.length,
    motivo: `A sprint já está configurada (${campo.iterations.length} ciclo(s)). Nada foi alterado.`,
  }
}

/**
 * Qual sprint está valendo hoje.
 *
 * O GitHub não marca a corrente: entrega a lista e a conta é de quem lê. Uma
 * data fora de qualquer ciclo devolve `null` — é o intervalo entre sprints, e
 * dizer que alguma está correndo ali seria inventar.
 */
export function sprintCorrente(iteracoes: readonly Iteracao[], hoje: string): Iteracao | null {
  const dia = new Date(`${hoje}T00:00:00Z`).getTime()
  for (const it of iteracoes) {
    const inicio = new Date(`${it.startDate}T00:00:00Z`).getTime()
    const fim = inicio + it.duration * 86400000
    if (dia >= inicio && dia < fim) return it
  }
  return null
}
