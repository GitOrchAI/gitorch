#!/usr/bin/env node
//
// Confere, ANTES de o empacotador gerar o tar, que todo pacote externo
// importado pelo código compilado que vai no pacote da versão RESOLVE dentro
// da árvore que vai no pacote. Não carrega módulo nenhum: só lê os
// especificadores e procura `node_modules/<pacote>` subindo a cadeia de pastas
// a partir do arquivo que importa, como o Node faz, mas olhando apenas o que
// está na lista do pacote (arquivos e links simbólicos do pnpm incluídos).
//
// Uso:  node conferir-resolucao-do-pacote.mjs <raiz> <arquivo-da-lista>
//
// Confere os `.js`/`.mjs`/`.cjs` de `apps/control-plane/dist` e de
// `packages/<x>/dist` que estão na lista. Importação dinâmica com expressão
// não literal não dá para conferir: é ignorada e a quantidade é informada.
// Sai com 1, listando TODOS os faltantes (pacote <- arquivo), se algum não
// resolver; com 2 em erro de uso.
import fs from 'node:fs'
import path from 'node:path'
import { importacoesDe, nomeDoPacote } from './importacoes-lib.mjs'

const [raiz, arquivoDaLista] = process.argv.slice(2)
if (!raiz || !arquivoDaLista) {
  console.error('uso: conferir-resolucao-do-pacote.mjs <raiz> <arquivo-da-lista>')
  process.exit(2)
}

const caminhos = fs
  .readFileSync(arquivoDaLista, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
const naLista = new Set(caminhos)
// Toda pasta que contém algo da lista: um pacote instalado como pasta real (sem
// link) aparece aqui, porque a lista guarda só os arquivos dele.
const pastasNaLista = new Set()
for (const c of caminhos) {
  for (
    let pasta = path.posix.dirname(c);
    pasta !== '.' && pasta !== '/';
    pasta = path.posix.dirname(pasta)
  ) {
    if (pastasNaLista.has(pasta)) break
    pastasNaLista.add(pasta)
  }
}

function resolve(arquivo, pacote) {
  for (let pasta = path.posix.dirname(arquivo); ; pasta = path.posix.dirname(pasta)) {
    if (path.posix.basename(pasta) !== 'node_modules') {
      const candidato = pasta === '.' ? `node_modules/${pacote}` : `${pasta}/node_modules/${pacote}`
      if (naLista.has(candidato) || pastasNaLista.has(candidato)) return true
    }
    if (pasta === '.' || pasta === '/') return false
  }
}

const COMPILADO = /^(apps\/control-plane|packages\/[^/]+)\/dist\/.+\.(js|mjs|cjs)$/
const faltantes = new Map() // pacote -> Set de arquivos
let dinamicas = 0
let conferidos = 0
for (const arquivo of caminhos.filter((c) => COMPILADO.test(c))) {
  const real = path.join(raiz, arquivo)
  if (!fs.lstatSync(real).isFile()) continue
  conferidos += 1
  const achado = importacoesDe(real)
  dinamicas += achado.dinamicas
  for (const { especificador } of achado.importacoes) {
    const pacote = nomeDoPacote(especificador)
    if (pacote === null || resolve(arquivo, pacote)) continue
    if (!faltantes.has(pacote)) faltantes.set(pacote, new Set())
    faltantes.get(pacote).add(arquivo)
  }
}

console.error(
  `[empacotar] resolução conferida em ${conferidos} arquivos compilados; importações dinâmicas com expressão (não conferidas): ${dinamicas}`
)
if (faltantes.size > 0) {
  console.error(
    `[empacotar] ERRO: ${faltantes.size} pacote(s) importado(s) pelo código compilado não estão no pacote da versão (o serviço morreria ao subir com ERR_MODULE_NOT_FOUND):`
  )
  for (const [pacote, arquivos] of [...faltantes].sort(([a], [b]) => a.localeCompare(b))) {
    for (const arquivo of [...arquivos].sort())
      console.error(`[empacotar]   ${pacote} <- ${arquivo}`)
  }
  console.error(
    '[empacotar] Declare o pacote em `dependencies` do package.json de quem o importa (veja scripts/ci/conferir-importacoes.mjs).'
  )
  process.exit(1)
}
