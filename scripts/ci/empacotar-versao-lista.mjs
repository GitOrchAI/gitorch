#!/usr/bin/env node
//
// Monta a LISTA do que entra no pacote da versão, a partir do checkout já
// construído. Não constrói nada e não copia nada: só decide quais caminhos
// (arquivos e links simbólicos, relativos à raiz) o empacotador entrega ao tar.
//
// Uso:  node empacotar-versao-lista.mjs <raiz> <arquivo-da-lista> <arquivo-dos-componentes>
//   - <arquivo-da-lista>: um caminho por linha, relativo à raiz;
//   - <arquivo-dos-componentes>: JSON com nome, quantidade de arquivos e bytes
//     de cada componente (vira o `componentes` do MANIFESTO.json).
//
// Por que fechar as dependências aqui, e não empacotar `node_modules` inteiro:
// o pnpm guarda tudo em `node_modules/.pnpm/<pacote>` e liga cada projeto por
// links simbólicos relativos. O serviço só precisa do que o `package.json` dele
// (e dos pacotes do monorepo que ele usa) declara em `dependencies`, mais
// `prisma` e `tsx`, que o `db-migrate.sh` executa. Seguir os links a partir
// dessas raízes leva ao fecho exato, sem ferramentas de teste, de lint ou de
// build, e preserva a estrutura que o pnpm montou (por isso roda em outra
// máquina da mesma arquitetura sem instalar nada).
//
// Falha, com mensagem em português e código de saída 1, quando:
//   - falta um componente obrigatório;
//   - há arquivo `.env*` dentro de um componente do projeto;
//   - um link de dependência aponta para fora da raiz ou para o vazio.
import fs from 'node:fs'
import path from 'node:path'

const [raiz, arquivoDaLista, arquivoDosComponentes] = process.argv.slice(2)
if (!raiz || !arquivoDaLista || !arquivoDosComponentes) {
  console.error(
    'uso: empacotar-versao-lista.mjs <raiz> <arquivo-da-lista> <arquivo-dos-componentes>'
  )
  process.exit(2)
}

const RAIZ = fs.realpathSync(raiz)
const CP = 'apps/control-plane'
const VIRTUAL = 'node_modules/.pnpm'
// Dependências de desenvolvimento que o db-migrate.sh executa em tempo de implantação.
const FERRAMENTAS_DE_MIGRACAO = ['prisma', 'tsx']

function falhar(mensagem) {
  console.error(`[empacotar] ${mensagem}`)
  process.exit(1)
}

const NOME_DE_ENV = /^\.env(\..*)?$/
const NOME_DE_TESTE = /\.(test|spec)\.[^/]+$/
const PASTAS_DE_TESTE = new Set(['test', 'tests', '__tests__', '__fixtures__'])
const PASTAS_DE_LIXO = new Set([
  '.git',
  '.vite',
  '.vite-temp',
  '.turbo',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
])

const componentes = new Map() // nome -> { arquivos, bytes }
const lista = new Set()

function registra(componente, relativo, bytes) {
  if (lista.has(relativo)) return
  lista.add(relativo)
  const c = componentes.get(componente) ?? { arquivos: 0, bytes: 0 }
  c.arquivos += 1
  c.bytes += bytes
  componentes.set(componente, c)
}

/** Só "não existe" (ou caminho quebrado) é esperado; qualquer outro erro de leitura sobe. */
function ausente(erro) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(erro?.code)
}

function existe(relativo) {
  try {
    fs.lstatSync(path.join(RAIZ, relativo))
    return true
  } catch (erro) {
    if (ausente(erro)) return false
    throw erro
  }
}

/**
 * Percorre um diretório e registra arquivos e links.
 * `projeto` = código do projeto: filtra testes e lixo e RECUSA `.env*`.
 * Terceiros (repositório virtual do pnpm): `.env*` de pacote é descartado (é
 * exemplo do autor da biblioteca, não configuração nossa) e nada é filtrado
 * além de `.git`, porque cortar pastas de uma biblioteca pode quebrá-la.
 */
function percorre(componente, relativo, { projeto, ignorar = () => false }) {
  const absoluto = path.join(RAIZ, relativo)
  let entradas
  try {
    entradas = fs.readdirSync(absoluto, { withFileTypes: true })
  } catch (erro) {
    if (ausente(erro)) return
    throw erro
  }
  for (const e of entradas) {
    const filho = `${relativo}/${e.name}`
    if (e.name === '.git') continue
    if (NOME_DE_ENV.test(e.name)) {
      if (projeto) falhar(`arquivo de ambiente dentro do pacote, recusado: ${filho}`)
      continue
    }
    if (ignorar(filho)) continue
    if (e.isDirectory()) {
      if (
        projeto &&
        (PASTAS_DE_LIXO.has(e.name) || PASTAS_DE_TESTE.has(e.name) || e.name === 'node_modules')
      ) {
        continue
      }
      percorre(componente, filho, { projeto, ignorar })
      continue
    }
    if (projeto && (NOME_DE_TESTE.test(e.name) || e.name.endsWith('.tsbuildinfo'))) continue
    const st = fs.lstatSync(path.join(RAIZ, filho))
    registra(componente, filho, st.isSymbolicLink() ? 0 : st.size)
  }
}

// --- componentes obrigatórios -------------------------------------------------
const OBRIGATORIOS = [
  [`${CP}/dist/index.js`, 'o build do control-plane (dist/index.js)'],
  [`${CP}/node_modules`, 'as dependências instaladas do control-plane (node_modules)'],
  [`${CP}/prisma/schema.prisma`, 'o schema e as migrações do prisma'],
  [`${CP}/scripts/db-migrate.sh`, 'o script de migração do banco (db-migrate.sh)'],
  [`${CP}/package.json`, 'o package.json do control-plane'],
  ['apps/web/out/index.html', 'o front estático construído (apps/web/out)'],
]
for (const [caminho, descricao] of OBRIGATORIOS) {
  if (!existe(caminho)) falhar(`componente obrigatório ausente: ${caminho} — falta ${descricao}`)
}

// --- código do projeto --------------------------------------------------------
percorre('control-plane-dist', `${CP}/dist`, { projeto: true })
percorre('control-plane-prisma', `${CP}/prisma`, { projeto: true })
// O db-migrate.sh lê src/lib/migration-ledger.ts por expressão regular e o seed
// (executado com tsx) importa de src/lib e src/config: as fontes seguem, sem testes.
percorre('control-plane-src', `${CP}/src`, { projeto: true })
percorre('control-plane-scripts', `${CP}/scripts`, { projeto: true })
for (const arquivo of ['package.json', 'tsconfig.json']) {
  if (existe(`${CP}/${arquivo}`)) registra('control-plane-config', `${CP}/${arquivo}`, 0)
}
percorre('front-web', 'apps/web/out', { projeto: true })
// O agendador chama runtime/<script>.py a partir da raiz do repositório.
if (existe('runtime')) percorre('runtime', 'runtime', { projeto: true })

// --- fecho das dependências ---------------------------------------------------
const virtuaisIncluidos = new Set() // nomes em node_modules/.pnpm
const pacotesDoMonorepo = new Set() // packages/<nome>

function lerJson(relativo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RAIZ, relativo), 'utf8'))
  } catch (erro) {
    if (ausente(erro)) return {}
    throw erro
  }
}

/**
 * Resolve um link de dependência. Devolve o caminho real relativo à raiz, ou
 * `null` quando o link está quebrado ou sai da raiz.
 */
function resolveLink(relativo) {
  let real
  try {
    real = fs.realpathSync(path.join(RAIZ, relativo))
  } catch (erro) {
    if (ausente(erro)) return null
    throw erro
  }
  const rel = path.relative(RAIZ, real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

function incluiLink(componente, relativo) {
  registra(componente, relativo, 0)
}

function visitaVirtual(nome) {
  if (virtuaisIncluidos.has(nome)) return
  virtuaisIncluidos.add(nome)
  const base = `${VIRTUAL}/${nome}`
  percorre('dependencias', base, { projeto: false })
  // Os irmãos em <nome>/node_modules são as dependências desse pacote.
  const pasta = `${base}/node_modules`
  let entradas = []
  try {
    entradas = fs.readdirSync(path.join(RAIZ, pasta), { withFileTypes: true })
  } catch (erro) {
    if (ausente(erro)) return
    throw erro
  }
  for (const e of entradas) {
    if (e.name.startsWith('.')) continue
    if (e.name.startsWith('@') && e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(RAIZ, pasta, e.name), { withFileTypes: true })) {
        if (f.isSymbolicLink()) seguir(`${pasta}/${e.name}/${f.name}`)
      }
      continue
    }
    if (e.isSymbolicLink()) seguir(`${pasta}/${e.name}`)
  }
}

/** Segue um link: se levar ao repositório virtual do pnpm ou a um pacote do monorepo, visita o destino. */
function seguir(link) {
  const alvo = resolveLink(link)
  if (alvo === null) return
  const virtual = nomeVirtual(alvo)
  if (virtual) {
    visitaVirtual(virtual)
    return
  }
  const monorepo = alvo.match(/^packages\/([^/]+)$/)
  if (monorepo?.[1]) visitaPacoteDoMonorepo(monorepo[1])
}

function nomeVirtual(alvo) {
  return alvo.startsWith(`${VIRTUAL}/`)
    ? (alvo.slice(VIRTUAL.length + 1).split('/')[0] ?? null)
    : null
}

function visitaPacoteDoMonorepo(nome) {
  if (pacotesDoMonorepo.has(nome)) return
  pacotesDoMonorepo.add(nome)
  const dir = `packages/${nome}`
  // Os pacotes trazem só o construído: fonte e configuração de build/teste ficam de fora.
  const doBuild = /^(tsconfig[^/]*\.json|vitest\.config\.[^/]+|tsup\.config\.[^/]+)$/
  percorre('pacotes-do-monorepo', dir, {
    projeto: true,
    ignorar: (rel) => rel === `${dir}/src` || doBuild.test(rel.slice(dir.length + 1)),
  })
  dependenciasDe(dir, [])
}

/** Inclui os links de `<dir>/node_modules/<nome>` para cada dependência declarada. */
function dependenciasDe(dir, extras) {
  const pacote = lerJson(`${dir}/package.json`)
  const nomes = new Set(extras)
  for (const n of Object.keys(pacote['dependencies'] ?? {})) nomes.add(n)
  for (const n of nomes) {
    const link = `${dir}/node_modules/${n}`
    if (!existe(link)) {
      // Dependência opcional não instalada nesta plataforma não é erro; as demais são.
      const opcional = Object.hasOwn(pacote['optionalDependencies'] ?? {}, n)
      if (opcional) continue
      falhar(`dependência declarada e não instalada: ${link}`)
    }
    incluiLink('dependencias', link)
    if (resolveLink(link) === null)
      falhar(`link de dependência quebrado ou fora do repositório: ${link}`)
    seguir(link)
  }
  // O .bin é incluído só com os executáveis que o db-migrate.sh usa.
  for (const bin of FERRAMENTAS_DE_MIGRACAO) {
    const caminho = `${dir}/node_modules/.bin/${bin}`
    if (extras.includes(bin) && existe(caminho)) incluiLink('dependencias', caminho)
  }
}

dependenciasDe(CP, FERRAMENTAS_DE_MIGRACAO)

// Hoisting do pnpm: pacotes que resolvem dependência não declarada sobem até
// node_modules/.pnpm/node_modules. Mantém só os links cujo alvo foi incluído.
const hoisted = `${VIRTUAL}/node_modules`
if (existe(hoisted)) {
  const candidatos = []
  for (const e of fs.readdirSync(path.join(RAIZ, hoisted), { withFileTypes: true })) {
    if (e.name.startsWith('@') && e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(RAIZ, hoisted, e.name)))
        candidatos.push(`${hoisted}/${e.name}/${f}`)
    } else {
      candidatos.push(`${hoisted}/${e.name}`)
    }
  }
  for (const c of candidatos) {
    const st = fs.lstatSync(path.join(RAIZ, c))
    if (!st.isSymbolicLink()) continue
    const alvo = resolveLink(c)
    const virtual = alvo === null ? null : nomeVirtual(alvo)
    if (virtual && virtuaisIncluidos.has(virtual)) incluiLink('dependencias', c)
  }
}

const ordenada = [...lista].sort()
fs.writeFileSync(arquivoDaLista, ordenada.join('\n') + '\n')
const saida = [...componentes.entries()]
  .map(([nome, c]) => ({ nome, arquivos: c.arquivos, bytes: c.bytes }))
  .sort((a, b) => a.nome.localeCompare(b.nome))
fs.writeFileSync(arquivoDosComponentes, JSON.stringify(saida, null, 2) + '\n')
console.error(`[empacotar] ${ordenada.length} caminhos em ${saida.length} componentes`)
