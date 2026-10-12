// Leitura e edição, por texto, dos workflows do repositório do cliente.
//
// Duas regras mandam aqui:
//  - o que não dá para ler com certeza é "não analisado" (`null`), nunca "tudo
//    certo": um workflow estranho fica de fora das edições e BLOQUEIA a troca da
//    permissão padrão do token;
//  - a edição é só inserir (e depois remover) um bloco fixo, sem reescrever o
//    arquivo: o que o cliente escreveu fica byte a byte como estava.

/** Um arquivo de workflow direto em `.github/workflows`, sem subpasta nem `..`. */
export function caminhoDeWorkflowValido(caminho: string): boolean {
  return /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(caminho) && !caminho.includes('..')
}

export interface AnaliseDoWorkflow {
  caminho: string
  /** Declara `permissions` no topo ou em todos os jobs. `null` = não deu para analisar. */
  declaraPermissoes: boolean | null
  /**
   * Deploy/CD/publicação OU workflow que não se prova CI puro: o GitOrch não
   * mexe sem perguntar ao dono. Só quem se prova CI puro fica `false`.
   */
  ehDeploy: boolean
  /** Só usa Actions que leem e nenhum sinal de escrita com o token. */
  seguroParaPermissaoMinima: boolean
  motivoDeNaoSeguro: string | null
  temGitleaks: boolean
  temCodeql: boolean
}

function linhasDe(texto: string): string[] {
  return texto.split(/\r?\n/)
}

/** Indentação além disto não é de um workflow de verdade: não analisa. */
const TETO_DE_INDENTACAO = 16

const ehComentarioOuVazia = (linha: string): boolean => /^\s*(#.*)?$/.test(linha)
const indentacao = (linha: string): number => linha.length - linha.trimStart().length

function declaraPermissoes(texto: string): boolean | null {
  const linhas = linhasDe(texto)
  if (linhas.some((l) => /^\t/.test(l) || /^ *\t/.test(l))) return null
  const posicoesDeJobs = linhas.flatMap((l, i) => (/^jobs\s*:/.test(l) ? [i] : []))
  if (posicoesDeJobs.length !== 1) return null
  if (linhas.some((l) => /^permissions\s*:/.test(l))) return true

  const inicio = (posicoesDeJobs[0] ?? 0) + 1
  const bloco: string[] = []
  for (let i = inicio; i < linhas.length; i += 1) {
    const linha = linhas[i] ?? ''
    if (!ehComentarioOuVazia(linha) && indentacao(linha) === 0) break
    bloco.push(linha)
  }
  const primeira = bloco.find((l) => !ehComentarioOuVazia(l))
  if (primeira === undefined) return null
  const nivelDoJob = indentacao(primeira)
  if (nivelDoJob === 0 || nivelDoJob > TETO_DE_INDENTACAO) return null

  const cabecalho = new RegExp(`^ {${nivelDoJob}}("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\\s*:`)
  const jobs: string[][] = []
  for (const linha of bloco) {
    if (cabecalho.test(linha)) jobs.push([])
    else if (jobs.length > 0) jobs[jobs.length - 1]?.push(linha)
  }
  if (jobs.length === 0) return null

  return jobs.every((filhas) => {
    const primeiraFilha = filhas.find((l) => !ehComentarioOuVazia(l))
    if (primeiraFilha === undefined) return false
    const nivel = indentacao(primeiraFilha)
    return filhas.some((l) => indentacao(l) === nivel && /^\s*permissions\s*:/.test(l))
  })
}

function nomesDosJobs(texto: string): string[] {
  const linhas = linhasDe(texto)
  const inicio = linhas.findIndex((l) => /^jobs\s*:/.test(l))
  if (inicio < 0) return []
  const nomes: string[] = []
  let nivel = 0
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = linhas[i] ?? ''
    if (ehComentarioOuVazia(linha)) continue
    if (indentacao(linha) === 0) break
    if (nivel === 0) nivel = indentacao(linha)
    if (indentacao(linha) === nivel) {
      const achou = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(linha)
      if (achou?.[1]) nomes.push(achou[1])
    }
  }
  return nomes
}

const SINAIS_DE_DEPLOY = /(cd|deploy|release|publish)/i
const NOME_DE_DEPLOY = /(\bcd\b|deploy|release|publish|publica)/i

/** O texto sem as linhas de comentário: comentário não roda, então não conta. */
const semComentarios = (texto: string): string =>
  linhasDe(texto)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

/**
 * Só o bloco `on:` do arquivo (a linha e as filhas dela), para olhar os
 * gatilhos sem confundir uma palavra de outro lugar com um gatilho.
 */
function blocoDeGatilhos(texto: string): string {
  const linhas = linhasDe(texto)
  const inicio = linhas.findIndex((l) => /^["']?on["']?\s*:/.test(l))
  if (inicio < 0) return ''
  const bloco = [(linhas[inicio] ?? '').replace(/^["']?on["']?\s*:/, '')]
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = linhas[i] ?? ''
    if (!ehComentarioOuVazia(linha) && indentacao(linha) === 0) break
    bloco.push(linha)
  }
  return bloco.join('\n')
}

/** Publicar uma versão, entregar num servidor ou numa nuvem, mexer em cluster. */
const COMANDOS_DE_DEPLOY: readonly RegExp[] = [
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:publish|release)\b/i,
  /\b(?:semantic-release|changeset\s+publish|lerna\s+publish)\b/i,
  /\bdocker\s+(?:push\b|buildx\s+build\b[^\n]*--push|compose\s+push\b)/i,
  /\bhelm\b/i,
  /\bkubectl\b/i,
  /\b(?:terraform|tofu)\s+(?:apply|destroy)\b/i,
  /\bpulumi\s+up\b|\bcdk\s+deploy\b|\b(?:serverless|sls)\s+deploy\b/i,
  /\b(?:aws|gcloud|az)\s+[^\n]*\b(?:deploy|publish|push|sync|cp|put|upload|update|release|apply|rollout|create)\b/i,
  /\bflyctl\b|\bfly\s+deploy\b|\bvercel\b|\bnetlify\b|\bwrangler\b|\bheroku\b|\bfirebase\s+deploy\b/i,
  /\bgh\s+release\b/i,
  /\btwine\s+upload\b|\bcargo\s+publish\b|\bpoetry\s+publish\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b/i,
  /\bmvn\b[^\n]*\bdeploy\b|\bgradlew?\b[^\n]*\bpublish/i,
  /\b(?:ssh|scp|rsync|sftp)\s/i,
  /\bcurl\b[^\n]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--data\b|\s-d\s|\s-F\s|\s--upload-file\b|\s-T\s)/i,
]

/** Actions que publicam, entregam ou autenticam numa nuvem. */
const ACTION_DE_DEPLOY =
  /deploy|publish|release|push|upload-pages|gh-pages|github-pages|ssh|rsync|ftp|scp|flyctl|netlify|vercel|heroku|firebase|wrangler|aws-actions\/|azure\/|google-github-actions\/|docker\/login|helm|kubectl|terraform|pulumi|changesets|semantic-release|pypi|twine/i

/**
 * Deploy, CD, publicação ou "não se prova CI puro". Olha o caminho, o nome e os
 * jobs, o corpo (um workflow chamado "Build" que publica ao criar uma tag é
 * deploy) e, por fim, exige a PROVA de CI puro por lista branca: lista de
 * proibidos deixa passar o que ninguém listou. Na dúvida é deploy: o custo de
 * errar para esse lado é uma pergunta a mais ao dono; para o outro, uma mudança
 * num fluxo que entrega o projeto, sem ninguém avisado.
 */
function ehDeploy(caminho: string, texto: string): boolean {
  if (SINAIS_DE_DEPLOY.test(caminho)) return true
  const nome = /^name\s*:\s*(.+)$/m.exec(texto)?.[1] ?? ''
  if (NOME_DE_DEPLOY.test(nome)) return true
  if (nomesDosJobs(texto).some((job) => NOME_DE_DEPLOY.test(job))) return true
  if (ehDeployPeloCorpo(texto)) return true
  return !seProvaCiPuro(texto)
}

function ehDeployPeloCorpo(texto: string): boolean {
  const corpo = semComentarios(texto)

  // Gatilhos: release, tag, ou o que roda depois de outro workflow.
  const gatilhos = blocoDeGatilhos(corpo)
  if (/(?:^|[\s,{[])release\s*(?::|,|\]|\}|$)/m.test(gatilhos)) return true
  if (/\bworkflow_run\b/.test(gatilhos)) return true
  if (/\btags\s*:/.test(gatilhos)) return true

  // Ambiente protegido (production, staging...): quem usa `environment:` entrega.
  if (/^\s*(?:-\s*)?environment\s*:/m.test(corpo)) return true

  // Segredos: sem como saber para onde vão, tratados como escrita externa.
  if (/\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]/i.test(corpo)) return true
  if (/^\s*secrets\s*:\s*inherit\b/m.test(corpo)) return true

  // Comandos de publicação e entrega.
  if (COMANDOS_DE_DEPLOY.some((padrao) => padrao.test(corpo))) return true

  // Actions de publicação e entrega.
  for (const achado of corpo.matchAll(LINHA_USES)) {
    const acao = (achado[1] ?? '').split('@', 1)[0] ?? ''
    if (ACTION_DE_DEPLOY.test(acao)) return true
  }
  return false
}

const LINHA_USES = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*['"]?([^\s'"#]+)/gm

// Lista branca de CI puro. Tudo o que não está aqui NÃO se prova CI puro.

const ACTION_DE_CI =
  /^(actions\/(checkout|setup-[a-z]+|cache(\/(restore|save))?|upload-artifact|download-artifact)|pnpm\/action-setup|ruby\/setup-ruby|oven-sh\/setup-bun|astral-sh\/setup-uv)@/

/** Entrada de Action que liga publicação (`push: true`, `publish: true`...). */
const ENTRADA_DE_PUBLICACAO =
  /^[ \t]*(?:push|publish|deploy|release)[ \t]*:[ \t]*['"]?(?!false\b)[^\s#'"]/im

/** Verbo de publicação em qualquer comando: desclassifica mesmo se o resto parecer CI. */
const VERBO_DE_PUBLICACAO =
  /\b(?:deploy|publish|release|push|ship|upload|rsync|scp|sftp|ssh|apply|rollout|promote|terraform|kubectl|helm)\b|\bgo-?live\b/i

const GERENCIADOR = '(?:npm|pnpm|yarn|bun)'
const SCRIPT_DE_CI =
  '(?:test|tests|lint|typecheck|type-check|build|check|coverage|format:check|(?:test|lint|build|typecheck|check):[\\w:.-]+)'

const COMANDOS_DE_CI: readonly RegExp[] = [
  new RegExp(`^${GERENCIADOR}\\s+(?:ci|install|i)(?:\\s+(?!-g\\b|--global\\b)[-\\w=.:/@]+)*$`),
  /^yarn$/,
  new RegExp(
    `^${GERENCIADOR}\\s+(?:(?:-r|--recursive|--if-present|--silent|-s|-w|--workspaces|--filter(?:=|\\s+)\\S+|--workspace(?:=|\\s+)\\S+)\\s+)*(?:run\\s+(?:(?:-r|--recursive|--if-present|--filter(?:=|\\s+)\\S+)\\s+)*)?${SCRIPT_DE_CI}(?:\\s.*)?$`
  ),
  /^(?:(?:npx|pnpm\s+exec|yarn|bunx)\s+)?(?:tsc|eslint|prettier|vitest|jest|playwright\s+test|mocha|stylelint|biome|ruff|pytest|mypy|black|flake8|isort)\b.*$/,
  /^(?:python3?\s+-m\s+)?pip3?\s+install\s+(?!.*(?:-g|--global)\b).+$/,
  /^python3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b.*$/,
  /^go\s+(?:test|build|vet|fmt|mod\s+download)\b.*$/,
  /^cargo\s+(?:test|build|check|clippy|fmt|fetch)\b.*$/,
  /^(?:mvn|\.\/mvnw|gradle|\.\/gradlew)(?:\s+-\S+)*\s+(?:test|verify|package|compile|build|check)\b.*$/,
  /^dotnet\s+(?:restore|build|test)\b.*$/,
  /^bundle\s+(?:install|exec\s+(?:rspec|rubocop|rake\s+test))\b.*$/,
  /^(?:echo|cd|ls|pwd|mkdir|corepack\s+enable|set\s+-[euxo]+)\b.*$/,
]

/**
 * Os blocos `run:` do arquivo (inline, `|` e `>`), com as continuações de linha
 * (`\` no fim) já juntadas, cada comando separado por `&&`, `||`, `;`, `|`.
 */
function comandosDeRun(texto: string): string[] | null {
  const linhas = linhasDe(semComentarios(texto))
  const comandos: string[] = []
  for (let i = 0; i < linhas.length; i += 1) {
    const achou = /^(\s*(?:-\s+)?)run\s*:\s*(.*)$/.exec(linhas[i] ?? '')
    if (!achou) continue
    const nivel = (achou[1] ?? '').length
    const partes: string[] = []
    const inicio = (achou[2] ?? '').trim()
    if (!/^[|>][+-]?\d*$/.test(inicio)) partes.push(inicio.replace(/^(['"])(.*)\1$/, '$2'))
    while (i + 1 < linhas.length) {
      const prox = linhas[i + 1] ?? ''
      if (!ehComentarioOuVazia(prox) && indentacao(prox) <= nivel) break
      partes.push(prox.trim())
      i += 1
    }
    const junto = partes.join('\n').replace(/\\\s*\n\s*/g, ' ')
    if (/\$\(|`/.test(junto)) return null
    for (const trecho of junto.split(/&&|\|\||;|\||\n/)) {
      const comando = trecho.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
      if (comando !== '') comandos.push(comando)
    }
  }
  return comandos
}

/**
 * Só é CI puro o workflow que se PROVA CI puro: legível, sem ambiente nem
 * segredo, com toda Action e todo comando na lista branca e nenhum verbo de
 * publicação. Script do repositório, `make`, `npm run` de script desconhecido,
 * Action local ou de terceiros: não se prova, vira pergunta ao dono.
 */
function seProvaCiPuro(texto: string): boolean {
  if (declaraPermissoes(texto) === null) return false
  const corpo = semComentarios(texto)
  if (ENTRADA_DE_PUBLICACAO.test(corpo)) return false
  for (const achado of corpo.matchAll(LINHA_USES)) {
    if (!ACTION_DE_CI.test(achado[1] ?? '')) return false
  }
  const comandos = comandosDeRun(texto)
  if (comandos === null) return false
  return comandos.every(
    (c) => !VERBO_DE_PUBLICACAO.test(c) && COMANDOS_DE_CI.some((padrao) => padrao.test(c))
  )
}

const ACTION_QUE_SO_LE =
  /^(actions\/(checkout|setup-node|setup-python|setup-go|setup-java|setup-dotnet|cache(\/(restore|save))?|upload-artifact|download-artifact)|pnpm\/action-setup|ruby\/setup-ruby|oven-sh\/setup-bun|astral-sh\/setup-uv)@/

const SINAIS_DE_ESCRITA: ReadonlyArray<readonly [RegExp, string]> = [
  [/GITHUB_TOKEN|github\.token|\bGH_TOKEN\b/, 'usa o token do GitHub'],
  [/\bgh\s+\w/, 'usa o gh cli'],
  [/\bgit\s+(push|tag)\b/, 'faz git push ou tag'],
  [/api\.github\.com/, 'chama a API do GitHub'],
  [/pull_request_target/, 'roda em pull_request_target'],
  [/id-token/, 'pede id-token'],
  [/ghcr\.io/, 'publica no registro de pacotes'],
]

function avaliarSeguranca(texto: string): { seguro: boolean; motivo: string | null } {
  for (const achado of texto.matchAll(LINHA_USES)) {
    const uso = achado[1] ?? ''
    if (!ACTION_QUE_SO_LE.test(uso)) {
      const nome = uso.split('@', 1)[0] ?? uso
      return { seguro: false, motivo: `usa a Action ${nome}, que pode precisar de escrita` }
    }
  }
  for (const [padrao, motivo] of SINAIS_DE_ESCRITA) {
    if (padrao.test(texto)) return { seguro: false, motivo }
  }
  return { seguro: true, motivo: null }
}

export function analisarWorkflow(caminho: string, texto: string): AnaliseDoWorkflow {
  const { seguro, motivo } = avaliarSeguranca(texto)
  return {
    caminho,
    declaraPermissoes: declaraPermissoes(texto),
    ehDeploy: ehDeploy(caminho, texto),
    seguroParaPermissaoMinima: seguro,
    motivoDeNaoSeguro: motivo,
    temGitleaks: /gitleaks/i.test(texto),
    temCodeql: /codeql/i.test(texto),
  }
}

/** O bloco que a edição insere antes de `jobs:`, com fim de linha LF. */
export const BLOCO_DE_PERMISSOES_MINIMAS =
  '# Permissão mínima do GITHUB_TOKEN; amplie por job se algum passo precisar escrever.\n' +
  'permissions:\n' +
  '  contents: read\n' +
  '\n'

function fimDeLinhaDe(texto: string): string {
  return texto.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Insere o bloco de permissões mínimas antes de `jobs:`. `null` quando o
 * arquivo já declara permissions, não tem exatamente um `jobs:` ou não dá para
 * analisar: nesses casos o GitOrch não edita.
 */
export function adicionarPermissoesMinimas(texto: string): string | null {
  if (declaraPermissoes(texto) !== false) return null
  const fim = fimDeLinhaDe(texto)
  const linhas = texto.split(fim)
  const posicao = linhas.findIndex((l) => /^jobs\s*:/.test(l))
  if (posicao < 0) return null
  const bloco = BLOCO_DE_PERMISSOES_MINIMAS.split('\n').join(fim)
  linhas.splice(posicao, 0, ...bloco.split(fim).slice(0, -1))
  return linhas.join(fim)
}

/** Desfaz `adicionarPermissoesMinimas`. `null` se o bloco não está lá, exatamente como foi inserido. */
export function removerPermissoesMinimas(texto: string): string | null {
  const fim = fimDeLinhaDe(texto)
  const bloco = BLOCO_DE_PERMISSOES_MINIMAS.split('\n').join(fim)
  const partes = texto.split(bloco)
  if (partes.length !== 2) return null
  return partes.join('')
}
