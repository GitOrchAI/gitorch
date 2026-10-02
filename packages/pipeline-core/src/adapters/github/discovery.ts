import { RunnerRequirement } from '../../ir/types.js'

export interface GitHubRunnerInfo {
  id: number
  name: string
  os: string
  status: string
  busy: boolean
  labels: string[]
}

export interface OctokitLike {
  rest: {
    actions: {
      listSelfHostedRunnersForRepo(params: { owner: string; repo: string }): Promise<{
        data: {
          total_count: number
          runners: Array<{
            id: number
            name: string
            os: string
            status: string
            busy: boolean
            labels: Array<{ name: string }>
          }>
        }
      }>
    }
  }
}

export async function discoverRepoRunners(
  octokit: OctokitLike,
  owner: string,
  repo: string
): Promise<{
  hasSelfHosted: boolean
  runners: GitHubRunnerInfo[]
  recommendedRunner: RunnerRequirement
}> {
  const response = await octokit.rest.actions.listSelfHostedRunnersForRepo({ owner, repo })
  const runnersData = response.data.runners

  const runners: GitHubRunnerInfo[] = runnersData.map((r) => ({
    id: r.id,
    name: r.name,
    os: r.os,
    status: r.status,
    busy: r.busy,
    labels: r.labels.map((l) => l.name),
  }))

  const onlineIdleRunners = runners.filter((r) => r.status === 'online' && !r.busy)
  const hasSelfHosted = onlineIdleRunners.length > 0

  let recommendedRunner: RunnerRequirement
  if (hasSelfHosted) {
    recommendedRunner = {
      type: 'self_hosted',
      os: onlineIdleRunners[0]?.os || 'linux',
      labels: ['self-hosted'],
    }
  } else {
    recommendedRunner = {
      type: 'hosted',
      os: 'ubuntu-latest',
    }
  }

  return {
    hasSelfHosted,
    runners,
    recommendedRunner,
  }
}
