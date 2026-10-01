import { GitActorParams, GitActionResult } from './types.js'

export async function executeGitAction(params: GitActorParams): Promise<GitActionResult> {
  if (params.autonomy === 'so_olhar') {
    return {
      action: 'observed',
      message: 'Modo só_olhar ativo: diagnóstico emitido sem alterações no repositório.',
    }
  }

  const { octokit, owner, repo, optimizedYaml, assessment } = params
  const workflowPath = params.workflowPath || '.github/workflows/ci.yml'
  const baseBranch = params.baseBranch || 'main'
  const branchName = params.branchName || `ci/pipeline-optimization-${Date.now()}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = octokit as any

  // 1. Get base branch SHA
  const ref = await client.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  })
  const baseSha = ref.data.object.sha

  // 2. Create new branch
  await client.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  })

  // 3. Create or update file
  // Try to get existing file to get its sha (required for update)
  let fileSha: string | undefined
  try {
    const { data: fileData } = await client.rest.repos.getContent({
      owner,
      repo,
      path: workflowPath,
      ref: baseBranch,
    })
    if (!Array.isArray(fileData) && fileData.type === 'file') {
      fileSha = fileData.sha
    }
  } catch (error: unknown) {
    // If it's a 404, it means the file doesn't exist, which is fine for creation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((error as any).status !== 404) {
      throw error
    }
  }

  await client.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: workflowPath,
    message: 'ci: otimizar esteira de CI/CD e mitigar riscos de segurança',
    content: Buffer.from(optimizedYaml).toString('base64'),
    branch: branchName,
    sha: fileSha,
  })

  // 4. Create Pull Request
  const body = `
Otimização da esteira de CI/CD e mitigação de riscos de segurança.

**Impacto estimado:**
- Score antes: ${assessment.scoreAntes ?? 'N/A'}
- Score depois: ${assessment.scoreDepois ?? 'N/A'}

**Capacidades adicionadas:**
${assessment.capacidadesAdicionadas ? assessment.capacidadesAdicionadas.map((c) => `- ${c}`).join('\n') : 'Nenhuma'}

Por favor, revise as alterações.
`

  const pr = await client.rest.pulls.create({
    owner,
    repo,
    title: 'ci: otimizar esteira de CI/CD e mitigar riscos de segurança',
    head: branchName,
    base: baseBranch,
    body: body.trim(),
  })

  if (params.autonomy === 'cuidar') {
    await client.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pr.data.number,
      labels: ['auto-merge'],
    })

    return {
      action: 'pr_created_with_automerge',
      prNumber: pr.data.number,
      prUrl: pr.data.html_url,
      branch: branchName,
      message: 'PR criado com auto-merge habilitado',
    }
  }

  return {
    action: 'pr_created',
    prNumber: pr.data.number,
    prUrl: pr.data.html_url,
    branch: branchName,
    message: 'PR criado para revisão',
  }
}
