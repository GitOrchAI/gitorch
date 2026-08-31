// Até onde o GitOrch pode ir no repositório do cliente.
//
// Decisão do dono (29/08): quem acaba de plugar um repositório escolhe o nível,
// e a premissa é pedir permissão A MAIS — "não tem para onde fugir". Por isso o
// padrão de quem nunca escolheu é o mais restrito, e o produto prefere errar
// recusando.
//
// A regra mora AQUI, no cadence, e não em cada serviço: é o mesmo lugar onde
// vivem as outras regras deterministas ("LLM decide, sistema executa"). Assim
// os três motores enxergam exatamente a mesma resposta, e mudar a política é
// mudar uma tabela, não caçar `if` espalhado.
//
// A lição do SSRF vale inteira aqui: guarda espalhada é guarda furada. Esta
// função dá o VEREDITO; quem a chama é a porta de saída de rede, um lugar só.

/**
 * Os três níveis, nas palavras do dono.
 *
 * Os nomes são os do cliente, não os do sistema: é o texto que aparece no
 * painel, no registro do que o produto fez e na recusa.
 */
export const NIVEIS_DE_AUTONOMIA = ['so_olhar', 'sugerir', 'cuidar'] as const
export type NivelDeAutonomia = (typeof NIVEIS_DE_AUTONOMIA)[number]

/**
 * O nível de quem acabou de plugar e ainda não escolheu nada.
 *
 * NUNCA mudar isto para um nível mais solto sem ordem explícita do dono: um
 * padrão permissivo faria o produto escrever no repositório de quem só queria
 * dar uma olhada.
 */
export const NIVEL_PADRAO: NivelDeAutonomia = 'so_olhar'

/**
 * O que o produto pode querer fazer no repositório do cliente.
 *
 * São quatro famílias, ordenadas do inofensivo ao irreversível. Toda escrita
 * nova precisa cair em uma delas — se não couber, a família é que está errada,
 * e não é caso de passar por fora.
 */
export const ACOES_NO_REPOSITORIO = ['ler', 'organizar', 'propor', 'mesclar'] as const
export type AcaoNoRepositorio = (typeof ACOES_NO_REPOSITORIO)[number]

/** O que cada ação significa, na linguagem do cliente. */
export const O_QUE_A_ACAO_FAZ: Record<AcaoNoRepositorio, string> = {
  ler: 'ler o repositório (pedidos, entregas, quadro)',
  organizar: 'organizar o quadro (sprint, ordem, situação dos itens)',
  propor: 'propor trabalho (abrir pedido, abrir entrega, comentar)',
  // "Descartar" entrou aqui junto com a reclassificação do fechamento de pull
  // request: as duas formas de encerrar uma entrega pedem o mesmo nível, e a
  // recusa precisa dizer a verdade sobre o que foi barrado.
  mesclar: 'fechar o ciclo da entrega no código dele (mesclar ou descartar)',
}

/** O que cada nível permite, na linguagem do cliente. */
export const O_QUE_O_NIVEL_PERMITE: Record<NivelDeAutonomia, string> = {
  so_olhar: 'Só olhar — leio e mostro, não escrevo nada no seu repositório',
  sugerir: 'Sugerir — organizo o quadro e proponho trabalho, mas não mesclo nada',
  cuidar: 'Cuidar — fecho o ciclo sozinho, incluindo mesclar',
}

/**
 * A tabela inteira, aberta.
 *
 * Está escrita como dado e não como cadeia de `if` de propósito: dá para bater
 * o olho e conferir as doze casas, e o teste percorre exatamente estas doze.
 * Cada nível contém tudo que o anterior permite — a escada é cumulativa, e o
 * teste cobra isso, para ninguém abrir um buraco no meio.
 */
const PERMITIDO: Record<NivelDeAutonomia, ReadonlySet<AcaoNoRepositorio>> = {
  so_olhar: new Set<AcaoNoRepositorio>(['ler']),
  sugerir: new Set<AcaoNoRepositorio>(['ler', 'organizar', 'propor']),
  cuidar: new Set<AcaoNoRepositorio>(['ler', 'organizar', 'propor', 'mesclar']),
}

export type DecisaoDeEscrita =
  | { pode: true; motivo: string }
  | {
      pode: false
      motivo: string
      /**
       * O nível MAIS BAIXO que liberaria esta ação. É o que deixa o painel
       * dizer "para isso, mude para Sugerir" em vez de só recusar.
       */
      nivelNecessario: NivelDeAutonomia
    }

/**
 * Pode escrever?
 *
 * `nivel` aceita `null`/`undefined`/valor desconhecido de propósito: o campo é
 * novo no banco, projeto antigo tem nulo, e um valor que ninguém reconhece
 * (escrito à mão, ou de uma versão futura) NÃO pode virar "libera". Nos três
 * casos a resposta cai no nível mais restrito.
 */
export function podeEscrever(
  nivel: NivelDeAutonomia | null | undefined | string,
  acao: AcaoNoRepositorio
): DecisaoDeEscrita {
  const nivelValido = normalizarNivel(nivel)

  if (PERMITIDO[nivelValido].has(acao)) {
    return {
      pode: true,
      motivo: `O nível "${nivelValido}" permite ${O_QUE_A_ACAO_FAZ[acao]}.`,
    }
  }

  const nivelNecessario = menorNivelQuePermite(acao)
  return {
    pode: false,
    motivo: `Não posso ${O_QUE_A_ACAO_FAZ[acao]}: você me deixou em "${O_QUE_O_NIVEL_PERMITE[nivelValido]}". Para isso, mude para "${O_QUE_O_NIVEL_PERMITE[nivelNecessario]}".`,
    nivelNecessario,
  }
}

/**
 * Qualquer coisa que não seja um dos três nomes vira o nível mais restrito.
 *
 * Sem isto, um projeto legado com a coluna nula quebraria a leitura da tabela e
 * `PERMITIDO[undefined]` estouraria — ou, pior, um `?.` bem-intencionado faria
 * a checagem devolver "indefinido", que num `if` vira liberado.
 */
export function normalizarNivel(nivel: unknown): NivelDeAutonomia {
  return NIVEIS_DE_AUTONOMIA.includes(nivel as NivelDeAutonomia)
    ? (nivel as NivelDeAutonomia)
    : NIVEL_PADRAO
}

/** O nível mais baixo da escada que libera esta ação. */
export function menorNivelQuePermite(acao: AcaoNoRepositorio): NivelDeAutonomia {
  const achado = NIVEIS_DE_AUTONOMIA.find((n) => PERMITIDO[n].has(acao))
  // Toda ação está em `cuidar`, então isto nunca é nulo; o fallback existe só
  // para não haver caminho sem resposta se alguém acrescentar uma ação e
  // esquecer de encaixá-la na tabela.
  return achado ?? 'cuidar'
}

/**
 * Erro de uma escrita recusada pela autonomia.
 *
 * Tipo próprio para que a porta de saída consiga distinguir "o cliente não
 * autorizou" (que é uma resposta do produto, e vira mensagem no painel) de
 * "deu erro" (que é falha e precisa subir). Um `Error` genérico aqui seria
 * lido como falha de rede em algum `catch` lá na frente.
 */
export class EscritaNaoAutorizadaError extends Error {
  constructor(
    readonly acao: AcaoNoRepositorio,
    readonly nivel: NivelDeAutonomia,
    readonly nivelNecessario: NivelDeAutonomia,
    motivo: string
  ) {
    super(motivo)
    this.name = 'EscritaNaoAutorizadaError'
  }
}

/**
 * O jeito de usar na PORTA: decide e, se for não, lança o erro tipado.
 *
 * Existe para que a porta seja uma linha só e não haja como esquecer de olhar
 * o resultado — o defeito clássico de uma guarda que devolve booleano é o
 * chamador ignorar o retorno e escrever assim mesmo.
 */
export function exigirPermissao(
  nivel: NivelDeAutonomia | null | undefined | string,
  acao: AcaoNoRepositorio
): void {
  const decisao = podeEscrever(nivel, acao)
  if (decisao.pode) return
  throw new EscritaNaoAutorizadaError(
    acao,
    normalizarNivel(nivel),
    decisao.nivelNecessario,
    decisao.motivo
  )
}
