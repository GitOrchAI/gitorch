import { headersGithub } from './github-json.js'

export interface RootContentItem {
  name: string
  type: string
  path?: string
}

export interface PackageJsonData {
  name?: string
  scripts?: Record<string, string>
  [key: string]: unknown
}

export interface MontarAgentsMdArgs {
  repository: string
  rootItems: RootContentItem[]
  docsItems: RootContentItem[]
  packageJson: PackageJsonData | null
}

export interface VerificarOuGerarAgentsMdDeps {
  repository: string
  defaultBranch: string
  token: string
  fetchImpl?: typeof fetch
  onWarn?: (m: string) => void
}

export interface VerificarOuGerarAgentsMdResultado {
  existe: boolean
  criado: boolean
  motivo?: string
}

/**
 * Monta o conteúdo canônico de AGENTS.md no padrão exigido pelo Jules.
 *
 * REGRA ANTI-ALUCINAÇÃO EM GREENFIELD:
 * Se não houver manifestos de build/scripts executáveis, declara honestamente
 * a ausência de comandos de build/test e instrui o dev assíncrono que a primeira
 * tarefa é fazer o bootstrap do ambiente. Nunca inventa comandos fictícios.
 */
export function montarConteudoAgentsMd(args: MontarAgentsMdArgs): string {
  const { repository, rootItems, docsItems, packageJson } = args

  let pm = 'npm'
  if (rootItems.some((item) => item.name === 'pnpm-lock.yaml')) {
    pm = 'pnpm'
  } else if (rootItems.some((item) => item.name === 'yarn.lock')) {
    pm = 'yarn'
  } else if (rootItems.some((item) => item.name === 'bun.lockb')) {
    pm = 'bun'
  }

  const scripts = packageJson?.scripts ?? {}
  const scriptKeys = Object.keys(scripts)
  const temScripts = scriptKeys.length > 0

  let comandosSection = ''
  if (packageJson && temScripts) {
    const linhasComandos = scriptKeys.map((script) => `${pm} run ${script}`)
    comandosSection = `\`\`\`bash\n${linhasComandos.join('\n')}\n\`\`\``
  } else if (packageJson && !temScripts) {
    comandosSection =
      'O arquivo `package.json` existe, mas não possui scripts executáveis configurados no momento.\n' +
      'A primeira tarefa do agente assíncrono deve ser configurar os scripts de build, teste e lint no `package.json`.\n' +
      'NUNCA execute comandos fictícios que não estejam presentes nos scripts.'
  } else {
    comandosSection =
      'Este repositório está em fase inicial (greenfield). Não existem manifestos de build, testes ou linters configurados no momento.\n' +
      'A primeira tarefa do agente assíncrono é realizar o bootstrap do projeto (definir a stack, criar manifestos e configurar o ambiente de desenvolvimento e testes).\n' +
      'NUNCA execute ou presuma comandos fictícios antes que os respectivos manifestos e arquivos de configuração existam.'
  }

  let docsSection = ''
  if (docsItems.length > 0) {
    const listaDocs = docsItems.map((d) => `- \`docs/${d.name}\``).join('\n')
    docsSection = `\n## Documentação existente\n\n${listaDocs}\n`
  }

  return `# AGENTS.md — ${repository}

Guia de contexto do repositório para agentes de codificação (Jules e outros). Este arquivo
descreve **apenas o que existe de verdade neste repositório** — comandos reais, estrutura real,
portão de qualidade real. Nenhuma ferramenta ou script externo é assumido.

## O que é este projeto

${packageJson?.name ? `Projeto \`${packageJson.name}\`.` : `Repositório ${repository}.`}
${docsSection}
## Comandos reais (rode estes, não invente outros)

${comandosSection}

## O portão de qualidade (CI) — tolerância zero

O portão de qualidade é estrito: zero erros de compilação, zero warnings de linter e testes passando.
Nunca utilize flags para mascarar erros ou ignorar falhas de verificação.

## Critério de Conclusão ("Done") — Deploy e Teste Real Obrigatórios

Uma tarefa só é considerada concluída após a criação do branch, push, abertura do Pull Request e validação com testes reais passando.

## Convenção de commits e PRs

Mensagens de commit no padrão \`tipo: descrição\` (\`feat:\`, \`fix:\`, \`chore:\`, \`test:\`, \`docs:\`).
Título e descrição do PR em português (PT-BR) sempre que possível.
`
}

/**
 * Verifica se AGENTS.md existe na branch padrão do repositório.
 * Se não existir, gera o AGENTS.md canônico grounded e comita via GitHub Contents API.
 */
export async function verificarOuGerarAgentsMd(
  deps: VerificarOuGerarAgentsMdDeps
): Promise<VerificarOuGerarAgentsMdResultado> {
  const f = deps.fetchImpl ?? fetch
  const warn = deps.onWarn ?? (() => undefined)

  const [owner, repo] = deps.repository.split('/')
  if (!owner || !repo) {
    const motivo = `repositório em formato inesperado: '${deps.repository}'`
    warn(`[onboarding-agents] ${motivo}`)
    return { existe: false, criado: false, motivo }
  }

  // 1. Verifica se AGENTS.md já existe na branch padrão
  const checkUrl = `https://api.github.com/repos/${owner}/${repo}/contents/AGENTS.md?ref=${encodeURIComponent(
    deps.defaultBranch
  )}`

  let checkResp: Response
  try {
    checkResp = await f(checkUrl, {
      method: 'GET',
      headers: headersGithub(deps.token),
    })
  } catch (err) {
    const motivo = (err as Error).message
    warn(`[onboarding-agents] Erro ao verificar AGENTS.md em ${deps.repository}: ${motivo}`)
    return { existe: false, criado: false, motivo }
  }

  if (checkResp.status === 200) {
    return { existe: true, criado: false }
  }

  if (checkResp.status !== 404) {
    const detail = await checkResp.text().catch(() => '')
    const motivo = `HTTP ${checkResp.status}: ${detail}`
    warn(`[onboarding-agents] Falha ao verificar AGENTS.md em ${deps.repository}: ${motivo}`)
    return { existe: false, criado: false, motivo }
  }

  // 2. Não existe (404): inspeciona raiz e docs para montar AGENTS.md grounded
  let rootItems: RootContentItem[] = []
  try {
    const rootUrl = `https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(
      deps.defaultBranch
    )}`
    const rootResp = await f(rootUrl, {
      method: 'GET',
      headers: headersGithub(deps.token),
    })
    if (rootResp.ok) {
      const data = await rootResp.json()
      if (Array.isArray(data)) {
        rootItems = data
      }
    }
  } catch (err) {
    warn(
      `[onboarding-agents] Aviso ao listar raiz de ${deps.repository}: ${(err as Error).message}`
    )
  }

  let docsItems: RootContentItem[] = []
  const hasDocsDir =
    rootItems.some((item) => item.name === 'docs' && item.type === 'dir') || rootItems.length === 0
  if (hasDocsDir) {
    try {
      const docsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/docs?ref=${encodeURIComponent(
        deps.defaultBranch
      )}`
      const docsResp = await f(docsUrl, {
        method: 'GET',
        headers: headersGithub(deps.token),
      })
      if (docsResp.ok) {
        const data = await docsResp.json()
        if (Array.isArray(data)) {
          docsItems = data
        }
      }
    } catch {
      // docs/ não é obrigatório
    }
  }

  let packageJson: PackageJsonData | null = null
  const hasPackageJson = rootItems.some(
    (item) => item.name === 'package.json' && item.type === 'file'
  )
  if (hasPackageJson) {
    try {
      const pkgUrl = `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(
        deps.defaultBranch
      )}`
      const pkgResp = await f(pkgUrl, {
        method: 'GET',
        headers: headersGithub(deps.token),
      })
      if (pkgResp.ok) {
        const pkgData = (await pkgResp.json()) as { content?: string; encoding?: string }
        if (pkgData.content) {
          const decoded = Buffer.from(pkgData.content, 'base64').toString('utf-8')
          packageJson = JSON.parse(decoded) as PackageJsonData
        }
      }
    } catch (err) {
      warn(
        `[onboarding-agents] Aviso ao inspecionar package.json em ${deps.repository}: ${(err as Error).message}`
      )
    }
  }

  const conteudo = montarConteudoAgentsMd({
    repository: deps.repository,
    rootItems,
    docsItems,
    packageJson,
  })

  // 3. Comita o AGENTS.md via PUT
  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/AGENTS.md`
  const putBody = {
    message: 'docs(agents): adicionar AGENTS.md canônico para guiar automação do jules',
    content: Buffer.from(conteudo).toString('base64'),
    branch: deps.defaultBranch,
  }

  try {
    const putResp = await f(putUrl, {
      method: 'PUT',
      headers: headersGithub(deps.token, true),
      body: JSON.stringify(putBody),
    })

    if (!putResp.ok) {
      const detail = await putResp.text().catch(() => '')
      const motivo = `HTTP ${putResp.status}: ${detail}`
      warn(`[onboarding-agents] Falha ao criar AGENTS.md em ${deps.repository}: ${motivo}`)
      return { existe: false, criado: false, motivo }
    }

    return { existe: true, criado: true }
  } catch (err) {
    const motivo = (err as Error).message
    warn(`[onboarding-agents] Erro ao criar AGENTS.md em ${deps.repository}: ${motivo}`)
    return { existe: false, criado: false, motivo }
  }
}
