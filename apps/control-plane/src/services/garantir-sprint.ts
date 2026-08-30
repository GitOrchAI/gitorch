import { CampoDeIteracaoAusenteError } from '@gitorch/github-sync'

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
 *  100% com IA, então o ciclo é curto.
 *
 *  O cliente muda a dele pelo painel (coluna `sprint_dias` em `projects`,
 *  decisão do dono de 30/08: "nosso projeto de desenvolvimento 3 dias mas pra
 *  clientes no painel eles decidem de quantos dias"). Este número é o padrão
 *  de quem nunca escolheu — nunca uma imposição. */
export const DIAS_DE_SPRINT_PADRAO = 3

/** Os limites do que é uma sprint de verdade.
 *
 *  Abaixo de 1 dia o ciclo nunca fecha; acima de 60, "sprint" vira um nome
 *  bonito para "sem prazo". Os dois extremos quebram a promessa do quadro em
 *  vez de configurá-lo, então são recusados na porta da rota E no banco
 *  (CHECK em `projects`) — quem escrever por outro caminho encontra a mesma
 *  regra. */
export const MINIMO_DE_DIAS_DA_SPRINT = 1
export const MAXIMO_DE_DIAS_DA_SPRINT = 60

/** Nome do campo de iteração no quadro do cliente. */
export const CAMPO_DE_SPRINT = 'Sprint'

/** Fuso em que o dia é contado. O servidor roda em UTC; o dono vive em UTC-3. */
export const FUSO_DO_PRODUTO = 'America/Sao_Paulo'

/**
 * Que dia é hoje para quem está olhando o painel.
 *
 * Usar a data UTC do servidor encurta o ciclo: entre 21h e a meia-noite no
 * horário de Brasília o relógio UTC já virou, e uma sprint de 3 dias apareceria
 * encerrada até 3 horas antes — 4% do ciclo.
 */
export function hojeNoFuso(agora: Date = new Date(), fuso: string = FUSO_DO_PRODUTO): string {
  // en-CA formata como YYYY-MM-DD, que é exatamente o formato do GitHub.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora)
}

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
  } catch (erro) {
    // SÓ a ausência do campo é tolerada — esse é o caminho normal do quadro que
    // nunca teve sprint. Qualquer outra falha (rede, 502 do GraphQL, token sem
    // a autorização de quadros) SOBE.
    //
    // Engolir tudo aqui seria o pior defeito possível deste arquivo: uma falha
    // passageira viraria "o campo não existe" e o passo seguinte criaria um
    // SEGUNDO campo Sprint no quadro real do cliente, deixando órfãos os itens
    // que apontavam para o primeiro.
    if (!ausenciaDeCampo(erro)) throw erro
    campo = null
  }

  if (!campo) {
    // JANELA CONHECIDA E NÃO FECHADA (dita aqui para não ser descoberta depois):
    // entre a leitura acima e a criação abaixo existe um intervalo em que uma
    // SEGUNDA execução para o mesmo projeto também leria "não existe" e também
    // criaria. O resultado seriam dois campos "Sprint" no quadro do cliente, e
    // `getIterationField` passa a enxergar só o primeiro da lista — o outro
    // vira lixo permanente, sem detecção nem conserto automático.
    //
    // O que protege hoje, e até onde: a varredura roda em série dentro do tique,
    // e `tickEmAndamento` impede dois tiques no MESMO processo. O que NÃO
    // protege: duas instâncias do control-plane ao mesmo tempo — a trava é um
    // booleano em memória de processo. Na prática isso significa a janela de
    // sobreposição de um deploy/restart.
    //
    // O que fecharia de verdade: um lock por projeto no banco (SELECT ... FOR
    // UPDATE) em volta deste bloco, ou idempotência pelo id do campo já gravado
    // em vez de por nome. Não foi feito nesta rodada porque não dá para provar
    // sem arriscar criar a duplicata no quadro real do dono — e proteção não
    // testada é pior que janela conhecida.
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

/**
 * A falha foi "o campo não existe" (e não rede, permissão ou 502)?
 *
 * `instanceof` primeiro; o teste pelo `name` cobre o caso de o pacote ter sido
 * carregado por dois caminhos diferentes, em que duas classes iguais deixam de
 * ser a mesma classe.
 */
function ausenciaDeCampo(erro: unknown): boolean {
  if (erro instanceof CampoDeIteracaoAusenteError) return true
  return erro instanceof Error && erro.name === 'CampoDeIteracaoAusenteError'
}
