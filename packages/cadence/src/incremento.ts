// Quando uma entrega vira ENTREGA de verdade.
//
// Scrum 2020: o Incremento nasce quando um item atende à Definição de Pronto.
// Antes disto o produto não registrava entrega nenhuma — sabia que um PR foi
// mesclado, sabia se a publicação foi ao ar, e não juntava as duas coisas em
// "isto ficou pronto".
//
// A régua é CONFIGURÁVEL pelo cliente (decisão do dono, 6.1: "isso tem que ser
// dinâmico e o cliente escolhe nas configurações do painel"). Para nós, ela
// inclui estar no ar — a regra dele é que só evoluiu quando foi testado em
// produção real, nada simulado.
//
// O QUE ESTA CAMADA NÃO FAZ: rastrear coisa nova. Todos os fatos abaixo já
// existem no banco, gravados pelo caminho que já roda. A régua só JULGA o que
// já está medido. Inventar um rastreio novo para responder "está pronto?"
// seria construir uma segunda verdade ao lado da primeira.

/**
 * Os critérios, na linguagem do cliente.
 *
 * Cada um responde uma pergunta que ele faria em voz alta, e cada um é
 * ligável/desligável por projeto.
 */
export const CRITERIOS_DE_PRONTO = ['entregou', 'mesclado', 'no_ar', 'ambiente_respondeu'] as const
export type CriterioDePronto = (typeof CRITERIOS_DE_PRONTO)[number]

/** O que cada critério quer dizer, para o cliente ler na configuração. */
export const O_QUE_O_CRITERIO_EXIGE: Record<CriterioDePronto, string> = {
  entregou: 'existe uma entrega aberta para o pedido',
  mesclado: 'a entrega foi mesclada no seu código',
  no_ar: 'a publicação chegou ao ar',
  ambiente_respondeu: 'o seu ambiente respondeu depois da publicação',
}

/** O que dizer quando o critério NÃO passou. Frase inteira, para a tela. */
export const O_QUE_FALTA: Record<CriterioDePronto, string> = {
  entregou: 'ainda não há entrega aberta para este pedido',
  mesclado: 'a entrega existe mas ainda não foi mesclada',
  no_ar: 'foi mesclada, mas ainda não chegou ao ar',
  ambiente_respondeu: 'publicou, mas o seu ambiente ainda não respondeu',
}

/**
 * A régua padrão do produto.
 *
 * `no_ar` vem LIGADO porque é a regra do dono: só conta como evoluído o que foi
 * ao ar de verdade. `ambiente_respondeu` vem desligado porque depende de o
 * cliente ter declarado um endereço de ambiente — cobrar um critério que ele
 * não tem como atender transformaria toda entrega em "faltando alguma coisa".
 */
export const REGUA_PADRAO: Readonly<Record<CriterioDePronto, boolean>> = {
  entregou: true,
  mesclado: true,
  no_ar: true,
  ambiente_respondeu: false,
}

/**
 * Os fatos, do jeito que o banco já os tem.
 *
 * Nomes iguais aos das colunas de `dev_sessions` de propósito: quem for
 * conferir se a régua está julgando a coisa certa não precisa traduzir nada.
 */
export interface FatosDaEntrega {
  /** Número do pull request, quando existe. */
  pullRequestNumber: number | null
  /** SHA da mescla. Preenchido = entrou no código do cliente. */
  mergeCommitSha: string | null
  /** 'no-ar' | 'falhou' | 'publicando' | 'sem-publicacao' | 'commit-errado' */
  deployState: string | null
  /** 'no-ar' | 'inalcancavel' — o ensaio do ambiente do cliente. */
  envLastVerdict: string | null
}

export type ReguaDePronto = Readonly<Partial<Record<CriterioDePronto, boolean>>>

export interface VeredictoDePronto {
  pronto: boolean
  /** Critérios LIGADOS que passaram. */
  atendidos: CriterioDePronto[]
  /** Critérios LIGADOS que não passaram, na ordem da régua. */
  faltando: CriterioDePronto[]
  /**
   * O que falta, escrito para o cliente ler. Vazio quando está pronto.
   *
   * Existe como campo e não como cálculo da tela porque o que falta é a parte
   * que não pode se perder: uma entrega que não fechou sem dizer por quê é
   * exatamente o silêncio que este bloco veio acabar.
   */
  porQueNaoFechou: string[]
}

/** Cada critério, decidido só pelos fatos. Nenhum olha para os outros. */
const PASSOU: Record<CriterioDePronto, (f: FatosDaEntrega) => boolean> = {
  entregou: (f) => typeof f.pullRequestNumber === 'number',
  mesclado: (f) => typeof f.mergeCommitSha === 'string' && f.mergeCommitSha.length > 0,
  // 'publicando' NÃO conta: está a caminho, não chegou. Contar o caminho como
  // chegada é a mentira pequena que faz o painel dizer "entregue" enquanto o
  // cliente ainda não consegue usar.
  no_ar: (f) => f.deployState === 'no-ar',
  ambiente_respondeu: (f) => f.envLastVerdict === 'no-ar',
}

/**
 * Um item está pronto?
 *
 * Critério desligado não é julgado — nem entra em `atendidos`, nem em
 * `faltando`. Desligar é dizer "isto não faz parte da minha régua", e não
 * "considere que passou".
 *
 * Régua sem NENHUM critério ligado devolve `pronto: false`, e não `true` por
 * vacuidade: uma régua vazia significa que o cliente ainda não disse o que é
 * pronto para ele, e nesse caso o produto não tem o direito de afirmar que
 * algo está.
 */
export function avaliarPronto(
  fatos: FatosDaEntrega,
  regua: ReguaDePronto = REGUA_PADRAO
): VeredictoDePronto {
  const ligados = CRITERIOS_DE_PRONTO.filter((c) => regua[c] === true)

  const atendidos = ligados.filter((c) => PASSOU[c](fatos))
  const faltando = ligados.filter((c) => !PASSOU[c](fatos))

  return {
    pronto: ligados.length > 0 && faltando.length === 0,
    atendidos,
    faltando,
    porQueNaoFechou: faltando.map((c) => O_QUE_FALTA[c]),
  }
}

/**
 * Normaliza a régua que veio do banco (JSON solto) para algo confiável.
 *
 * O que não for reconhecido é DESCARTADO, e chave faltando cai no padrão. Uma
 * régua meio escrita não pode virar uma régua permissiva por acidente: aqui,
 * "não sei o que é isto" nunca vira "então passa".
 */
export function normalizarRegua(bruto: unknown): Record<CriterioDePronto, boolean> {
  const saida = { ...REGUA_PADRAO } as Record<CriterioDePronto, boolean>
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return saida
  const obj = bruto as Record<string, unknown>
  for (const c of CRITERIOS_DE_PRONTO) {
    if (typeof obj[c] === 'boolean') saida[c] = obj[c] as boolean
  }
  return saida
}
