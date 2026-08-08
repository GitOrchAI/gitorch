import { describe, it, expect, vi } from 'vitest'
import { coletarDividaDeSeguranca } from './security-debt-collector.js'
import { restDeMentira as githubDeMentira } from '../test/rest-fake.js'

const ALERTA_BRUTO = {
  number: 182,
  state: 'open',
  html_url: 'https://exemplo.invalido/alerta/182',
  created_at: '2026-01-02T03:04:05Z',
  dependency: {
    package: { name: 'uma-lib', ecosystem: 'npm' },
    manifest_path: 'pnpm-lock.yaml',
  },
  security_advisory: { severity: 'medium', summary: 'resumo do problema' },
  security_vulnerability: { first_patched_version: { identifier: '4.12.34' } },
}

describe('coletarDividaDeSeguranca', () => {
  it('traduz o alerta bruto para o que a esteira precisa saber', async () => {
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': {
        status: 200,
        corpo: { enabled: true, paused: false },
      },
      '/repos/dono/repo/contents/.github/dependabot.yml': {
        status: 200,
        corpo: { name: 'dependabot.yml' },
      },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [ALERTA_BRUTO],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.vigilanciaLigada).toBe(true)
    expect(d.correcaoAutomaticaLigada).toBe(true)
    expect(d.temConfiguracao).toBe(true)
    expect(d.alertas).toEqual([
      {
        numero: 182,
        severidade: 'medium',
        pacote: 'uma-lib',
        ecossistema: 'npm',
        manifesto: 'pnpm-lock.yaml',
        resumo: 'resumo do problema',
        versaoCorrigida: '4.12.34',
        url: 'https://exemplo.invalido/alerta/182',
        criadoEm: '2026-01-02T03:04:05Z',
      },
    ])
    expect(d.porSeveridade).toEqual({ critical: 0, high: 0, medium: 1, low: 0 })
  })

  it('vigilância desligada é fato conhecido, não falha', async () => {
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 404 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.vigilanciaLigada).toBe(false)
    expect(d.temConfiguracao).toBe(false)
    expect(d.alertas).toEqual([])
    expect(d.naoVerificado).toEqual([])
  })

  // Credencial sem alcance responde 403. Isso NÃO é "zero alertas": é "não
  // consegui olhar". Confundir os dois faria a esteira jurar que o repositório
  // está limpo quando ninguém olhou.
  it('sem alcance para a rota, registra que não verificou — nunca finge zero', async () => {
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 403 },
      '/repos/dono/repo/automated-security-fixes': { status: 403 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 200, corpo: { name: 'x' } },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': { status: 403 },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.vigilanciaLigada).toBeNull()
    expect(d.alertas).toEqual([])
    expect(d.naoVerificado).toContain('alertas')
    expect(d.naoVerificado).toContain('vigilancia')
  })

  // GitHub pagina esta rota por CURSOR, não por número (ver teste seguinte).
  // A página seguinte só existe se o cabeçalho Link da resposta anterior
  // trouxer rel="next" — sem ele, a coleta para na primeira página.
  it('pagina os alertas seguindo o cursor do cabeçalho Link até a última página', async () => {
    const cheia = Array.from({ length: 100 }, (_, i) => ({ ...ALERTA_BRUTO, number: i + 1 }))
    const proximaPagina =
      'https://api.github.com/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-1'
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': {
        status: 200,
        corpo: { enabled: false, paused: false },
      },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: cheia,
        headers: { link: `<${proximaPagina}>; rel="next"` },
      },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-1': {
        status: 200,
        corpo: [
          {
            ...ALERTA_BRUTO,
            number: 101,
            security_advisory: { severity: 'critical', summary: 's' },
          },
        ],
        // Sem Link nesta resposta: é a última página.
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.alertas).toHaveLength(101)
    expect(d.porSeveridade.critical).toBe(1)
  })

  // A rota recusa `page` com 400 ("Pagination using the `page` parameter is
  // not supported"). Sem este teste, nada impede alguém de reintroduzir o
  // bug que a prova contra a API real encontrou.
  it('não pagina os alertas por número — a rota recusa o parâmetro page', async () => {
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
    })

    await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    const chamadas = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0])
    )
    const chamadasDeAlertas = chamadas.filter((u) => u.includes('/dependabot/alerts'))
    expect(chamadasDeAlertas.length).toBeGreaterThan(0)
    expect(chamadasDeAlertas.every((u) => !/[?&]page=/.test(u))).toBe(true)
  })

  // Falha de rede (timeout, DNS, conexão resetada) é o caso comum em
  // produção — ao contrário de um 403 limpo. Se uma chamada rejeitar, a
  // função inteira não pode rejeitar junto e jogar fora o que já foi
  // verificado com sucesso.
  it('falha de rede numa rota não derruba a coleta inteira — preserva o que já foi verificado', async () => {
    const base = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
    })
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/dependabot/alerts')) {
        throw new Error('conexão resetada (simulado)')
      }
      return base(url)
    }) as unknown as typeof fetch

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.vigilanciaLigada).toBe(true)
    expect(d.alertas).toEqual([])
    expect(d.naoVerificado).toContain('alertas')
  })

  // Mesmo raciocínio do teste de "falha de rede" acima, mas para o caso em
  // que a conexão fica pendurada em vez de recusar na hora: sem
  // tempo-limite, uma rota que nunca responde trava a coleta inteira (até
  // ~13 chamadas sequenciais neste fluxo) numa rota síncrona do wizard. O
  // fake honra o `signal` recebido e rejeita com o mesmo TimeoutError que
  // `AbortSignal.timeout` produz de verdade (confirmado contra o fetch
  // nativo do Node) — é o mesmo catch genérico do teste acima que já sabe
  // tratar isso, só falta a chamada carregar um tempo-limite.
  it('rota que não responde a tempo entra em naoVerificado — não trava a coleta inteira', async () => {
    const base = githubDeMentira({
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
    })
    const fetchImpl = vi.fn(async (url: string | URL, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/vulnerability-alerts')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error))
        })
      }
      return base(url)
    }) as unknown as typeof fetch

    const d = await coletarDividaDeSeguranca({
      repository: 'dono/repo',
      token: 't',
      fetchImpl,
      timeoutMs: 5,
    })

    expect(d.vigilanciaLigada).toBeNull()
    expect(d.naoVerificado).toContain('vigilancia')
  })

  // 403 na config é "não consegui olhar", não "não existe". Confundir os
  // dois poderia disparar depois uma ação de criar configuração num
  // repositório que já tem uma — só que o token não alcançava.
  it('sem alcance na configuração (403) registra naoVerificado — nunca vira "sem configuração"', async () => {
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 403 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.temConfiguracao).toBe(false)
    expect(d.naoVerificado).toContain('configuracao')
  })

  it('severidade em caixa diferente ainda é reconhecida (case-insensitive)', async () => {
    const alertaCaixaAlta = {
      ...ALERTA_BRUTO,
      security_advisory: { severity: 'CRITICAL', summary: 'x' },
    }
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [alertaCaixaAlta],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.alertas[0]?.severidade).toBe('critical')
    expect(d.naoVerificado).not.toContain('severidade-desconhecida')
  })

  // Reportar um alerta crítico como 'low' é a mentira mais cara que esta
  // função pode contar. Severidade que a API devolve fora das quatro
  // conhecidas vira 'critical' (superestimar é o lado seguro) — nunca
  // 'low' — e fica registrada para ninguém descobrir tarde.
  it('severidade desconhecida vira critical (superestima, não esconde) e é sinalizada', async () => {
    const alertaEstranho = {
      ...ALERTA_BRUTO,
      security_advisory: { severity: 'banana', summary: 'x' },
    }
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [alertaEstranho],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.alertas[0]?.severidade).toBe('critical')
    expect(d.porSeveridade.critical).toBe(1)
    expect(d.naoVerificado).toContain('severidade-desconhecida')
  })

  // Truncar em silêncio é mentir por omissão: se o teto de páginas foi
  // atingido e ainda havia próxima página, a esteira precisa saber que o
  // retrato está incompleto.
  it('teto de páginas trunca com rastro — não finge coleta completa', async () => {
    const mapa: Record<
      string,
      { status: number; corpo?: unknown; headers?: Record<string, string> }
    > = {
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
    }
    const caminhoBase = '/repos/dono/repo/dependabot/alerts?state=open&per_page=100'
    for (let i = 1; i <= 10; i++) {
      const caminho = i === 1 ? caminhoBase : `${caminhoBase}&after=cursor-${i}`
      const proximoCaminho = `${caminhoBase}&after=cursor-${i + 1}`
      mapa[caminho] = {
        status: 200,
        corpo: [{ ...ALERTA_BRUTO, number: i }],
        // Todas as 10 páginas — inclusive a última buscada — ainda anunciam
        // uma próxima. É o teto (não a API) que decide parar aqui.
        headers: { link: `<https://api.github.com${proximoCaminho}>; rel="next"` },
      }
    }
    const fetchImpl = githubDeMentira(mapa)

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

    expect(d.alertas).toHaveLength(10)
    expect(d.naoVerificado).toContain('alertas-parcial')
    const chamadas = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0])
    )
    // A 11ª página nunca é buscada — nem está no mapa, cairia em 404 se fosse.
    expect(chamadas.filter((u) => u.includes('/dependabot/alerts')).length).toBe(10)
  })

  it('segue o cursor mesmo com rel=next sem aspas (RFC 8288 permite)', async () => {
    const proximaPagina =
      'https://api.github.com/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-x'
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [ALERTA_BRUTO],
        headers: { link: `<${proximaPagina}>; rel=next` },
      },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-x': {
        status: 200,
        corpo: [{ ...ALERTA_BRUTO, number: 999 }],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })
    expect(d.alertas).toHaveLength(2)
  })

  it('segue o cursor quando rel traz múltiplos valores (ex.: "next alternate")', async () => {
    const proximaPagina =
      'https://api.github.com/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-y'
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [ALERTA_BRUTO],
        headers: { link: `<${proximaPagina}>; rel="next alternate"` },
      },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100&after=cursor-y': {
        status: 200,
        corpo: [{ ...ALERTA_BRUTO, number: 998 }],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })
    expect(d.alertas).toHaveLength(2)
  })

  // O cabeçalho Link vem da RESPOSTA HTTP — dado que a API devolve, não algo
  // que o produto controla. Toda chamada desta função carrega a credencial
  // do cliente no Authorization: seguir cegamente uma URL vinda desse
  // cabeçalho entregaria essa credencial a qualquer host que a resposta
  // apontasse. Os três casos abaixo têm que ser recusados SEM nenhuma
  // chamada de rede para o host suspeito — recusar depois de já ter chamado
  // `fetch` não protegeria a credencial de nada.
  describe('recusa seguir paginação para fora do host da API do GitHub — nunca vaza a credencial', () => {
    it('link aponta para outro host inteiramente', async () => {
      const fetchImpl = githubDeMentira({
        '/repos/dono/repo/vulnerability-alerts': { status: 204 },
        '/repos/dono/repo/automated-security-fixes': { status: 404 },
        '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
        '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
          status: 200,
          corpo: [ALERTA_BRUTO],
          headers: { link: '<http://servidor-alheio.invalido/x>; rel="next"' },
        },
      })

      const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

      const chamadas = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => String(c[0])
      )
      expect(chamadas.some((u) => u.includes('servidor-alheio'))).toBe(false)
      expect(d.alertas).toHaveLength(1)
      expect(d.naoVerificado).toContain('alertas-link-suspeito')
    })

    it('link aponta para host que só parece o do GitHub (sufixo, não igualdade)', async () => {
      const fetchImpl = githubDeMentira({
        '/repos/dono/repo/vulnerability-alerts': { status: 204 },
        '/repos/dono/repo/automated-security-fixes': { status: 404 },
        '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
        '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
          status: 200,
          corpo: [ALERTA_BRUTO],
          headers: {
            link: '<https://api.github.com.servidor-alheio.invalido/x>; rel="next"',
          },
        },
      })

      const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

      const chamadas = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => String(c[0])
      )
      expect(chamadas.some((u) => u.includes('servidor-alheio'))).toBe(false)
      expect(d.alertas).toHaveLength(1)
      expect(d.naoVerificado).toContain('alertas-link-suspeito')
    })

    it('link com URL malformada é recusado, não estoura exceção', async () => {
      const fetchImpl = githubDeMentira({
        '/repos/dono/repo/vulnerability-alerts': { status: 204 },
        '/repos/dono/repo/automated-security-fixes': { status: 404 },
        '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
        '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
          status: 200,
          corpo: [ALERTA_BRUTO],
          headers: { link: '<isto-nao-e-uma-url>; rel="next"' },
        },
      })

      const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })

      const chamadas = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => String(c[0])
      )
      expect(chamadas.some((u) => u.includes('isto-nao-e-uma-url'))).toBe(false)
      expect(d.alertas).toHaveLength(1)
      expect(d.naoVerificado).toContain('alertas-link-suspeito')
    })
  })

  it('alerta sem versão corrigida não vira string vazia', async () => {
    const semCorrecao = { ...ALERTA_BRUTO, security_vulnerability: {} }
    const fetchImpl = githubDeMentira({
      '/repos/dono/repo/vulnerability-alerts': { status: 204 },
      '/repos/dono/repo/automated-security-fixes': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 404 },
      '/repos/dono/repo/dependabot/alerts?state=open&per_page=100': {
        status: 200,
        corpo: [semCorrecao],
      },
    })

    const d = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })
    expect(d.alertas[0]?.versaoCorrigida).toBeNull()
  })

  // `repository` chega de um valor que o próprio cliente escolhe (o repo
  // selecionado no funil). A requisição carrega a credencial DELE no
  // cabeçalho Authorization — se o valor pudesse escapar do formato
  // `dono/repo` esperado, a credencial sairia junto para onde quer que a URL
  // apontasse. Cada caso abaixo tem que ser recusado SEM gerar nenhuma
  // chamada de rede — recusar depois de já ter chamado o `fetch` não
  // protegeria nada.
  describe('recusa repository fora do formato dono/repo — nunca chama a rede', () => {
    const CASOS: Array<[string, string]> = [
      ['atravessa diretório com ../', 'dono/repo/../../outro'],
      ['embute outro host com @', '@servidor-alheio/caminho'],
      ['injeta query string', 'dono/repo?x=y'],
      ['string vazia', ''],
      ['barra a mais no caminho', 'dono/repo/extra'],
    ]

    for (const [descricao, repository] of CASOS) {
      it(descricao, async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch

        const d = await coletarDividaDeSeguranca({ repository, token: 't', fetchImpl })

        expect(fetchImpl).not.toHaveBeenCalled()
        expect(d.naoVerificado).toContain('repositorio-invalido')
        expect(d.alertas).toEqual([])
        expect(d.vigilanciaLigada).toBeNull()
        expect(d.correcaoAutomaticaLigada).toBeNull()
        expect(d.temConfiguracao).toBe(false)
      })
    }
  })
})
