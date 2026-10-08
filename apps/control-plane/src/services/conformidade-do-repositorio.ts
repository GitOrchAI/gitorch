// Fase 5.6: conformidade — licenças de dependência, indícios de dado pessoal
// em schema/migrations, documentos ausentes (CODEOWNERS/SECURITY.md) e
// Actions fixadas por versão (os dois últimos vêm da nota de segurança, sem
// ler de novo). Só RELATA: nada aqui escreve no repositório do cliente.
//
// Regra de honestidade: leitura que falhou é "não verificado" com o motivo,
// nunca uma lista vazia que parece "tudo certo".

import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { repositorioValido } from './nota-de-seguranca.js'
import type { ArvoreDoRepositorio, EntradaDaArvore } from './nota-de-seguranca.js'
import { cortarPorPontoDeCodigo, mascararCredenciais, mensagemDoErro } from './texto-seguro.js'

/** Copyleft forte: o que costuma pedir avaliação jurídica antes de embarcar num
 *  produto fechado. É um PADRÃO conservador, não uma verdade universal: cada
 *  projeto troca a lista em `runtime_config.licencasEmAtencao`. Cada entrada
 *  casa a família inteira (`GPL` pega `GPL-3.0-only`, `GPL-2.0-or-later`...;
 *  `LGPL`, copyleft fraco, fica de fora). */
export const LICENCAS_EM_ATENCAO_PADRAO: readonly string[] = [
  'AGPL',
  'GPL',
  'SSPL',
  'Commons-Clause',
]

const MAXIMO_DE_ENTRADAS_NA_LISTA = 50
const MAXIMO_DE_CARACTERES_POR_ENTRADA = 64

/** A lista de licenças em atenção de um projeto: `runtime_config.licencasEmAtencao`
 *  (lista de textos) quando válida; senão o padrão, avisando. Lista vazia é uma
 *  escolha válida ("não quero alerta de licença"). */
export function licencasEmAtencaoDoProjeto(
  runtimeConfig: unknown,
  onWarn?: (mensagem: string) => void
): string[] {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null) {
    return [...LICENCAS_EM_ATENCAO_PADRAO]
  }
  const bruto: unknown = Object.getOwnPropertyDescriptor(runtimeConfig, 'licencasEmAtencao')?.value
  if (bruto === undefined) return [...LICENCAS_EM_ATENCAO_PADRAO]
  const valida =
    Array.isArray(bruto) &&
    bruto.length <= MAXIMO_DE_ENTRADAS_NA_LISTA &&
    bruto.every(
      (e) =>
        typeof e === 'string' && e.trim().length > 0 && e.length <= MAXIMO_DE_CARACTERES_POR_ENTRADA
    )
  if (!valida) {
    onWarn?.(
      'licencasEmAtencao do projeto inválida (esperava uma lista de textos); usando o padrão'
    )
    return [...LICENCAS_EM_ATENCAO_PADRAO]
  }
  return (bruto as string[]).map((e) => e.trim())
}

function normalizarLicenca(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^LICENSEREF-/, '')
    .replace(/\+$/, '')
}

function idEmAtencao(id: string, lista: string[]): boolean {
  const n = normalizarLicenca(id)
  return lista.some((entrada) => {
    const e = normalizarLicenca(entrada)
    return e !== '' && (n === e || n.startsWith(`${e}-`))
  })
}

/**
 * Uma expressão SPDX (`MIT OR GPL-3.0-only`, `(A AND B) OR C`) está "em
 * atenção" quando NÃO há saída permissiva: um `OR` só pesa se todas as
 * alternativas pesam, um `AND` pesa se qualquer parte pesa.
 */
function expressaoEmAtencao(expressao: string, lista: string[]): boolean {
  const tokens = expressao.match(/\(|\)|[^\s()]+/g) ?? []
  let posicao = 0
  const proximo = (): string | undefined => tokens[posicao]
  const ehOperador = (t: string | undefined, nome: string) => t?.toUpperCase() === nome

  function ou(): boolean {
    let todas = fator()
    while (ehOperador(proximo(), 'OR')) {
      posicao += 1
      const outra = fator()
      todas = todas && outra
    }
    return todas
  }
  function fator(): boolean {
    let alguma = unidade()
    while (ehOperador(proximo(), 'AND')) {
      posicao += 1
      const outra = unidade()
      alguma = alguma || outra
    }
    return alguma
  }
  function unidade(): boolean {
    const t = proximo()
    if (t === undefined) throw new Error('expressão incompleta')
    posicao += 1
    if (t === '(') {
      const dentro = ou()
      if (proximo() !== ')') throw new Error('parêntese aberto')
      posicao += 1
      return dentro
    }
    if (t === ')' || ehOperador(t, 'AND') || ehOperador(t, 'OR')) throw new Error('operador solto')
    const pesa = idEmAtencao(t, lista)
    if (ehOperador(proximo(), 'WITH')) posicao += 2
    return pesa
  }

  try {
    const resultado = ou()
    if (posicao !== tokens.length) throw new Error('sobrou texto')
    return resultado
  } catch {
    // Expressão que o leitor não entende: na dúvida, olha cada licença citada.
    return tokens.some(
      (t) =>
        t !== '(' &&
        t !== ')' &&
        !['AND', 'OR', 'WITH'].includes(t.toUpperCase()) &&
        idEmAtencao(t, lista)
    )
  }
}

/** As dependências cuja licença (ou expressão) pede atenção, pela lista dada. */
export function licencasProblematicas(
  licencas: Array<{ nome: string; licenca: string | null }>,
  licencasEmAtencao: string[]
): Array<{ nome: string; licenca: string }> {
  if (licencasEmAtencao.length === 0) return []
  const achadas: Array<{ nome: string; licenca: string }> = []
  for (const l of licencas) {
    if (l.licenca !== null && expressaoEmAtencao(l.licenca, licencasEmAtencao)) {
      achadas.push({ nome: l.nome, licenca: l.licenca })
    }
  }
  return achadas
}

/** Padrões HEURÍSTICOS — nunca prova de PII real, só sinal para revisão
 *  humana. Falso positivo (nome de coluna "email" numa tabela sem dado real
 *  ainda) é esperado: por isso é INDÍCIO informativo, nunca alerta. */
const PADROES_DE_PII: ReadonlyArray<{ nome: string; regex: RegExp }> = [
  { nome: 'cpf', regex: /\bcpf\b/i },
  { nome: 'e-mail', regex: /\bemail\b/i },
  { nome: 'telefone', regex: /\btelefone\b|\bphone\b/i },
  { nome: 'cnpj', regex: /\bcnpj\b/i },
  { nome: 'endereço', regex: /\bendereco\b|\baddress\b/i },
]

export function achadosDePii(conteudo: string): string[] {
  return PADROES_DE_PII.filter((p) => p.regex.test(conteudo)).map(
    (p) =>
      `possível campo de ${p.nome} — confirme se há dado pessoal real e se o tratamento (LGPD) está documentado`
  )
}

export type IndicioDePii = {
  padrao: string
  ocorrencias: number
  arquivos: number
}

/** Quantas vezes cada padrão aparece e em quantos arquivos (só os que aparecem). */
export function indiciosDePii(
  arquivos: Array<{ caminho: string; conteudo: string }>
): IndicioDePii[] {
  const saida: IndicioDePii[] = []
  for (const padrao of PADROES_DE_PII) {
    const global = new RegExp(padrao.regex.source, `${padrao.regex.flags.replace('g', '')}g`)
    let ocorrencias = 0
    let emArquivos = 0
    for (const arquivo of arquivos) {
      const n = arquivo.conteudo.match(global)?.length ?? 0
      ocorrencias += n
      if (n > 0) emArquivos += 1
    }
    if (ocorrencias > 0) saida.push({ padrao: padrao.nome, ocorrencias, arquivos: emArquivos })
  }
  return saida
}

export interface LicencaDeDependencia {
  nome: string
  /** `null` = o pacote não declara licença. */
  licenca: string | null
}

export type LeituraDeLicencas =
  { tipo: 'lido'; pacotes: LicencaDeDependencia[] } | { tipo: 'indisponivel'; motivo: string }

export interface ListarLicencas {
  (): Promise<LeituraDeLicencas>
}

const GITHUB_API = 'https://api.github.com'
const HOST_API_GITHUB = new URL(GITHUB_API).host

/** Porta de saída PRÓPRIA deste arquivo (ver a regra em nota-de-seguranca.ts). */
async function pedirUrlSegura(
  url: string,
  fetchImpl: typeof fetch,
  token: string,
  aoReceberRespostaRuim?: (resposta: Response) => void
): Promise<Response> {
  if (new URL(url).host !== HOST_API_GITHUB) {
    throw new Error('recusado: URL fora do host da API do GitHub')
  }
  const resposta = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch',
    },
  })
  if (!resposta.ok) {
    try {
      aoReceberRespostaRuim?.(resposta.clone())
    } catch {
      // O aviso é só para o freio de cota; nunca derruba a leitura.
    }
  }
  return resposta
}

const MAXIMO_DE_BYTES_DO_SBOM = 25_000_000

interface PacoteDoSbom {
  SPDXID?: unknown
  name?: unknown
  licenseConcluded?: unknown
}

/**
 * Licenças das dependências pelo SBOM do GitHub (`dependency-graph/sbom`, SPDX):
 * não clona nem instala nada do repositório do cliente.
 *
 * O endpoint síncrono tem descontinuação anunciada pelo GitHub (o substituto é
 * um relatório assíncrono). Quando sair do ar, ou num repositório sem o grafo
 * de dependências ligado, a resposta é 404/410: isso volta como
 * `indisponivel` com o motivo, e a conformidade registra "não verificado".
 * Jamais como lista vazia.
 */
export function listarLicencasPeloSbom(deps: {
  repository: string
  token: string
  fetchImpl?: typeof fetch
  aoReceberRespostaRuim?: (resposta: Response) => void
}): ListarLicencas {
  return async () => {
    if (!repositorioValido(deps.repository)) {
      return { tipo: 'indisponivel', motivo: 'nome de repositório inválido' }
    }
    try {
      const resposta = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/dependency-graph/sbom`,
        deps.fetchImpl ?? fetchSemPermissao(),
        deps.token,
        deps.aoReceberRespostaRuim
      )
      if (!resposta.ok) {
        return {
          tipo: 'indisponivel',
          motivo: `o GitHub não entregou o SBOM do repositório (${resposta.status})`,
        }
      }
      const tamanho = Number(resposta.headers.get('content-length') ?? 0)
      if (tamanho > MAXIMO_DE_BYTES_DO_SBOM) {
        return { tipo: 'indisponivel', motivo: 'o SBOM do repositório é grande demais para ler' }
      }
      const dados = (await resposta.json()) as {
        sbom?: { packages?: unknown; relationships?: unknown }
      }
      const pacotes = dados.sbom?.packages
      if (!Array.isArray(pacotes)) {
        return { tipo: 'indisponivel', motivo: 'resposta do SBOM sem a lista de pacotes' }
      }
      // O próprio repositório (alvo do DESCRIBES) e as Actions não são dependências de código.
      const descritos = new Set<string>(
        Array.isArray(dados.sbom?.relationships)
          ? (dados.sbom.relationships as Array<Record<string, unknown>>)
              .filter((r) => r['relationshipType'] === 'DESCRIBES')
              .map((r) => String(r['relatedSpdxElement']))
          : []
      )
      const saida: LicencaDeDependencia[] = []
      for (const pacote of pacotes as PacoteDoSbom[]) {
        const id = typeof pacote.SPDXID === 'string' ? pacote.SPDXID : ''
        if (descritos.has(id) || id.startsWith('SPDXRef-githubactions-')) continue
        if (typeof pacote.name !== 'string') continue
        const licenca = pacote.licenseConcluded
        saida.push({
          nome: pacote.name,
          licenca:
            typeof licenca === 'string' && licenca !== '' && licenca !== 'NOASSERTION'
              ? licenca
              : null,
        })
      }
      return { tipo: 'lido', pacotes: saida }
    } catch (err) {
      return {
        tipo: 'indisponivel',
        motivo: mascararCredenciais(`falha ao ler o SBOM (${mensagemDoErro(err)})`, [deps.token]),
      }
    }
  }
}

export type LeituraDeArquivos =
  | { tipo: 'lido'; arquivos: Array<{ caminho: string; conteudo: string }> }
  | { tipo: 'indisponivel'; motivo: string }

export interface ListarArquivosDeSchema {
  (): Promise<LeituraDeArquivos>
}

const MAXIMO_DE_BLOBS_POR_PASSADA = 3
const MAXIMO_DE_BYTES_POR_ARQUIVO = 200_000
const EH_SCHEMA = /(^|\/)schema\.prisma$/
const EH_MIGRACAO = /(^|\/)(migrations\/.*|[^/]*migration[^/]*)\.sql$/i

/** Os arquivos de schema/migração a ler: o schema primeiro, depois as migrações
 *  mais novas (o nome carrega a data), até `maximo`. */
export function escolherArquivosDeSchema(
  arvore: ArvoreDoRepositorio,
  maximo: number = MAXIMO_DE_BLOBS_POR_PASSADA
): EntradaDaArvore[] {
  const candidatos = arvore.entradas.filter(
    (e) =>
      e.type === 'blob' &&
      e.sha !== null &&
      !e.path.startsWith('node_modules/') &&
      !e.path.includes('/node_modules/') &&
      e.size !== null &&
      e.size <= MAXIMO_DE_BYTES_POR_ARQUIVO &&
      (EH_SCHEMA.test(e.path) || EH_MIGRACAO.test(e.path))
  )
  const schemas = candidatos
    .filter((e) => EH_SCHEMA.test(e.path))
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, 1)
  const migracoes = candidatos
    .filter((e) => !EH_SCHEMA.test(e.path))
    .sort((a, b) => b.path.localeCompare(a.path))
  return [...schemas, ...migracoes].slice(0, maximo)
}

/** Lê (no máximo 3) arquivos de schema/migração pela API de blobs. Sem
 *  candidato = nada a olhar (não é falha); com candidatos e nenhum lido =
 *  indisponível. */
export function lerArquivosDeSchemaPelaApi(deps: {
  repository: string
  token: string
  fetchImpl?: typeof fetch
  arvore: ArvoreDoRepositorio | null
  aoReceberRespostaRuim?: (resposta: Response) => void
}): ListarArquivosDeSchema {
  return async () => {
    if (!deps.arvore) {
      return { tipo: 'indisponivel', motivo: 'a árvore de arquivos do repositório não foi lida' }
    }
    if (!repositorioValido(deps.repository)) {
      return { tipo: 'indisponivel', motivo: 'nome de repositório inválido' }
    }
    const escolhidos = escolherArquivosDeSchema(deps.arvore)
    const lidos: Array<{ caminho: string; conteudo: string }> = []
    for (const entrada of escolhidos) {
      if (entrada.sha === null || !/^[0-9a-f]{40}$/i.test(entrada.sha)) continue
      try {
        const resposta = await pedirUrlSegura(
          `${GITHUB_API}/repos/${deps.repository}/git/blobs/${entrada.sha}`,
          deps.fetchImpl ?? fetchSemPermissao(),
          deps.token,
          deps.aoReceberRespostaRuim
        )
        if (!resposta.ok) continue
        const blob = (await resposta.json()) as { content?: unknown; encoding?: unknown }
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string') continue
        lidos.push({
          caminho: entrada.path,
          conteudo: Buffer.from(blob.content, 'base64').toString('utf-8'),
        })
      } catch {
        // este arquivo não deu; os outros seguem
      }
    }
    if (escolhidos.length > 0 && lidos.length === 0) {
      return { tipo: 'indisponivel', motivo: 'nenhum arquivo de schema pôde ser baixado' }
    }
    return { tipo: 'lido', arquivos: lidos }
  }
}

const MAXIMO_DE_PACOTES_GUARDADOS = 200

/** Teto de cada texto que vem de fora (nome de pacote, licença, motivo, caminho)
 *  e vai para a ficha: o que o GitHub devolve não decide o tamanho da linha. */
export const MAXIMO_DE_CARACTERES_DE_TEXTO = 200

function cortarTexto(texto: string): string {
  return cortarPorPontoDeCodigo(texto, MAXIMO_DE_CARACTERES_DE_TEXTO, { sufixo: '…' })
}

/** O motivo de uma falha vai para a ficha: sem credencial e no teto de tamanho. */
function motivoSeguro(texto: string): string {
  return cortarTexto(mascararCredenciais(texto))
}

export type ResultadoDeLicencas =
  | {
      estado: 'verificado'
      total: number
      semLicenca: number
      emAtencaoTotal: number
      /** Até 200, em ordem de nome, com cada texto cortado em 200 caracteres. */
      emAtencao: Array<{ nome: string; licenca: string }>
      /** Quantos em atenção não couberam em `emAtencao`. */
      emAtencaoOmitidas: number
      listaUsada: string[]
    }
  | { estado: 'nao-verificado'; motivo: string }

export type ResultadoDeIndicios =
  | { estado: 'verificado'; arquivosLidos: string[]; indicios: IndicioDePii[] }
  | { estado: 'nao-verificado'; motivo: string }

export interface ResultadoDeConformidade {
  licencas: ResultadoDeLicencas
  /** Informativo (heurística por palavra-chave), nunca alerta. */
  indiciosDePii: ResultadoDeIndicios
  /** `null` = não verificado. */
  codeownersAusente: boolean | null
  securityMdAusente: boolean | null
  actionsSemSha: boolean | null
}

export async function conferirConformidade(deps: {
  listarLicencas: ListarLicencas
  licencasEmAtencao: string[]
  lerArquivosDeSchema: ListarArquivosDeSchema
  codeownersAusente: boolean | null
  securityMdAusente: boolean | null
  actionsSemSha: boolean | null
}): Promise<ResultadoDeConformidade> {
  const licencas = await (async (): Promise<ResultadoDeLicencas> => {
    try {
      const leitura = await deps.listarLicencas()
      if (leitura.tipo === 'indisponivel') {
        return { estado: 'nao-verificado', motivo: motivoSeguro(leitura.motivo) }
      }
      const emAtencao = licencasProblematicas(leitura.pacotes, deps.licencasEmAtencao).sort(
        (a, b) => a.nome.localeCompare(b.nome)
      )
      return {
        estado: 'verificado',
        total: leitura.pacotes.length,
        semLicenca: leitura.pacotes.filter((p) => p.licenca === null).length,
        emAtencaoTotal: emAtencao.length,
        emAtencao: emAtencao.slice(0, MAXIMO_DE_PACOTES_GUARDADOS).map((p) => ({
          nome: cortarTexto(p.nome),
          licenca: cortarTexto(p.licenca),
        })),
        emAtencaoOmitidas: Math.max(0, emAtencao.length - MAXIMO_DE_PACOTES_GUARDADOS),
        listaUsada: deps.licencasEmAtencao,
      }
    } catch (err) {
      return {
        estado: 'nao-verificado',
        motivo: motivoSeguro(`falha ao ler as licenças (${mensagemDoErro(err)})`),
      }
    }
  })()

  const indicios = await (async (): Promise<ResultadoDeIndicios> => {
    try {
      const leitura = await deps.lerArquivosDeSchema()
      if (leitura.tipo === 'indisponivel') {
        return { estado: 'nao-verificado', motivo: motivoSeguro(leitura.motivo) }
      }
      return {
        estado: 'verificado',
        arquivosLidos: leitura.arquivos.map((a) => cortarTexto(a.caminho)),
        indicios: indiciosDePii(leitura.arquivos),
      }
    } catch (err) {
      return {
        estado: 'nao-verificado',
        motivo: motivoSeguro(`falha ao ler o schema (${mensagemDoErro(err)})`),
      }
    }
  })()

  return {
    licencas,
    indiciosDePii: indicios,
    codeownersAusente: deps.codeownersAusente,
    securityMdAusente: deps.securityMdAusente,
    actionsSemSha: deps.actionsSemSha,
  }
}
