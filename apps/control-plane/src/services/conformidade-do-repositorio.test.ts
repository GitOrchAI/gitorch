import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  achadosDePii,
  conferirConformidade,
  escolherArquivosDeSchema,
  indiciosDePii,
  LICENCAS_EM_ATENCAO_PADRAO,
  licencasEmAtencaoDoProjeto,
  licencasProblematicas,
  listarLicencasPeloSbom,
  MAXIMO_DE_CARACTERES_DE_TEXTO,
  lerArquivosDeSchemaPelaApi,
} from './conformidade-do-repositorio.js'
import { criarGitHubFalso, shaDe, type RepositorioFalso } from '../test/github-de-seguranca-fake.js'

const REPO = 'dono/repo'

function repo(extra: Partial<RepositorioFalso> = {}): RepositorioFalso {
  return { protecao: 'sem-protecao', permissaoDoToken: 'read', arquivos: {}, sbom: null, ...extra }
}

describe('licencasProblematicas', () => {
  it('marca licenças copyleft fortes (GPL) como problemáticas; MIT/Apache/BSD não', () => {
    const r = licencasProblematicas(
      [
        { nome: 'left-pad', licenca: 'MIT' },
        { nome: 'algo-gpl', licenca: 'GPL-3.0' },
        { nome: 'algo-agpl', licenca: 'AGPL-3.0' },
      ],
      ['GPL-3.0', 'AGPL-3.0', 'AGPL-1.0']
    )
    expect(r.map((l) => l.nome)).toEqual(['algo-gpl', 'algo-agpl'])
  })

  it('a lista padrão pega as variantes SPDX de copyleft forte, e LGPL (fraco) não entra', () => {
    const achados = licencasProblematicas(
      [
        { nome: 'a', licenca: 'GPL-3.0-only' },
        { nome: 'b', licenca: 'GPL-2.0-or-later' },
        { nome: 'c', licenca: 'AGPL-3.0-only' },
        { nome: 'd', licenca: 'SSPL-1.0' },
        { nome: 'e', licenca: 'LicenseRef-Commons-Clause' },
        { nome: 'f', licenca: 'LGPL-3.0-or-later' },
        { nome: 'g', licenca: 'MPL-2.0' },
        { nome: 'h', licenca: 'GPL-2.0+' },
      ],
      [...LICENCAS_EM_ATENCAO_PADRAO]
    )
    expect(achados.map((l) => l.nome)).toEqual(['a', 'b', 'c', 'd', 'e', 'h'])
  })

  it('expressão SPDX: "GPL-3.0-only OR MIT" tem saída permissiva, "MIT AND GPL-3.0-only" não', () => {
    const achados = licencasProblematicas(
      [
        { nome: 'escolhivel', licenca: 'GPL-3.0-only OR MIT' },
        { nome: 'obrigatoria', licenca: 'MIT AND GPL-3.0-only' },
        { nome: 'entre-parenteses', licenca: '(MIT OR CC0-1.0)' },
        { nome: 'composta', licenca: 'Apache-2.0 OR (Apache-2.0 AND LGPL-3.0-only)' },
        { nome: 'so-copyleft', licenca: '(GPL-3.0-only OR AGPL-3.0-only)' },
      ],
      [...LICENCAS_EM_ATENCAO_PADRAO]
    )
    expect(achados.map((l) => l.nome)).toEqual(['obrigatoria', 'so-copyleft'])
  })

  it('lista de atenção vazia não marca nada', () => {
    expect(licencasProblematicas([{ nome: 'a', licenca: 'GPL-3.0-only' }], [])).toEqual([])
  })
})

describe('licencasEmAtencaoDoProjeto', () => {
  it('sem configuração: o padrão conservador de copyleft forte', () => {
    expect(licencasEmAtencaoDoProjeto(null)).toEqual([...LICENCAS_EM_ATENCAO_PADRAO])
    expect(licencasEmAtencaoDoProjeto({ outraCoisa: 1 })).toEqual([...LICENCAS_EM_ATENCAO_PADRAO])
    expect([...LICENCAS_EM_ATENCAO_PADRAO]).toEqual(
      expect.arrayContaining(['AGPL', 'GPL', 'SSPL', 'Commons-Clause'])
    )
  })

  it('usa a lista do projeto (runtime_config.licencasEmAtencao)', () => {
    expect(licencasEmAtencaoDoProjeto({ licencasEmAtencao: ['EUPL', 'MPL-2.0'] })).toEqual([
      'EUPL',
      'MPL-2.0',
    ])
  })

  it('lista inválida volta ao padrão e avisa; lista vazia é escolha válida (nada em atenção)', () => {
    const avisos: string[] = []
    expect(licencasEmAtencaoDoProjeto({ licencasEmAtencao: 'GPL' }, (m) => avisos.push(m))).toEqual(
      [...LICENCAS_EM_ATENCAO_PADRAO]
    )
    expect(avisos).toHaveLength(1)
    expect(
      licencasEmAtencaoDoProjeto({ licencasEmAtencao: [1, ''] }, (m) => avisos.push(m))
    ).toEqual([...LICENCAS_EM_ATENCAO_PADRAO])
    expect(licencasEmAtencaoDoProjeto({ licencasEmAtencao: [] })).toEqual([])
  })
})

/** Chamadas a `require(...)` de verdade no código (comentário e texto não contam). */
function chamadasAoRequire(arquivo: string): number {
  const caminho = join(dirname(fileURLToPath(import.meta.url)), arquivo)
  const fonte = ts.createSourceFile(
    arquivo,
    readFileSync(caminho, 'utf-8'),
    ts.ScriptTarget.ES2022,
    true
  )
  let total = 0
  const visitar = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isIdentifier(no.expression) &&
      no.expression.text === 'require'
    ) {
      total += 1
    }
    ts.forEachChild(no, visitar)
  }
  visitar(fonte)
  return total
}

describe('listarLicencasViaPnpm (quebrada: usava require num pacote ESM)', () => {
  // Em Node ESM, `require` não existe: a versão antiga lançava
  // "ReferenceError: require is not defined" ao ser chamada. O vitest injeta um
  // `require` próprio, então a prova no teste é estrutural.
  it('nenhum arquivo da nota e da conformidade chama require() (o pacote é ESM)', () => {
    expect(chamadasAoRequire('conformidade-do-repositorio.ts')).toBe(0)
    expect(chamadasAoRequire('nota-de-seguranca.ts')).toBe(0)
  })

  it('não existe mais: a fonte das licenças é o SBOM pela API, sem clonar o repositório do cliente', async () => {
    const modulo = await import('./conformidade-do-repositorio.js')
    expect('listarLicencasViaPnpm' in modulo).toBe(false)
  })
})

describe('listarLicencasPeloSbom', () => {
  async function ler(config: RepositorioFalso) {
    const github = criarGitHubFalso({ [REPO]: config })
    const leitura = await listarLicencasPeloSbom({
      repository: REPO,
      token: 't',
      fetchImpl: github.fetchFalso,
    })()
    return { leitura, ...github }
  }

  it('lê os pacotes e a licença concluída, sem contar o próprio repositório nem as Actions', async () => {
    const { leitura } = await ler(
      repo({
        sbom: [
          { name: 'left-pad', licenca: 'MIT' },
          { name: 'sem-licenca', licenca: null },
        ],
      })
    )
    expect(leitura).toEqual({
      tipo: 'lido',
      pacotes: [
        { nome: 'left-pad', licenca: 'MIT' },
        { nome: 'sem-licenca', licenca: null },
      ],
    })
  })

  it('NOASSERTION é "sem licença declarada" (null), não uma licença', async () => {
    const { leitura } = await ler(repo({ sbom: [{ name: 'x', licenca: 'NOASSERTION' }] }))
    expect(leitura).toEqual({ tipo: 'lido', pacotes: [{ nome: 'x', licenca: null }] })
  })

  it('404 (repositório sem o grafo de dependências): indisponível com motivo, NUNCA lista vazia', async () => {
    const { leitura } = await ler(repo({ sbom: null }))
    expect(leitura.tipo).toBe('indisponivel')
    if (leitura.tipo === 'indisponivel') expect(leitura.motivo).toContain('404')
  })

  it('erro de rede ou resposta sem pacotes: indisponível', async () => {
    const quebrado = (async () => {
      throw new Error('rede caiu')
    }) as typeof fetch
    const rede = await listarLicencasPeloSbom({
      repository: REPO,
      token: 't',
      fetchImpl: quebrado,
    })()
    expect(rede.tipo).toBe('indisponivel')

    const semPacotes = (async () =>
      new Response('{"sbom":{}}', { status: 200 })) as unknown as typeof fetch
    const vazio = await listarLicencasPeloSbom({
      repository: REPO,
      token: 't',
      fetchImpl: semPacotes,
    })()
    expect(vazio.tipo).toBe('indisponivel')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['texto', 'rede caiu'],
  ])('a rede lançando %s (não-Error): indisponível, sem lançar', async (_nome, lancado) => {
    const quebrado = (async () => {
      throw lancado
    }) as typeof fetch
    const leitura = await listarLicencasPeloSbom({
      repository: REPO,
      token: 'tok-secreto-123',
      fetchImpl: quebrado,
    })()
    expect(leitura.tipo).toBe('indisponivel')
  })

  it('repositório com formato inválido não faz chamada', async () => {
    const github = criarGitHubFalso({})
    const leitura = await listarLicencasPeloSbom({
      repository: '../x',
      token: 't',
      fetchImpl: github.fetchFalso,
    })()
    expect(leitura.tipo).toBe('indisponivel')
    expect(github.chamadas).toEqual([])
  })
})

describe('achadosDePii e indiciosDePii', () => {
  it('acha padrão de CPF em migração/schema', () => {
    const achados = achadosDePii('CREATE TABLE clientes (cpf TEXT, telefone TEXT)')
    expect(achados.some((a) => a.includes('cpf'))).toBe(true)
  })
  it('schema sem sinal de PII: lista vazia', () => {
    expect(achadosDePii('CREATE TABLE eventos (id TEXT, payload JSONB)')).toEqual([])
  })

  it('conta ocorrências e arquivos por padrão, como indício informativo', () => {
    const indicios = indiciosDePii([
      { caminho: 'prisma/schema.prisma', conteudo: 'model U {\n email String\n phone String\n}' },
      { caminho: 'prisma/a-migration.sql', conteudo: 'ALTER TABLE u ADD email text; -- email' },
    ])
    expect(indicios).toEqual(
      expect.arrayContaining([
        { padrao: 'e-mail', ocorrencias: 3, arquivos: 2 },
        { padrao: 'telefone', ocorrencias: 1, arquivos: 1 },
      ])
    )
    expect(indicios.find((i) => i.padrao === 'cpf')).toBeUndefined()
  })
})

describe('escolherArquivosDeSchema', () => {
  const entrada = (path: string, size = 100) => ({ path, type: 'blob', sha: path, size })

  it('escolhe no máximo 3: o schema primeiro, depois as migrações mais novas; ignora node_modules e arquivos grandes', () => {
    const escolhidos = escolherArquivosDeSchema(
      {
        entradas: [
          entrada('node_modules/x/schema.prisma'),
          entrada('prisma/schema.prisma'),
          entrada('prisma/migrations/20240101_a/migration.sql'),
          entrada('prisma/migrations/20250101_b/migration.sql'),
          entrada('prisma/migrations/20260101_c/migration.sql'),
          entrada('prisma/grande-migration.sql', 5_000_000),
          entrada('README.md'),
        ],
        truncada: false,
      },
      3
    )
    expect(escolhidos.map((e) => e.path)).toEqual([
      'prisma/schema.prisma',
      'prisma/migrations/20260101_c/migration.sql',
      'prisma/migrations/20250101_b/migration.sql',
    ])
  })

  it('sem candidatos: lista vazia', () => {
    expect(escolherArquivosDeSchema({ entradas: [entrada('a.ts')], truncada: false }, 3)).toEqual(
      []
    )
  })
})

describe('lerArquivosDeSchemaPelaApi', () => {
  it('baixa no máximo 3 blobs pela API', async () => {
    const arquivos: Record<string, string> = { 'prisma/schema.prisma': 'model U { email String }' }
    for (let i = 0; i < 6; i += 1) {
      arquivos[`prisma/migrations/2026010${i}_x/migration.sql`] = `ALTER TABLE t${i} ADD cpf text;`
    }
    const github = criarGitHubFalso({ [REPO]: repo({ arquivos }) })
    const arvore = {
      entradas: Object.entries(arquivos).map(([path, conteudo]) => ({
        path,
        type: 'blob',
        sha: shaDe(conteudo),
        size: conteudo.length,
      })),
      truncada: false,
    }
    const leitura = await lerArquivosDeSchemaPelaApi({
      repository: REPO,
      token: 't',
      fetchImpl: github.fetchFalso,
      arvore,
    })()
    expect(leitura.tipo).toBe('lido')
    expect(github.chamadas.filter((c) => c.includes('/git/blobs/'))).toHaveLength(3)
    if (leitura.tipo === 'lido') expect(leitura.arquivos).toHaveLength(3)
  })

  it('sem árvore: indisponível; todos os blobs falhando: indisponível (não "sem indícios")', async () => {
    const github = criarGitHubFalso({ [REPO]: repo() })
    const semArvore = await lerArquivosDeSchemaPelaApi({
      repository: REPO,
      token: 't',
      fetchImpl: github.fetchFalso,
      arvore: null,
    })()
    expect(semArvore.tipo).toBe('indisponivel')

    const falhando = await lerArquivosDeSchemaPelaApi({
      repository: REPO,
      token: 't',
      fetchImpl: github.fetchFalso,
      arvore: {
        entradas: [{ path: 'prisma/schema.prisma', type: 'blob', sha: 'f'.repeat(40), size: 10 }],
        truncada: false,
      },
    })()
    expect(falhando.tipo).toBe('indisponivel')
  })

  it('árvore sem arquivo de schema: lido, com zero arquivos (nada a olhar não é falha)', async () => {
    const github = criarGitHubFalso({ [REPO]: repo() })
    const leitura = await lerArquivosDeSchemaPelaApi({
      repository: REPO,
      token: 't',
      fetchImpl: github.fetchFalso,
      arvore: { entradas: [{ path: 'a.ts', type: 'blob', sha: 'a', size: 1 }], truncada: false },
    })()
    expect(leitura).toEqual({ tipo: 'lido', arquivos: [] })
    expect(github.chamadas).toEqual([])
  })
})

describe('conferirConformidade', () => {
  const lidoSemNada = async () => ({ tipo: 'lido' as const, arquivos: [] })

  it('junta licenças em atenção, indícios de PII e os achados de documento/Actions injetados', async () => {
    const resultado = await conferirConformidade({
      listarLicencas: async () => ({
        tipo: 'lido',
        pacotes: [
          { nome: 'pacote-gpl', licenca: 'GPL-3.0-only' },
          { nome: 'ok', licenca: 'MIT' },
          { nome: 'sem', licenca: null },
        ],
      }),
      licencasEmAtencao: [...LICENCAS_EM_ATENCAO_PADRAO],
      lerArquivosDeSchema: async () => ({
        tipo: 'lido',
        arquivos: [{ caminho: 'schema.prisma', conteudo: 'email String' }],
      }),
      codeownersAusente: true,
      securityMdAusente: false,
      actionsSemSha: true,
    })
    expect(resultado.licencas).toEqual({
      estado: 'verificado',
      total: 3,
      semLicenca: 1,
      emAtencaoTotal: 1,
      emAtencaoOmitidas: 0,
      emAtencao: [{ nome: 'pacote-gpl', licenca: 'GPL-3.0-only' }],
      listaUsada: [...LICENCAS_EM_ATENCAO_PADRAO],
    })
    expect(resultado.indiciosDePii).toEqual({
      estado: 'verificado',
      arquivosLidos: ['schema.prisma'],
      indicios: [{ padrao: 'e-mail', ocorrencias: 1, arquivos: 1 }],
    })
    expect(resultado.codeownersAusente).toBe(true)
    expect(resultado.securityMdAusente).toBe(false)
    expect(resultado.actionsSemSha).toBe(true)
  })

  it('licenças indisponíveis viram "não verificado" com motivo: nunca zero em atenção', async () => {
    const resultado = await conferirConformidade({
      listarLicencas: async () => ({ tipo: 'indisponivel', motivo: 'o GitHub respondeu 404' }),
      licencasEmAtencao: ['GPL'],
      lerArquivosDeSchema: lidoSemNada,
      codeownersAusente: false,
      securityMdAusente: false,
      actionsSemSha: false,
    })
    expect(resultado.licencas).toEqual({
      estado: 'nao-verificado',
      motivo: 'o GitHub respondeu 404',
    })
    expect(JSON.stringify(resultado.licencas)).not.toContain('emAtencao')
  })

  it('uma leitura que lança vira "não verificado", sem derrubar a conferência', async () => {
    const resultado = await conferirConformidade({
      listarLicencas: async () => {
        throw new Error('explodiu')
      },
      licencasEmAtencao: ['GPL'],
      lerArquivosDeSchema: async () => {
        throw new Error('explodiu também')
      },
      codeownersAusente: null,
      securityMdAusente: null,
      actionsSemSha: null,
    })
    expect(resultado.licencas.estado).toBe('nao-verificado')
    expect(resultado.indiciosDePii.estado).toBe('nao-verificado')
    expect(resultado.codeownersAusente).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['texto', 'explodiu'],
    ['objeto sem message', { codigo: 'E1' }],
    ['símbolo', Symbol('s')],
  ])(
    'uma leitura que lança %s (não-Error) também vira "não verificado", sem derrubar a conferência',
    async (_nome, lancado) => {
      const resultado = await conferirConformidade({
        listarLicencas: async () => {
          throw lancado
        },
        licencasEmAtencao: ['GPL'],
        lerArquivosDeSchema: async () => {
          throw lancado
        },
        codeownersAusente: null,
        securityMdAusente: null,
        actionsSemSha: null,
      })
      expect(resultado.licencas.estado).toBe('nao-verificado')
      expect(resultado.indiciosDePii.estado).toBe('nao-verificado')
    }
  )

  it('guarda no máximo 200 pacotes em atenção, mas conta todos', async () => {
    const pacotes = Array.from({ length: 250 }, (_, n) => ({
      nome: `p${String(n).padStart(3, '0')}`,
      licenca: 'GPL-3.0-only',
    }))
    const resultado = await conferirConformidade({
      listarLicencas: async () => ({ tipo: 'lido', pacotes }),
      licencasEmAtencao: ['GPL'],
      lerArquivosDeSchema: lidoSemNada,
      codeownersAusente: false,
      securityMdAusente: false,
      actionsSemSha: false,
    })
    if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
    expect(resultado.licencas.emAtencaoTotal).toBe(250)
    expect(resultado.licencas.emAtencao).toHaveLength(200)
  })
  describe('limite de tamanho do que vai para a ficha', () => {
    const lidoSemNada = async () => ({ tipo: 'lido' as const, arquivos: [] })
    const base = {
      licencasEmAtencao: ['GPL'],
      lerArquivosDeSchema: lidoSemNada,
      codeownersAusente: false,
      securityMdAusente: false,
      actionsSemSha: false,
    }

    it('o limite de cada texto é de 200 caracteres', () => {
      expect(MAXIMO_DE_CARACTERES_DE_TEXTO).toBe(200)
    })

    it('nome e licença de pacote em atenção são cortados em 200 caracteres', async () => {
      const resultado = await conferirConformidade({
        ...base,
        listarLicencas: async () => ({
          tipo: 'lido',
          pacotes: [
            { nome: 'n'.repeat(500), licenca: `GPL-3.0-only AND LicenseRef-${'x'.repeat(500)}` },
          ],
        }),
      })
      if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
      expect(resultado.licencas.emAtencaoTotal).toBe(1)
      const [item] = resultado.licencas.emAtencao
      expect(item?.nome).toHaveLength(MAXIMO_DE_CARACTERES_DE_TEXTO)
      expect(item?.licenca).toHaveLength(MAXIMO_DE_CARACTERES_DE_TEXTO)
      expect(item?.nome.endsWith('…')).toBe(true)
    })

    it('registra quantos pacotes em atenção ficaram de fora da lista guardada', async () => {
      const pacotes = Array.from({ length: 250 }, (_, n) => ({
        nome: `p${String(n).padStart(3, '0')}`,
        licenca: 'GPL-3.0-only',
      }))
      const resultado = await conferirConformidade({
        ...base,
        listarLicencas: async () => ({ tipo: 'lido', pacotes }),
      })
      if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
      expect(resultado.licencas.emAtencao).toHaveLength(200)
      expect(resultado.licencas.emAtencaoOmitidas).toBe(50)
    })

    it('sem excesso, nada é omitido', async () => {
      const resultado = await conferirConformidade({
        ...base,
        listarLicencas: async () => ({
          tipo: 'lido',
          pacotes: [{ nome: 'a', licenca: 'GPL-3.0-only' }],
        }),
      })
      if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
      expect(resultado.licencas.emAtencaoOmitidas).toBe(0)
    })

    it('o motivo de "não verificado" (licenças e schema) é cortado em 200 caracteres', async () => {
      const resultado = await conferirConformidade({
        ...base,
        listarLicencas: async () => {
          throw new Error('e'.repeat(1000))
        },
        lerArquivosDeSchema: async () => ({ tipo: 'indisponivel', motivo: 'm'.repeat(1000) }),
      })
      if (resultado.licencas.estado !== 'nao-verificado') throw new Error('esperava não verificado')
      if (resultado.indiciosDePii.estado !== 'nao-verificado')
        throw new Error('esperava não verificado')
      expect(resultado.licencas.motivo.length).toBeLessThanOrEqual(MAXIMO_DE_CARACTERES_DE_TEXTO)
      expect(resultado.indiciosDePii.motivo.length).toBeLessThanOrEqual(
        MAXIMO_DE_CARACTERES_DE_TEXTO
      )
    })

    describe('texto de fora com caractere astral (emoji) e surrogate solto', () => {
      const EMOJI = '\u{1F600}'
      const solto = (t: string) =>
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t)

      it('emoji nas posições 198-199 do nome, da licença, do motivo e do caminho: nenhum surrogate solto', async () => {
        const comEmojiNaFronteira = `${'n'.repeat(198)}${EMOJI}${'z'.repeat(40)}`
        const resultado = await conferirConformidade({
          ...base,
          listarLicencas: async () => ({
            tipo: 'lido',
            pacotes: [
              { nome: comEmojiNaFronteira, licenca: `GPL-3.0-only AND ${comEmojiNaFronteira}` },
            ],
          }),
          lerArquivosDeSchema: async () => ({
            tipo: 'lido',
            arquivos: [{ caminho: comEmojiNaFronteira, conteudo: '' }],
          }),
        })
        if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
        if (resultado.indiciosDePii.estado !== 'verificado') throw new Error('esperava verificado')
        const [item] = resultado.licencas.emAtencao
        const textos = [
          item?.nome ?? '',
          item?.licenca ?? '',
          resultado.indiciosDePii.arquivosLidos[0] ?? '',
        ]
        for (const texto of textos) {
          expect(solto(texto)).toBe(false)
          expect(Array.from(texto).length).toBeLessThanOrEqual(MAXIMO_DE_CARACTERES_DE_TEXTO)
        }
        expect(item?.nome).toBe(`${'n'.repeat(198)}${EMOJI}…`)
        expect(solto(JSON.stringify(resultado))).toBe(false)
        expect(JSON.stringify(resultado)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
      })

      it('motivo de falha com emoji na fronteira também sai bem formado', async () => {
        const mensagem = `${'e'.repeat(198 - 'falha ao ler as licenças ('.length)}${EMOJI}${'f'.repeat(300)}`
        const resultado = await conferirConformidade({
          ...base,
          listarLicencas: async () => {
            throw new Error(mensagem)
          },
        })
        if (resultado.licencas.estado !== 'nao-verificado')
          throw new Error('esperava não verificado')
        expect(solto(resultado.licencas.motivo)).toBe(false)
        expect(resultado.licencas.motivo).toContain(EMOJI)
      })

      it('surrogate solto que já vem no texto de fora é removido antes de ir para a ficha', async () => {
        const resultado = await conferirConformidade({
          ...base,
          listarLicencas: async () => ({
            tipo: 'lido',
            pacotes: [{ nome: 'pacote\uD83D', licenca: 'GPL-3.0-only\uDE00' }],
          }),
        })
        if (resultado.licencas.estado !== 'verificado') throw new Error('esperava verificado')
        expect(solto(JSON.stringify(resultado.licencas))).toBe(false)
        expect(resultado.licencas.emAtencao[0]?.nome).toBe('pacote\uFFFD')
      })
    })

    it('os caminhos dos arquivos de schema lidos são cortados em 200 caracteres', async () => {
      const resultado = await conferirConformidade({
        ...base,
        listarLicencas: async () => ({ tipo: 'lido', pacotes: [] }),
        lerArquivosDeSchema: async () => ({
          tipo: 'lido',
          arquivos: [{ caminho: `${'d/'.repeat(300)}schema.prisma`, conteudo: '' }],
        }),
      })
      if (resultado.indiciosDePii.estado !== 'verificado') throw new Error('esperava verificado')
      expect(resultado.indiciosDePii.arquivosLidos[0]).toHaveLength(MAXIMO_DE_CARACTERES_DE_TEXTO)
    })
  })
})
