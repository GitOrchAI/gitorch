#!/usr/bin/env node
//
// Confere se todo pacote externo que o código de PRODUÇÃO de um pacote do
// monorepo importa está declarado no `package.json` DELE.
//
// Por que existe: o pnpm instala cada pacote com as dependências que ele
// declara. Uma importação sem declaração funciona no checkout (o pacote da
// raiz "vaza" por içamento) e some no pacote da versão, que só leva o fecho das
// dependências declaradas. O serviço então morre ao subir com
// `ERR_MODULE_NOT_FOUND`. Aqui o defeito é barrado no PR.
//
// Uso:  node scripts/ci/conferir-importacoes.mjs [--transitivo] <pasta-do-pacote>...
//   - o caminho é relativo ao diretório atual (a raiz do repositório);
//   - --transitivo: confere também os pacotes de `packages/*` que o pacote
//     declara com `workspace:` (e os que esses declaram, e assim por diante).
//
// O que é varrido: `src/**/*.{ts,tsx,js,mjs,cjs}` e `prisma/seed.ts`, sem
// arquivos de teste (`*.test.*`, `*.spec.*`), sem pastas `test`, `tests`,
// `__tests__`, `__fixtures__` e `e2e`, e sem `.d.ts`. Contam `import … from`,
// `import '…'`, `export … from`, `import x = require()`, `require('…')` e
// `import('…')` com literal. Não contam: `import type`/`export type` (tipo não
// existe em execução), relativos, absolutos, `#subcaminho`, `node:` e os
// módulos embutidos do Node.
//
// Sai com 1 e lista pacote, arquivo:linha de um uso e o `package.json` que
// deveria declarar, quando houver importação não declarada.
import fs from 'node:fs'
import path from 'node:path'
import { importacoesDe, nomeDoPacote } from './importacoes-lib.mjs'

const EXTENSOES = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const PASTAS_DE_TESTE = new Set(['test', 'tests', '__tests__', '__fixtures__', 'e2e'])
const PASTAS_IGNORADAS = new Set(['node_modules', 'dist', '.git'])
const NOME_DE_TESTE = /\.(test|spec)\.[^/]+$/

const argumentos = process.argv.slice(2)
const transitivo = argumentos.includes('--transitivo')
const pastasPedidas = argumentos.filter((a) => a !== '--transitivo')
if (pastasPedidas.length === 0) {
  console.error('uso: conferir-importacoes.mjs [--transitivo] <pasta-do-pacote>...')
  process.exit(2)
}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
  } catch (erro) {
    throw new Error(`não foi possível ler ${arquivo}: ${erro.message}`)
  }
}

function arquivosDeProducao(pasta) {
  const achados = []
  const percorre = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (PASTAS_IGNORADAS.has(e.name) || PASTAS_DE_TESTE.has(e.name)) continue
        percorre(caminho)
      } else if (
        e.isFile() &&
        EXTENSOES.has(path.extname(e.name)) &&
        !NOME_DE_TESTE.test(e.name) &&
        !e.name.endsWith('.d.ts')
      ) {
        achados.push(caminho)
      }
    }
  }
  if (fs.existsSync(path.join(pasta, 'src'))) percorre(path.join(pasta, 'src'))
  const seed = path.join(pasta, 'prisma', 'seed.ts')
  if (fs.existsSync(seed)) achados.push(seed)
  return achados.sort()
}

const raiz = process.cwd()

/** Mapa nome -> pasta de cada pacote de `packages/*` (para o modo --transitivo). */
function pacotesDoMonorepo() {
  const mapa = new Map()
  const base = path.join(raiz, 'packages')
  if (!fs.existsSync(base)) return mapa
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const manifesto = path.join(base, e.name, 'package.json')
    if (e.isDirectory() && fs.existsSync(manifesto)) {
      mapa.set(lerJson(manifesto).name, path.join('packages', e.name))
    }
  }
  return mapa
}

function expande(pastas) {
  if (!transitivo) return pastas
  const monorepo = pacotesDoMonorepo()
  const vistas = new Set()
  const fila = [...pastas]
  while (fila.length > 0) {
    const pasta = fila.shift()
    if (vistas.has(pasta)) continue
    vistas.add(pasta)
    const deps = lerJson(path.join(raiz, pasta, 'package.json')).dependencies ?? {}
    for (const [nome, versao] of Object.entries(deps)) {
      const destino = monorepo.get(nome)
      if (String(versao).startsWith('workspace:') && destino) fila.push(destino)
    }
  }
  return [...vistas]
}

let totalFaltando = 0
let totalArquivos = 0
for (const pasta of expande(pastasPedidas)) {
  const manifesto = lerJson(path.join(raiz, pasta, 'package.json'))
  const declaradas = new Set([
    ...Object.keys(manifesto.dependencies ?? {}),
    ...Object.keys(manifesto.optionalDependencies ?? {}),
    ...Object.keys(manifesto.peerDependencies ?? {}),
  ])
  const faltando = new Map() // pacote -> "arquivo:linha" do primeiro uso
  const arquivos = arquivosDeProducao(path.join(raiz, pasta))
  totalArquivos += arquivos.length
  for (const arquivo of arquivos) {
    for (const { especificador, linha } of importacoesDe(arquivo).importacoes) {
      const nome = nomeDoPacote(especificador)
      if (!nome || nome === manifesto.name || declaradas.has(nome) || faltando.has(nome)) continue
      faltando.set(nome, `${path.relative(raiz, arquivo).split(path.sep).join('/')}:${linha}`)
    }
  }
  if (faltando.size === 0) {
    console.log(`[importações] ${pasta}: ok (${arquivos.length} arquivos)`)
    continue
  }
  totalFaltando += faltando.size
  console.log(`[importações] ${pasta}: NÃO DECLARADAS em ${pasta}/package.json:`)
  for (const [nome, uso] of [...faltando].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${nome}  (usado em ${uso})`)
  }
}

if (totalFaltando > 0) {
  console.error(
    `[importações] ${totalFaltando} pacote(s) importado(s) sem declaração. Declare cada um no package.json do pacote que o importa.`
  )
  process.exit(1)
}
console.log(`[importações] tudo declarado (${totalArquivos} arquivos de produção conferidos)`)
