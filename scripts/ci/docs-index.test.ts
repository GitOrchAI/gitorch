import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it, test } from 'vitest'

// Regressao da issue #616, dois defeitos que se escondiam um atras do outro:
//
// 1. `.gitignore` ignorava `docs/` inteiro desde o commit inicial. Arquivo ja
//    rastreado continuava rastreado, mas documento NOVO em `docs/` nascia
//    invisivel: fora do `git status`, fora do `git add .`, fora do commit.
// 2. `docs/README.md` ("o mapa oficial") apontava para 46 arquivos que nunca
//    existiram neste repositorio, e nao listava metade dos que existem.
//
// Os testes abaixo barram as duas coisas de voltarem em silencio.

const INDICE = 'docs/README.md'

// Links relativos em markdown: `[texto](./caminho.md)` ou `(../caminho.md)`.
// Ancora (`#secao`) e ignorada; link externo (http) nao e alvo deste teste.
function linksRelativos(markdown: string): string[] {
  const links: string[] = []
  for (const m of markdown.matchAll(/\]\((\.{1,2}\/[^)\s#]+)(?:#[^)]*)?\)/g)) {
    links.push(m[1])
  }
  return links
}

function linksQuebrados(
  indice: string,
  markdown: string,
  existe: (caminho: string) => boolean
): string[] {
  return linksRelativos(markdown)
    .map((link) => normalize(join(dirname(indice), link)))
    .filter((caminho) => !existe(caminho))
}

function gitIgnora(caminho: string): boolean {
  // `check-ignore` sai 0 quando o caminho E ignorado, 1 quando nao e.
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', caminho])
  return r.status === 0
}

function docsRastreados(): string[] {
  const r = spawnSync('git', ['ls-files', '--', 'docs/*.md'], { encoding: 'utf8' })
  return r.stdout.split('\n').filter((l) => l && l !== INDICE)
}

describe('linksQuebrados (o detector em si)', () => {
  it('acusa link para arquivo que nao existe', () => {
    const md = '1. [Fantasma](./product/mvp.md)'
    expect(linksQuebrados(INDICE, md, () => false)).toEqual(['docs/product/mvp.md'])
  })

  it('acusa link que sobe para fora de docs/ e nao existe', () => {
    const md = '[x](../packages/nao-existe/README.md)'
    expect(linksQuebrados(INDICE, md, () => false)).toEqual(['packages/nao-existe/README.md'])
  })

  it('acusa o arquivo mesmo quando o link tem ancora', () => {
    const md = '[x](./agents/sumiu.md#secao)'
    expect(linksQuebrados(INDICE, md, () => false)).toEqual(['docs/agents/sumiu.md'])
  })

  it('nao confunde link externo com link relativo', () => {
    expect(linksRelativos('[x](https://example.com/a.md)')).toEqual([])
  })
})

test('nenhum link relativo de docs/README.md aponta para arquivo que nao existe', () => {
  const quebrados = linksQuebrados(INDICE, readFileSync(INDICE, 'utf8'), existsSync)
  expect(quebrados, 'o indice aponta para arquivos que nao existem').toEqual([])
})

test('todo documento versionado em docs/ esta linkado no indice (regra 4)', () => {
  const linkados = new Set(
    linksRelativos(readFileSync(INDICE, 'utf8')).map((l) => normalize(join(dirname(INDICE), l)))
  )
  const rastreados = docsRastreados()
  expect(rastreados.length).toBeGreaterThan(0)
  const orfaos = rastreados.filter((doc) => !linkados.has(doc))
  expect(orfaos, 'documentos em docs/ que o indice nao lista').toEqual([])
})

test.each(['docs/qualquer-coisa-nova.md', 'docs/agents/qualquer-coisa-nova.md'])(
  '%s nao e ignorado pelo git: documento novo tem que aparecer no git status',
  (caminho) => {
    expect(gitIgnora(caminho)).toBe(false)
  }
)

test('o detector de ignore funciona: artefato de build continua ignorado', () => {
  // Sem este controle, um `gitIgnora` quebrado que sempre devolve false
  // faria o teste acima passar sem provar nada.
  expect(gitIgnora('dist/qualquer.js')).toBe(true)
})
