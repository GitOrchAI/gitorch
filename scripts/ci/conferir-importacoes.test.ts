import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const FERRAMENTA = join(__dirname, 'conferir-importacoes.mjs')
const pastas: string[] = []

afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true })
})

/** Monta um repositório mínimo: `arquivos` mapeia caminho relativo -> conteúdo. */
function monta(arquivos: Record<string, string>): string {
  const raiz = mkdtempSync(join(tmpdir(), 'conferir-importacoes-'))
  pastas.push(raiz)
  for (const [caminho, conteudo] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(raiz, caminho)), { recursive: true })
    writeFileSync(join(raiz, caminho), conteudo)
  }
  return raiz
}

function roda(raiz: string, ...args: string[]) {
  const r = spawnSync('node', [FERRAMENTA, ...args], { cwd: raiz, encoding: 'utf8' })
  return { status: r.status, saida: `${r.stdout}${r.stderr}` }
}

const pacote = (deps: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: '@x/servico', dependencies: deps, ...extra })

describe('conferir-importacoes', () => {
  it('acusa pacote importado e não declarado, com arquivo:linha', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/telemetria.ts': "import a from './a.js'\nimport client from 'prom-client'\n",
    })
    const r = roda(raiz, 'app')
    expect(r.status).toBe(1)
    expect(r.saida).toContain('prom-client')
    expect(r.saida).toContain('src/telemetria.ts:2')
  })

  it('passa quando o pacote está declarado em dependencies, optionalDependencies ou peerDependencies', () => {
    const raiz = monta({
      'app/package.json': pacote(
        { zod: '1' },
        { optionalDependencies: { fsevents: '1' }, peerDependencies: { react: '1' } }
      ),
      'app/src/a.ts':
        "import { z } from 'zod'\nimport 'fsevents'\nexport * from 'react/jsx-runtime'\nconst x = require('zod/v4')\n",
    })
    const r = roda(raiz, 'app')
    expect(r.saida).not.toContain('NÃO DECLARADAS')
    expect(r.status).toBe(0)
  })

  it('reduz o especificador ao nome do pacote (com escopo e subcaminho)', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/a.ts': "import x from '@fastify/cookie/dist/x.js'\nimport y from 'lodash/get'\n",
    })
    const r = roda(raiz, 'app')
    expect(r.status).toBe(1)
    expect(r.saida).toContain('@fastify/cookie')
    expect(r.saida).toContain('lodash')
    expect(r.saida).not.toContain('lodash/get')
  })

  it('pega export from, require e import() com literal', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/a.ts':
        "export { z } from 'pkg-a'\nconst b = require('pkg-b')\nconst c = await import('pkg-c')\n",
    })
    const r = roda(raiz, 'app')
    expect(r.status).toBe(1)
    for (const n of ['pkg-a', 'pkg-b', 'pkg-c']) expect(r.saida).toContain(n)
  })

  it('ignora import type, export type, relativos, absolutos, node: e módulos embutidos', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/a.ts': [
        "import type { T } from 'so-tipo'",
        "import { type U } from 'so-tipo-2'",
        "export type { V } from 'so-tipo-3'",
        "import fs from 'node:fs'",
        "import path from 'path'",
        "import { x } from './x.js'",
        "import { y } from '../y.js'",
        "import { w } from '/abs/w.js'",
        "import { s } from '#interno'",
        'const dinamico = await import(`pkg-${nome}`)',
        '',
      ].join('\n'),
    })
    const r = roda(raiz, 'app')
    expect(r.saida).not.toContain('so-tipo')
    expect(r.status).toBe(0)
  })

  it('ignora arquivos de teste, pastas de teste e comentários', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/a.test.ts': "import 'so-no-teste'\n",
      'app/src/b.spec.ts': "import 'so-no-spec'\n",
      'app/src/test/c.ts': "import 'pasta-test'\n",
      'app/src/__tests__/d.ts': "import 'pasta-tests'\n",
      'app/src/e2e/e.ts': "import 'pasta-e2e'\n",
      'app/src/f.ts': "// import x from 'em-comentario'\nexport const a = 1\n",
    })
    const r = roda(raiz, 'app')
    expect(r.saida).not.toMatch(/so-no-|pasta-|em-comentario/)
    expect(r.status).toBe(0)
  })

  it('varre prisma/seed.ts quando existe', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/prisma/seed.ts': "import { P } from 'cliente-do-seed'\n",
    })
    const r = roda(raiz, 'app')
    expect(r.status).toBe(1)
    expect(r.saida).toContain('cliente-do-seed')
    expect(r.saida).toContain('prisma/seed.ts:1')
  })

  it('não conta o próprio pacote como não declarado', () => {
    const raiz = monta({
      'app/package.json': pacote({}),
      'app/src/a.ts': "import x from '@x/servico/sub'\n",
    })
    expect(roda(raiz, 'app').status).toBe(0)
  })

  it('com --transitivo, confere também os pacotes do monorepo declarados com workspace:', () => {
    const raiz = monta({
      'app/package.json': pacote({ '@x/lib': 'workspace:*' }),
      'app/src/a.ts': "import '@x/lib'\n",
      'packages/lib/package.json': JSON.stringify({ name: '@x/lib', dependencies: {} }),
      'packages/lib/src/index.ts': "import 'esquecida-na-lib'\n",
    })
    expect(roda(raiz, 'app').status).toBe(0)
    const r = roda(raiz, '--transitivo', 'app')
    expect(r.status).toBe(1)
    expect(r.saida).toContain('esquecida-na-lib')
    expect(r.saida).toContain('packages/lib/src/index.ts:1')
  })
})
