import { execFileSync } from 'node:child_process'

// Por que este script não tem mais uma lista fixa de pacotes:
//
// Até aqui, este arquivo tinha `const packages = ['packages/cgc', 'packages/cortex']`
// escrito à mão. Isso cobria só 2 dos 10 workspaces reais do monorepo — o
// apps/control-plane (o coração do produto, com `exactOptionalPropertyTypes`
// ligado) nunca foi verificado por este gate. Resultado real: seis erros de
// tipo do mesmo padrão (`campo: valorQuePodeSerUndefined` em vez de
// `...(valor ? { campo: valor } : {})`) atravessaram commit, pre-commit,
// review e `typecheck:strict` verde — só apareceram quando alguém rodou o
// build do control-plane manualmente.
//
// A causa raiz não era só "esqueceram o control-plane" — era que a lista
// dependia de alguém lembrar de atualizá-la toda vez que um workspace nasce.
// Isso sempre vai vencer a memória de alguém, eventualmente.
//
// A troca: em vez de manter uma lista para depois duplicar o trabalho que o
// `build` de cada pacote já faz (cada `package.json` já roda `tsc` com o
// `tsconfig.json` daquele pacote, respeitando as flags estritas que aquele
// pacote escolheu), este script:
//   1. pergunta ao pnpm quais workspaces existem de verdade hoje;
//   2. pergunta ao turbo quais desses workspaces o pipeline `build` alcança;
//   3. se sobrar algum workspace real fora do alcance do turbo (sem script
//      "build", ou fora do turbo.json), FALHA AQUI E AGORA — não deixa o
//      buraco reaparecer em silêncio;
//   4. só então roda `turbo run build` de verdade.
//
// Rodar o build de verdade (em vez de só `tsc --noEmit`) tem um efeito
// colateral bom: o turbo cacheia por conteúdo. O commit de hoje que não
// mexeu num pacote não recompila esse pacote de novo — e o passo "Build
// packages" mais adiante no CI, que roda o mesmo `pnpm run build`, vira um
// cache-hit em vez de compilar tudo pela segunda vez.
//
// Se um workspace novo nascer sem script "build", este script quebra com uma
// mensagem dizendo exatamente qual workspace ficou de fora — a correção é
// dar um script "build" a ele, nunca remover esta verificação.

type PnpmWorkspacePackage = {
  name: string
  path: string
  private?: boolean
}

const repoRoot = process.cwd()

function listRealWorkspaces(): PnpmWorkspacePackage[] {
  const raw = execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
    encoding: 'utf8',
    shell: true,
  })
  const all = JSON.parse(raw) as PnpmWorkspacePackage[]
  // O próprio root do monorepo aparece nessa lista do pnpm, mas ele não é
  // um workspace com tipos próprios para checar — é só quem orquestra os
  // outros. `turbo run build` também não o inclui (por design do turbo).
  return all.filter((pkg) => pkg.path !== repoRoot)
}

function turboReachablePackageNames(): Set<string> {
  const raw = execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', '--dry=json'], {
    encoding: 'utf8',
    shell: true,
  })
  // A CLI do turbo imprime uma linha de log ("• turbo x.y.z") antes do JSON.
  const jsonStart = raw.indexOf('{')
  const parsed = JSON.parse(raw.slice(jsonStart)) as {
    packages: string[]
    tasks: Array<{ package: string; command: string }>
  }
  // Achado testando este script: `parsed.packages` lista TODO workspace do
  // monorepo, mesmo os que não têm script "build" — turbo.json define a
  // tarefa "build" para o pipeline inteiro, então o pacote aparece na lista
  // de qualquer jeito. Quem não tem o script vira uma tarefa com
  // `command: "<NONEXISTENT>"` que o turbo PULA EM SILÊNCIO na hora de
  // rodar de verdade (sem erro, sem aviso). Foi provado rodando este script
  // contra um workspace sem "build": `turbo run build` terminou com exit 0
  // sem checar nada daquele pacote. Por isso a cobertura real não é
  // `parsed.packages` — é o subconjunto cujo `command` não é esse marcador.
  return new Set(
    parsed.tasks.filter((task) => task.command !== '<NONEXISTENT>').map((task) => task.package)
  )
}

function ensurePrismaClientIsGenerated(): void {
  // O control-plane importa tipos gerados pelo Prisma Client. Se este gate
  // rodar antes de `prisma generate` ter acontecido (a ordem dos passos no
  // CI é algo que já mudou uma vez e pode mudar de novo), o typecheck falha
  // por um motivo que não tem nada a ver com os tipos que queremos travar
  // aqui. Gerar de novo é idempotente e rápido — deixa este script correto
  // não importa quem o chama primeiro (CI, pre-commit local, ou alguém
  // rodando `pnpm run typecheck:strict` à mão).
  execFileSync('pnpm', ['--filter', '@gitorch/control-plane', 'exec', 'prisma', 'generate'], {
    stdio: 'inherit',
    shell: true,
  })
}

const workspaces = listRealWorkspaces()
const reachable = turboReachablePackageNames()

const uncovered = workspaces.filter((pkg) => !reachable.has(pkg.name))

if (uncovered.length > 0) {
  console.error(
    '\nERRO: workspace(s) fora do alcance do gate de tipos.\n' +
      'O(s) workspace(s) abaixo existem no monorepo (pnpm os enxerga) mas o ' +
      '`turbo run build` não chega neles — falta um script "build" no ' +
      'package.json, ou o turbo.json não os cobre. Isso é exatamente o ' +
      'buraco que este script existe para fechar: se um workspace fica de ' +
      'fora, os erros de tipo dele nunca são pegos aqui.\n'
  )
  for (const pkg of uncovered) {
    console.error(`  - ${pkg.name}  (${pkg.path})`)
  }
  console.error(
    '\nCorreção: adicione um script "build" a esse workspace (mesmo padrão ' +
      'dos outros: `tsc`). Não silencie ou remova esta verificação.\n'
  )
  process.exit(1)
}

ensurePrismaClientIsGenerated()

execFileSync('pnpm', ['exec', 'turbo', 'run', 'build'], { stdio: 'inherit', shell: true })
