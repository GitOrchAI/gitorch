// O retrato da dívida de segurança do repositório, no momento em que a esteira
// assume o trabalho. É o que transforma "atualizar dependência" de intenção
// vaga em tarefa com pacote, versão e gravidade.
//
// Todas as rotas usadas aqui recusam a credencial do produto (403) e exigem a
// credencial do cliente. Por isso "não consegui olhar" é um estado de primeira
// classe: dizer zero alertas quando ninguém olhou seria mentir sobre segurança.

const GITHUB_API = 'https://api.github.com'

// `deps.repository` chega de um valor que o cliente escolhe (o repo
// selecionado no funil, gravado como wingId do projeto) — NÃO é um literal
// controlado pelo produto. Toda chamada desta função carrega a credencial do
// PRÓPRIO cliente no cabeçalho Authorization (é o motivo desta função
// existir: só essa credencial alcança as rotas de segurança). Se o valor
// pudesse escapar do formato `dono/repo` que o GitHub realmente aceita —
// atravessando diretório, embutindo outro host, ganhando uma query string —
// a URL montada abaixo sairia para um destino diferente do GitHub e levaria
// a credencial do cliente junto. Validar aqui, antes de montar qualquer URL,
// é a única defesa que não depende de quem chama esta função hoje ou vier a
// chamar amanhã.
const SEGMENTO_VALIDO = /^[A-Za-z0-9._-]+$/

// O cabeçalho `Link` que a paginação segue (ver `proximaPaginaDoLink` mais
// abaixo) vem da RESPOSTA HTTP — dado que a API devolve, não um literal que
// este arquivo controla. `pedirUrl` manda a credencial do cliente no
// Authorization em toda chamada; se o código seguisse a URL do Link sem
// checar, um `Link: <http://servidor-alheio/x>; rel="next"` faria a
// PRÓXIMA chamada (com a credencial junto) sair para esse host — hoje a
// primeira chamada sempre vai para o GitHub, então a resposta "deveria" ser
// confiável, mas "deveria" não é uma garantia que o código expressa: basta
// um proxy no meio do caminho, um redirecionamento, ou este arquivo um dia
// apontar para outro provedor para deixar de valer. Comparar o HOST inteiro
// (nunca prefixo/substring: "https://api.github.com.servidor-alheio" bate
// em startsWith/includes de "https://api.github.com" mas é outro host por
// completo) é a única checagem que não depende de quem monta a resposta.
const HOST_API_GITHUB = new URL(GITHUB_API).host

function apontaParaApiDoGithub(url: string): boolean {
  try {
    return new URL(url).host === HOST_API_GITHUB
  } catch {
    // URL malformada não é um host válido — mesma recusa.
    return false
  }
}

// A ÚNICA porta de saída de rede deste arquivo: toda requisição que
// `coletarDividaDeSeguranca` faz — a montada com `repository` e a que segue
// o cabeçalho Link da paginação — passa por aqui antes de tocar `fetch`. A
// checagem de host mora NESTA função, não nos chamadores: um caminho novo
// que alguém adicione amanhã (mais uma rota, mais uma paginação) nasce
// protegido por construção, em vez de depender de lembrar de repetir a
// checagem em mais um lugar. As validações que os chamadores de hoje já
// fazem (`repositorioValido` na entrada da função, o host-check antes de
// seguir o Link) continuam existindo como defesa em profundidade — dão uma
// mensagem melhor e param mais cedo — mas a garantia estrutural é esta.
// Exportada só para o teste poder provar a porta sozinha, sem passar pelas
// validações que os chamadores de hoje já fazem antes de chegar aqui.
export function pedirUrlSegura(
  url: string,
  fetchImpl: typeof fetch,
  cabecalhos: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  if (!apontaParaApiDoGithub(url)) {
    // Rejeição, não exceção síncrona: quem chama (dentro de
    // coletarDividaDeSeguranca) já trata qualquer falha de `pedirUrl` num
    // try/catch que marca o rótulo correspondente em naoVerificado e segue
    // best-effort — nunca deixa a coleta inteira cair nem o retrato dizer
    // "está limpo" sem registrar o que não deu para verificar.
    return Promise.reject(new Error('recusado: a URL não aponta para o host da API do GitHub'))
  }
  return fetchImpl(url, { headers: cabecalhos, signal: AbortSignal.timeout(timeoutMs) })
}

function repositorioValido(repository: string): boolean {
  const partes = repository.split('/')
  if (partes.length !== 2) return false
  const [dono, nome] = partes
  if (!dono || !nome) return false
  if (!SEGMENTO_VALIDO.test(dono) || !SEGMENTO_VALIDO.test(nome)) return false
  // O charset acima já aceita '.', mas '..' isolado é o caso que abre
  // travessia de diretório em outras APIs — recusar mesmo sem precisar dele
  // aqui é mais barato do que confiar que nunca vai importar.
  if (dono.includes('..') || nome.includes('..')) return false
  return true
}

// Cada chamada aqui já é independente e best-effort — uma falhar só marca o
// rótulo correspondente em naoVerificado, nunca derruba a coleta (comentário
// acima do bloco try/catch). Mas sem tempo-limite uma conexão pendurada
// (nunca falha, nunca responde) travaria essa mesma chamada indefinidamente
// numa rota síncrona do wizard — e esta função soma até ~13 chamadas
// sequenciais no pior caso (3 checagens fixas + até 10 páginas de alertas).
// 8s por chamada é generoso o bastante para uma resposta lenta da API REST
// do GitHub (latência típica bem abaixo de 1s) sem deixar uma única rota
// travada segurar o retrato inteiro por tempo desproporcional.
const CHAMADA_TIMEOUT_MS = 8_000

export type Severidade = 'critical' | 'high' | 'medium' | 'low'

const SEVERIDADES: Severidade[] = ['critical', 'high', 'medium', 'low']

export interface AlertaDeSeguranca {
  numero: number
  severidade: Severidade
  pacote: string
  ecossistema: string
  manifesto: string
  resumo: string
  /** Nulo quando ainda não existe versão que corrija. */
  versaoCorrigida: string | null
  url: string
  criadoEm: string
}

export interface DividaDeSeguranca {
  /** Nulo quando a credencial não alcançou a resposta. */
  vigilanciaLigada: boolean | null
  correcaoAutomaticaLigada: boolean | null
  temConfiguracao: boolean
  alertas: AlertaDeSeguranca[]
  porSeveridade: Record<Severidade, number>
  /** O que não deu para verificar, para o aviso poder ser honesto. Rótulos
   *  possíveis: 'vigilancia', 'correcao-automatica', 'configuracao',
   *  'alertas' (a coleta parou antes do fim — status inesperado ou falha de
   *  rede), 'alertas-parcial' (o teto de páginas foi atingido com mais
   *  restando), 'alertas-link-suspeito' (o cabeçalho Link da resposta
   *  apontava para um host diferente do da API do GitHub — a paginação foi
   *  interrompida ANTES de mandar a credencial do cliente para lá; ver
   *  `apontaParaApiDoGithub`), 'severidade-desconhecida' (a API devolveu uma
   *  severidade fora das quatro conhecidas — tratada como 'critical' por
   *  segurança) e 'repositorio-invalido' (o valor de `repository` não tem o
   *  formato `dono/repo` que o GitHub aceita — nenhuma chamada de rede é
   *  feita nesse caso). */
  naoVerificado: string[]
}

interface AlertaBruto {
  number: number
  html_url?: string
  created_at?: string
  dependency?: { package?: { name?: string; ecosystem?: string }; manifest_path?: string }
  security_advisory?: { severity?: string; summary?: string }
  security_vulnerability?: { first_patched_version?: { identifier?: string } }
}

export async function coletarDividaDeSeguranca(deps: {
  repository: string
  token: string
  fetchImpl?: typeof fetch
  /** Override só para teste — não faz sentido esperar o timeout de produção
   *  rodar de verdade numa suíte. */
  timeoutMs?: number
}): Promise<DividaDeSeguranca> {
  const f = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? CHAMADA_TIMEOUT_MS
  const naoVerificado: string[] = []

  // Recusa ANTES de montar qualquer URL ou tocar a rede — ver o comentário
  // de `repositorioValido` acima sobre por que isto importa: a credencial do
  // cliente vai no cabeçalho de toda chamada que este arquivo faz. Best-
  // effort por contrato (mesmo padrão do resto da função): um `repository`
  // ruim não vira exceção que derruba a coleta do board/PRs/Issues que já
  // rodou antes desta função ser chamada — vira "não verificado", honesto
  // sobre o que não deu para checar.
  if (!repositorioValido(deps.repository)) {
    naoVerificado.push('repositorio-invalido')
    return {
      vigilanciaLigada: null,
      correcaoAutomaticaLigada: null,
      temConfiguracao: false,
      alertas: [],
      porSeveridade: { critical: 0, high: 0, medium: 0, low: 0 },
      naoVerificado,
    }
  }

  const cabecalhos = {
    Authorization: `Bearer ${deps.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  // Um AbortSignal novo por chamada (não um único reutilizado): cada rota
  // tem seu próprio orçamento de tempo, independente das outras — igual ao
  // isolamento que o try/catch de cada bloco já garante para falhas. A
  // checagem de host que protege a saída de rede mora dentro de
  // `pedirUrlSegura` (a porta única, ver comentário lá) — não repetida aqui.
  const pedirUrl = (url: string): Promise<Response> => pedirUrlSegura(url, f, cabecalhos, timeoutMs)
  const pedir = (caminho: string): Promise<Response> => pedirUrl(`${GITHUB_API}${caminho}`)

  // Cada rota é independente: uma falhar (status inesperado OU exceção de
  // rede — timeout, DNS, conexão resetada, o caso comum em produção) nunca
  // pode derrubar a coleta inteira e jogar fora o que já foi verificado.
  // 204 = ligado, 404 = desligado, qualquer outra coisa = não consegui olhar.
  let vigilanciaLigada: boolean | null = null
  try {
    const vigilancia = await pedir(`/repos/${deps.repository}/vulnerability-alerts`)
    if (vigilancia.status === 204) vigilanciaLigada = true
    else if (vigilancia.status === 404) vigilanciaLigada = false
    else naoVerificado.push('vigilancia')
  } catch {
    naoVerificado.push('vigilancia')
  }

  let correcaoAutomaticaLigada: boolean | null = null
  try {
    const correcao = await pedir(`/repos/${deps.repository}/automated-security-fixes`)
    if (correcao.status === 200) {
      correcaoAutomaticaLigada = ((await correcao.json()) as { enabled?: boolean }).enabled === true
    } else if (correcao.status === 404) {
      correcaoAutomaticaLigada = false
    } else {
      naoVerificado.push('correcao-automatica')
    }
  } catch {
    naoVerificado.push('correcao-automatica')
  }

  // 200 = tem, 404 = não tem, qualquer outra coisa = não consegui olhar —
  // igual à vigilância. Um 403 aqui NÃO é "sem configuração": é a
  // credencial sem alcance, e confundir os dois poderia disparar uma ação
  // errada (ex.: criar configuração num repositório que já tem uma).
  let temConfiguracao = false
  try {
    const config = await pedir(`/repos/${deps.repository}/contents/.github/dependabot.yml`)
    if (config.status === 200) temConfiguracao = true
    else if (config.status === 404) temConfiguracao = false
    else naoVerificado.push('configuracao')
  } catch {
    naoVerificado.push('configuracao')
  }

  const alertas: AlertaDeSeguranca[] = []
  let severidadeDesconhecida = false
  // Esta rota pagina por CURSOR, não por número: `?page=N` é recusado com 400
  // ("Pagination using the `page` parameter is not supported"). A URL da
  // próxima página vem pronta no cabeçalho Link (rel="next") — segui-lo é a
  // única forma correta de avançar; ausência dele é a última página.
  let proximaUrl: string | null =
    `${GITHUB_API}/repos/${deps.repository}/dependabot/alerts?state=open&per_page=100`
  for (let pagina = 1; pagina <= 10 && proximaUrl !== null; pagina++) {
    let lote: AlertaBruto[]
    let linkHeader: string | null
    try {
      const resp = await pedirUrl(proximaUrl)
      if (!resp.ok) {
        naoVerificado.push('alertas')
        break
      }
      lote = (await resp.json()) as AlertaBruto[]
      linkHeader = resp.headers.get('link')
    } catch {
      naoVerificado.push('alertas')
      break
    }

    for (const a of lote) {
      const bruta = a.security_advisory?.severity?.toLowerCase()
      let severidade: Severidade
      if (SEVERIDADES.includes(bruta as Severidade)) {
        severidade = bruta as Severidade
      } else {
        // Severidade que a API devolveu fora das quatro conhecidas: virar
        // 'low' esconderia risco real. Superestimar é o lado seguro.
        severidade = 'critical'
        severidadeDesconhecida = true
      }
      alertas.push({
        numero: a.number,
        severidade,
        pacote: a.dependency?.package?.name ?? '',
        ecossistema: a.dependency?.package?.ecosystem ?? '',
        manifesto: a.dependency?.manifest_path ?? '',
        resumo: a.security_advisory?.summary ?? '',
        versaoCorrigida: a.security_vulnerability?.first_patched_version?.identifier ?? null,
        url: a.html_url ?? '',
        criadoEm: a.created_at ?? '',
      })
    }

    const proxima = proximaPaginaDoLink(linkHeader)
    // A URL de `proxima` veio do cabeçalho Link da RESPOSTA — dado externo,
    // não um literal deste arquivo. Antes de mandar a próxima chamada (e a
    // credencial do cliente que ela carrega) para lá, confirma que ainda
    // aponta para o host da API do GitHub. Recusa é o mesmo tratamento do
    // teto de páginas logo abaixo: registra e para, nunca finge que a
    // coleta terminou limpa.
    if (proxima !== null && !apontaParaApiDoGithub(proxima)) {
      naoVerificado.push('alertas-link-suspeito')
      break
    }
    // Teto atingido com página seguinte ainda anunciada: parar aqui em
    // silêncio mentiria por omissão sobre alertas não coletados.
    if (pagina === 10 && proxima !== null) naoVerificado.push('alertas-parcial')
    proximaUrl = proxima
  }
  if (severidadeDesconhecida) naoVerificado.push('severidade-desconhecida')

  const porSeveridade = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severidade, number>
  for (const a of alertas) porSeveridade[a.severidade] += 1

  return {
    vigilanciaLigada,
    correcaoAutomaticaLigada,
    temConfiguracao,
    alertas,
    porSeveridade,
    naoVerificado,
  }
}

/** Lê o cabeçalho `Link` (RFC 8288) e devolve a URL marcada com o relation
 *  type `next`, ou nulo quando a resposta atual já é a última página. A RFC
 *  permite `rel=next` sem aspas e `rel="next alternate"` com mais de um
 *  valor — reconhecer só `rel="next"` literal faria a paginação parar cedo
 *  demais contra uma API que use qualquer uma dessas formas válidas. */
function proximaPaginaDoLink(link: string | null): string | null {
  if (!link) return null
  for (const parte of link.split(',')) {
    const urlMatch = /<([^>]+)>/.exec(parte)
    const relMatch = /rel\s*=\s*"?([^";]*)"?/i.exec(parte)
    if (!urlMatch?.[1] || !relMatch?.[1]) continue
    const valores = relMatch[1].trim().split(/\s+/)
    if (valores.includes('next')) return urlMatch[1]
  }
  return null
}
