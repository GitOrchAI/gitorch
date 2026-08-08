// O retrato da dívida de segurança do repositório, no momento em que a esteira
// assume o trabalho. É o que transforma "atualizar dependência" de intenção
// vaga em tarefa com pacote, versão e gravidade.
//
// Todas as rotas usadas aqui recusam a credencial do produto (403) e exigem a
// credencial do cliente. Por isso "não consegui olhar" é um estado de primeira
// classe: dizer zero alertas quando ninguém olhou seria mentir sobre segurança.

const GITHUB_API = 'https://api.github.com'

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
   *  restando) e 'severidade-desconhecida' (a API devolveu uma severidade
   *  fora das quatro conhecidas — tratada como 'critical' por segurança). */
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

  const cabecalhos = {
    Authorization: `Bearer ${deps.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  // Um AbortSignal novo por chamada (não um único reutilizado): cada rota
  // tem seu próprio orçamento de tempo, independente das outras — igual ao
  // isolamento que o try/catch de cada bloco já garante para falhas.
  const pedirUrl = (url: string): Promise<Response> =>
    f(url, { headers: cabecalhos, signal: AbortSignal.timeout(timeoutMs) })
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
