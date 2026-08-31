import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classificarArquivoDaRaiz,
  varrerRaiz,
  listarArquivosDaRaiz,
  montarMensagem,
  RAIZ_PERMITIDA,
  ambienteGitIsolado,
} from './check-root-drafts'

describe('portao da raiz — LADO QUE BARRA (rascunho novo nao entra)', () => {
  const rascunhos = [
    // o que estava na raiz da main deste repo
    'check-actions.mjs',
    'patch.diff',
    // o que o PR #336 carregava e so nao entrou porque o PR nao mesclou
    'fix_orchestrator.js',
    'fix_telegram_bot_final.js',
    'get_telegram.js',
    // a mesma familia no repo irmao (patinhas)
    'patch_ci.py',
    'clean_timeouts.py',
    'check_db.sh',
    'check_ml_errors.cjs',
    'supervisor.sh',
    'Checkout.main.tsx',
    'package.main.json',
    'build_output.txt',
    'merge-resolution.patch',
    // os DOIS que escapavam por extensao ate o QA reprovar: `.conf` e `.json`
    // nao podem ser banidos (levariam `package.json` junto), entao quem os
    // pega e o marcador no NOME
    'nginx-fix.conf',
    'jules_sources.json',
    // e a FAMILIA deles — o proximo nao vai ter esse nome
    'caddy-fix.conf',
    'api_fix.yaml',
    'turbo.json-old.json',
    'database-backup.json',
    'deploy-final.sh',
    'runs_dump.json',
    'webhook_payload.json',
    'engines_response.csv',
    // nomes NOVOS que ainda nao existiram: e aqui que se mede reincidencia
    'sync_missions.sh',
    'dump-jobs.mjs',
    'debug_webhook.ts',
    'tmp_migracao.py',
    'verify-prod.js',
  ]

  it.each(rascunhos)('barra %s', (nome) => {
    expect(classificarArquivoDaRaiz(nome), `${nome} deveria ser barrado`).not.toBeNull()
  })

  it('a mensagem diz O QUE FAZER, nao so que negou', () => {
    const msg = montarMensagem(varrerRaiz(['check-actions.mjs']))
    expect(msg).toContain('scripts/')
    expect(msg).toContain('git mv')
    expect(msg).toContain('git rm')
    expect(msg).toContain('RAIZ_PERMITIDA')
    // mensagem que so nega treina a pessoa a contornar com -f
    expect(msg).toContain('git add -f')
  })
})

describe('portao da raiz — LADO QUE DEIXA PASSAR (nao trava a esteira)', () => {
  const legitimos = [
    // config da raiz: e o lugar dele
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'turbo.json',
    'version.json',
    'vitest.config.ts',
    'playwright.config.ts',
    'eslint.config.mjs',
    'README.md',
    'README.pt-br.md',
    'LICENSE',
    'SECURITY.md',
    'PLAN-free-tier-remote-executor.md',
    // dotfile de config na raiz nunca e rascunho
    '.eslintrc.js',
    '.gitignore',
    '.prettierrc',
    // qualquer coisa FORA da raiz nunca e avaliada — e para la que mandamos mover
    'scripts/ci/check-root-drafts.ts',
    'scripts/ci/infra-guard.sh',
    'scripts/ci/generate-patch-notes.ts',
    'apps/control-plane/src/plugins/scheduler.ts',
    'packages/graph-rag/src/reader/reader.ts',
    'patches/tar@7.5.21.patch',
  ]

  it.each(legitimos)('deixa passar %s', (nome) => {
    expect(classificarArquivoDaRaiz(nome)).toBeNull()
  })

  it('a escotilha salva um arquivo que o padrao alcancaria', () => {
    // sem registro, e barrado
    expect(classificarArquivoDaRaiz('check_jobs.ts', {})).not.toBeNull()
    // com registro (motivo + quem chama), passa
    const registrado = { 'check_jobs.ts': 'usado pelo teste X; chamado por Y' }
    expect(classificarArquivoDaRaiz('check_jobs.ts', registrado)).toBeNull()
  })
})

describe('portao da raiz — ESTADO REAL DA MAIN', () => {
  // A prova que importa: a regra tem que passar no repositorio como ele esta
  // AGORA. Regra que trava o CI e pior que o problema que resolve.
  it('a raiz versionada de hoje passa sem nenhum achado', () => {
    const achados = varrerRaiz(listarArquivosDaRaiz())
    expect(
      achados.map((a) => a.arquivo),
      'raiz suja: rode `pnpm exec tsx scripts/ci/check-root-drafts.ts`'
    ).toEqual([])
  })

  it('todo nome em RAIZ_PERMITIDA existe mesmo na raiz (escotilha nao vira lixo)', () => {
    const naRaiz = new Set(
      // `-z` pelo mesmo motivo do script: sem ele, nome acentuado vem citado
      execFileSync('git', ['ls-files', '-z', '--', ':(exclude)*/*'], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
    )
    for (const nome of Object.keys(RAIZ_PERMITIDA)) {
      expect(naRaiz.has(nome), `${nome} esta na escotilha mas sumiu da raiz`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------

describe('portao da raiz — os 2 orfaos DESTE repo caem, e as extensoes seguem livres', () => {
  const osDois = ['check-actions.mjs', 'patch.diff']

  it.each(osDois)('barra %s', (nome) => {
    expect(classificarArquivoDaRaiz(nome), `${nome} escapou do portao`).not.toBeNull()
  })

  it('os 2 que escapavam por extensao no repo irmao caem pelo NOME', () => {
    // Mesmo padrao dos dois repos: se `nginx-fix.conf` e `jules_sources.json`
    // caissem por extensao, `package.json` e `tsconfig.json` cairiam junto.
    expect(classificarArquivoDaRaiz('nginx-fix.conf')?.regra).toBe('marcador-de-rascunho')
    expect(classificarArquivoDaRaiz('jules_sources.json')?.regra).toBe('despejo-de-dados')
    expect(classificarArquivoDaRaiz('package.json')).toBeNull()
    expect(classificarArquivoDaRaiz('tsconfig.json')).toBeNull()
    expect(classificarArquivoDaRaiz('turbo.json')).toBeNull()
    expect(classificarArquivoDaRaiz('version.json')).toBeNull()
    expect(classificarArquivoDaRaiz('nginx.conf')).toBeNull()
  })
})

describe('portao da raiz — o que os padroes novos NAO podem barrar', () => {
  // Nomes rastreados de verdade na raiz deste repo. Regra que trava o CI e
  // pior que o problema que ela resolve.
  const naoPodeBarrar = [
    'package.json',
    'tsconfig.json',
    'turbo.json',
    'version.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'LICENSE',
    'README.md',
    'README.es.md',
    'README.pt-br.md',
    'SECURITY.md',
    'PLAN-free-tier-remote-executor.md',
    '.eslintrc.js',
    '.gitattributes',
    '.gitignore',
    '.gitleaks.toml',
    '.prettierrc',
    // ficaram FORA dos padroes NOVOS de proposito (ver comentario no script):
    // sao nomes rastreados no repo irmao que os candidatos descartados
    // barrariam. `-test.ts` fica de fora do marcador; na raiz este ainda cai
    // pela regra antiga `modulo-solto-na-raiz`, que e o comportamento aprovado
    // — o caminho real dele (`src/test/...`) o portao nem olha.
    'MERGE_CONFLICT_RESOLUTION.md',
    'schema_dump.sql',
    'src/test/fallback-pricing-test.ts',
    '.github/workflows/jules-ci-failure-fix.yml',
    'docs/mercadolivre/RELATORIO-PMO-ERRO-400-v2.md',
  ]

  it.each(naoPodeBarrar)('deixa passar %s', (nome) => {
    expect(
      classificarArquivoDaRaiz(nome),
      `${nome} e legitimo na raiz e o portao barrou — isso trava o CI`
    ).toBeNull()
  })

  it('dotfile continua ignorado mesmo casando com marcador novo', () => {
    expect(classificarArquivoDaRaiz('.env-backup.json')).toBeNull()
    expect(classificarArquivoDaRaiz('.config-old.yml')).toBeNull()
  })
})

describe('portao da raiz — NOME COM ACENTO (o furo que o QA achou)', () => {
  // `git ls-files` CITA e ESCAPA nome nao-ASCII: `correcao_ci.py` com cedilha
  // e til sai como `"corre\303\247\303\243o_ci.py"`, entre aspas. Nenhum
  // padrao casa string terminada em `.py"`, entao o rascunho batizado em
  // portugues passava. O dono destes repos e brasileiro: era a brecha mais
  // provavel de ser usada por acidente.
  const repoTemporario = mkdtempSync(join(tmpdir(), 'portao-acento-'))

  afterAll(() => {
    rmSync(repoTemporario, { recursive: true, force: true })
  })

  // `env` NAO e detalhe: sem ele este helper apaga o indice do repo de
  // verdade quando a suite roda dentro de um hook do git. Ver
  // `ambienteGitIsolado` e o teste de regressao no fim deste arquivo.
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repoTemporario,
      encoding: 'utf8',
      env: ambienteGitIsolado(),
    })

  it('o classificador reprova nome acentuado', () => {
    expect(classificarArquivoDaRaiz('correção_ci.py')).not.toBeNull()
    expect(classificarArquivoDaRaiz('configuração-fix.conf')).not.toBeNull()
    expect(classificarArquivoDaRaiz('relatório_output.json')).not.toBeNull()
    expect(classificarArquivoDaRaiz('análise.main.ts')).not.toBeNull()
  })

  it('listarArquivosDaRaiz devolve o nome REAL, nao a forma citada do git', () => {
    git('init', '-q', '.')
    git('config', 'user.email', 'portao@teste.local')
    git('config', 'user.name', 'portao')
    writeFileSync(join(repoTemporario, 'correção_ci.py'), '# rascunho\n')
    writeFileSync(join(repoTemporario, 'package.json'), '{}\n')
    git('add', '-A')

    // 1. a PROVA do bug: sem `-z`, o git entrega o nome escapado e entre aspas
    const semZ = git('ls-files').split('\n').filter(Boolean)
    expect(semZ).toContain('"corre\\303\\247\\303\\243o_ci.py"')
    expect(semZ).not.toContain('correção_ci.py')

    // 2. o classificador NAO casa a forma citada — era assim que o furo passava
    expect(classificarArquivoDaRaiz('"corre\\303\\247\\303\\243o_ci.py"')).toBeNull()

    // 3. com o conserto (`-z`), a listagem devolve o nome de verdade
    const comZ = listarArquivosDaRaiz(repoTemporario)
    expect(comZ).toContain('correção_ci.py')
    expect(comZ).toContain('package.json')
  })

  it('o portao REPROVA um repositorio cuja raiz so tem o arquivo acentuado', () => {
    const achados = varrerRaiz(listarArquivosDaRaiz(repoTemporario))
    expect(achados.map((a) => a.arquivo)).toEqual(['correção_ci.py'])
    expect(montarMensagem(achados)).toContain('correção_ci.py')
  })
})

describe('isolamento do git — o teste nao pode escrever no repo de verdade', () => {
  // REGRESSAO DE UM ESTRAGO REAL, nao hipotese. O `.husky/pre-commit` roda a
  // suite de scripts; o git exporta `GIT_DIR`/`GIT_INDEX_FILE` para os seus
  // hooks; e essas variaveis tem precedencia sobre o `cwd`. O resultado, medido
  // nesta branch: o `git add -A` do teste de acento acima gravou no indice REAL
  // — 963 arquivos rastreados viraram delecao staged e sobraram so os 2 do repo
  // de teste. Commitar assim apagaria a arvore inteira.
  const sandbox = mkdtempSync(join(tmpdir(), 'portao-sandbox-'))
  const paralelo = mkdtempSync(join(tmpdir(), 'portao-paralelo-'))

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true })
    rmSync(paralelo, { recursive: true, force: true })
  })

  it('ambienteGitIsolado remove as variaveis que sequestram a descoberta do repo', () => {
    const sujo = {
      GIT_DIR: '/tmp/repo-de-outro/.git',
      GIT_INDEX_FILE: '/tmp/repo-de-outro/.git/index',
      GIT_WORK_TREE: '/tmp/repo-de-outro',
      GIT_PREFIX: 'sub/',
      PATH: '/usr/bin',
    }
    const limpo = ambienteGitIsolado(sujo)

    expect(limpo.GIT_DIR).toBeUndefined()
    expect(limpo.GIT_INDEX_FILE).toBeUndefined()
    expect(limpo.GIT_WORK_TREE).toBeUndefined()
    expect(limpo.GIT_PREFIX).toBeUndefined()
    // o resto do ambiente continua de pe: git sem PATH nao roda
    expect(limpo.PATH).toBe('/usr/bin')
  })

  it('com GIT_DIR/GIT_INDEX_FILE hostis no ambiente, o indice do outro repo fica INTACTO', () => {
    // repo "de verdade", que nao pode ser tocado
    const rodar = (dir: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env })

    const limpo = ambienteGitIsolado()
    rodar(sandbox, limpo, 'init', '-q', '.')
    rodar(sandbox, limpo, 'config', 'user.email', 'portao@teste.local')
    rodar(sandbox, limpo, 'config', 'user.name', 'portao')
    writeFileSync(join(sandbox, 'arquivo-importante.txt'), 'nao me apague\n')
    rodar(sandbox, limpo, 'add', '-A')
    rodar(sandbox, limpo, 'commit', '-qm', 'base')

    const antes = rodar(sandbox, limpo, 'ls-files').split('\n').filter(Boolean)
    expect(antes).toEqual(['arquivo-importante.txt'])

    // agora simula EXATAMENTE o hook: as variaveis do sandbox no ambiente,
    // mas o trabalho acontecendo noutro diretorio.
    const hostil: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: join(sandbox, '.git'),
      GIT_INDEX_FILE: join(sandbox, '.git', 'index'),
    }
    writeFileSync(join(paralelo, 'correção_ci.py'), '# rascunho\n')

    // com o ambiente saneado, o `cwd` volta a mandar
    const saneado = ambienteGitIsolado(hostil)
    rodar(paralelo, saneado, 'init', '-q', '.')
    rodar(paralelo, saneado, 'add', '-A')

    const depois = rodar(sandbox, limpo, 'ls-files').split('\n').filter(Boolean)
    expect(depois).toEqual(['arquivo-importante.txt'])
    expect(depois).not.toContain('correção_ci.py')
  })

  it('listarArquivosDaRaiz respeita o diretorio mesmo com GIT_DIR hostil apontando para outro repo', () => {
    const guardado = process.env.GIT_DIR
    process.env.GIT_DIR = join(sandbox, '.git')
    try {
      // sem o saneamento, isto devolveria a raiz do SANDBOX
      expect(listarArquivosDaRaiz(paralelo)).toContain('correção_ci.py')
    } finally {
      if (guardado === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = guardado
    }
  })
})
