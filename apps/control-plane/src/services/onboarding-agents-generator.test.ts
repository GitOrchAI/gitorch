import { describe, expect, it, vi } from 'vitest'
import { montarConteudoAgentsMd, verificarOuGerarAgentsMd } from './onboarding-agents-generator.js'

describe('onboarding-agents-generator', () => {
  const repository = 'GitOrchAI/autocandidata'
  const defaultBranch = 'main'
  const token = 'ghp_fake_token_123'

  describe('montarConteudoAgentsMd', () => {
    it('gera AGENTS.md honesto para repositório greenfield sem manifestos', () => {
      const conteudo = montarConteudoAgentsMd({
        repository: 'GitOrchAI/autocandidata',
        rootItems: [{ name: 'README.md', type: 'file' }],
        docsItems: [],
        packageJson: null,
      })

      expect(conteudo).toContain('# AGENTS.md — GitOrchAI/autocandidata')
      expect(conteudo).toContain('greenfield')
      expect(conteudo).toContain('bootstrap')
      // Regra anti-alucinação: não inventa npm test nem comandos fictícios
      expect(conteudo).not.toContain('npm test')
      expect(conteudo).not.toContain('pnpm test')
      expect(conteudo).toContain('NUNCA execute ou presuma comandos fictícios')
    })

    it('gera AGENTS.md com comandos reais a partir de scripts do package.json', () => {
      const conteudo = montarConteudoAgentsMd({
        repository: 'GitOrchAI/app-web',
        rootItems: [
          { name: 'package.json', type: 'file' },
          { name: 'pnpm-lock.yaml', type: 'file' },
        ],
        docsItems: [{ name: 'architecture.md', type: 'file' }],
        packageJson: {
          name: 'app-web',
          scripts: {
            build: 'next build',
            test: 'vitest run',
            lint: 'eslint src',
          },
        },
      })

      expect(conteudo).toContain('# AGENTS.md — GitOrchAI/app-web')
      expect(conteudo).toContain('pnpm run build')
      expect(conteudo).toContain('pnpm run test')
      expect(conteudo).toContain('pnpm run lint')
      expect(conteudo).toContain('architecture.md')
    })

    it('gera AGENTS.md informando ausência de scripts quando package.json não tem scripts definidos', () => {
      const conteudo = montarConteudoAgentsMd({
        repository: 'GitOrchAI/empty-pkg',
        rootItems: [{ name: 'package.json', type: 'file' }],
        docsItems: [],
        packageJson: {
          name: 'empty-pkg',
        },
      })

      expect(conteudo).toContain('não possui scripts executáveis configurados')
      expect(conteudo).not.toContain('npm run test')
    })
  })

  describe('verificarOuGerarAgentsMd', () => {
    describe('guarda na porta de saída (a credencial e o PUT nunca saem para outro destino)', () => {
      const maliciosos: Array<[string, string]> = [
        ['travessia com ..', 'dono/../repo'],
        ['dono ..', '../repo'],
        ['barra a mais (antes ignorada)', 'dono/repo/extra'],
        ['sem barra', 'so-um-nome'],
        ['arroba', 'dono@evil.com/repo'],
        ['dois-pontos', 'dono:8080/repo'],
        ['espaço', 'dono/re po'],
        ['barra codificada %2f', 'dono%2f..%2frepo/x'],
        ['host no nome', 'evil.com/https://api.github.com/repo'],
        ['vazio', ''],
        ['dono vazio', '/repo'],
      ]

      it.each(maliciosos)('%s: recusa sem chamar o fetch', async (_nome, repositoryMalicioso) => {
        const fetchMock = vi.fn()

        const resultado = await verificarOuGerarAgentsMd({
          repository: repositoryMalicioso,
          defaultBranch,
          token,
          fetchImpl: fetchMock as unknown as typeof fetch,
        })

        expect(resultado.existe).toBe(false)
        expect(resultado.criado).toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
      })

      it('toda chamada de um repositório válido vai para https://api.github.com/repos/dono/repo', async () => {
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'PUT') return new Response('{}', { status: 201 })
          return new Response('Not found', { status: 404 })
        })

        await verificarOuGerarAgentsMd({
          repository: 'dono/repo.js',
          defaultBranch: 'feat/x y',
          token,
          fetchImpl: fetchMock as unknown as typeof fetch,
        })

        expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
        for (const [url] of fetchMock.mock.calls) {
          const u = new URL(String(url))
          expect(u.protocol).toBe('https:')
          expect(u.host).toBe('api.github.com')
          expect(u.pathname.startsWith('/repos/dono/repo.js/contents')).toBe(true)
        }
      })
    })

    it('retorna { existe: true, criado: false } quando AGENTS.md já existe sem fazer PUT', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        const urlStr = String(url)
        if (urlStr.includes('/contents/AGENTS.md?ref=main')) {
          return new Response(JSON.stringify({ name: 'AGENTS.md', sha: 'abc123sha' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      expect(resultado).toEqual({ existe: true, criado: false })
      // Não deve ter feito PUT para criar arquivo
      const chamadasPut = fetchMock.mock.calls.filter(
        ([, init]) => init && (init as RequestInit).method === 'PUT'
      )
      expect(chamadasPut).toHaveLength(0)
    })

    it('gera AGENTS.md honesto em greenfield e comita via PUT na branch correta quando AGENTS.md é 404', async () => {
      let putBodyEnviado: { message: string; content: string; branch: string } | null = null

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url)
        const method = init?.method ?? 'GET'

        if (urlStr.includes('/contents/AGENTS.md?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents?ref=main') &&
          method === 'GET'
        ) {
          return new Response(JSON.stringify([{ name: 'README.md', type: 'file' }]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (urlStr.includes('/contents/docs?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents/AGENTS.md') &&
          method === 'PUT'
        ) {
          putBodyEnviado = JSON.parse(init?.body as string)
          return new Response(JSON.stringify({ content: { name: 'AGENTS.md' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      expect(resultado).toEqual({ existe: true, criado: true })
      expect(putBodyEnviado).not.toBeNull()
      expect(putBodyEnviado!.message).toBe(
        'docs(agents): adicionar AGENTS.md canônico para guiar automação do jules'
      )
      expect(putBodyEnviado!.branch).toBe('main')

      // Valida conteúdo gravado
      const conteudoDecodificado = Buffer.from(putBodyEnviado!.content, 'base64').toString('utf-8')
      expect(conteudoDecodificado).toContain('# AGENTS.md — GitOrchAI/autocandidata')
      expect(conteudoDecodificado).toContain('greenfield')
      expect(conteudoDecodificado).not.toContain('npm test')
    })

    it('lê scripts reais de package.json e documenta comandos reais quando package.json está presente', async () => {
      let putBodyEnviado: { message: string; content: string; branch: string } | null = null

      const packageJsonRaw = JSON.stringify({
        name: 'meu-projeto',
        scripts: {
          test: 'jest --ci',
          build: 'tsc -p tsconfig.json',
        },
      })
      const packageJsonBase64 = Buffer.from(packageJsonRaw).toString('base64')

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url)
        const method = init?.method ?? 'GET'

        if (urlStr.includes('/contents/AGENTS.md?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents?ref=main') &&
          method === 'GET'
        ) {
          return new Response(
            JSON.stringify([
              { name: 'package.json', type: 'file' },
              { name: 'package-lock.json', type: 'file' },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        if (urlStr.includes('/contents/package.json?ref=main') && method === 'GET') {
          return new Response(
            JSON.stringify({
              name: 'package.json',
              content: packageJsonBase64,
              encoding: 'base64',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        if (urlStr.includes('/contents/docs?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents/AGENTS.md') &&
          method === 'PUT'
        ) {
          putBodyEnviado = JSON.parse(init?.body as string)
          return new Response(JSON.stringify({ content: { name: 'AGENTS.md' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      expect(resultado).toEqual({ existe: true, criado: true })
      expect(putBodyEnviado).not.toBeNull()

      const conteudoDecodificado = Buffer.from(putBodyEnviado!.content, 'base64').toString('utf-8')
      expect(conteudoDecodificado).toContain('npm run test')
      expect(conteudoDecodificado).toContain('npm run build')
    })

    it('retorna { existe: false, criado: false, motivo } quando PUT falha com 403', async () => {
      const warnMock = vi.fn()

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url)
        const method = init?.method ?? 'GET'

        if (urlStr.includes('/contents/AGENTS.md?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents?ref=main') &&
          method === 'GET'
        ) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (urlStr.includes('/contents/docs?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents/AGENTS.md') &&
          method === 'PUT'
        ) {
          return new Response(
            JSON.stringify({ message: 'Resource not accessible by integration' }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
        onWarn: warnMock,
      })

      expect(resultado.existe).toBe(false)
      expect(resultado.criado).toBe(false)
      expect(resultado.motivo).toBeDefined()
      expect(resultado.motivo).toContain('403')
      expect(warnMock).toHaveBeenCalled()
    })

    it('retorna { existe: false, criado: false, motivo } quando GET de verificação falha com erro 403', async () => {
      const warnMock = vi.fn()

      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url)
        if (urlStr.includes('/contents/AGENTS.md?ref=main')) {
          return new Response(JSON.stringify({ message: 'Forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
        onWarn: warnMock,
      })

      expect(resultado.existe).toBe(false)
      expect(resultado.criado).toBe(false)
      expect(resultado.motivo).toContain('403')
      expect(warnMock).toHaveBeenCalled()
    })

    it('retorna { existe: false, criado: false, motivo } se repository não contiver barra', async () => {
      const warnMock = vi.fn()
      const resultado = await verificarOuGerarAgentsMd({
        repository: 'invalido-sem-barra',
        defaultBranch,
        token,
        onWarn: warnMock,
      })

      expect(resultado.existe).toBe(false)
      expect(resultado.criado).toBe(false)
      expect(resultado.motivo).toContain('formato inesperado')
      expect(warnMock).toHaveBeenCalled()
    })

    it('retorna { existe: false, criado: false, motivo } se fetch disparar exceção de rede', async () => {
      const warnMock = vi.fn()
      const fetchMock = vi.fn(async () => {
        throw new Error('Falha de conexão DNS')
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
        onWarn: warnMock,
      })

      expect(resultado.existe).toBe(false)
      expect(resultado.criado).toBe(false)
      expect(resultado.motivo).toContain('Falha de conexão DNS')
      expect(warnMock).toHaveBeenCalled()
    })

    it('inclui referências a docs/ quando o diretório docs existir', async () => {
      let putBodyEnviado: { message: string; content: string; branch: string } | null = null

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url)
        const method = init?.method ?? 'GET'

        if (urlStr.includes('/contents/AGENTS.md?ref=main') && method === 'GET') {
          return new Response('Not found', { status: 404 })
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents?ref=main') &&
          method === 'GET'
        ) {
          return new Response(
            JSON.stringify([
              { name: 'docs', type: 'dir' },
              { name: 'README.md', type: 'file' },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        if (urlStr.includes('/contents/docs?ref=main') && method === 'GET') {
          return new Response(
            JSON.stringify([
              { name: 'architecture.md', type: 'file' },
              { name: 'setup.md', type: 'file' },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        if (
          urlStr.endsWith('/repos/GitOrchAI/autocandidata/contents/AGENTS.md') &&
          method === 'PUT'
        ) {
          putBodyEnviado = JSON.parse(init?.body as string)
          return new Response(JSON.stringify({ content: { name: 'AGENTS.md' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response('Not found', { status: 404 })
      })

      const resultado = await verificarOuGerarAgentsMd({
        repository,
        defaultBranch,
        token,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      expect(resultado.existe).toBe(true)
      expect(resultado.criado).toBe(true)
      expect(putBodyEnviado).not.toBeNull()

      const decoded = Buffer.from(putBodyEnviado!.content, 'base64').toString('utf-8')
      expect(decoded).toContain('docs/architecture.md')
      expect(decoded).toContain('docs/setup.md')
    })
  })
})
