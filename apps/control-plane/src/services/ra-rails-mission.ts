import { wrapClientRequest } from '@gitorch/cadence'
import { runRaRails, type StepExecutor } from './role-rails.js'

// Missão do RA nos TRILHOS: ancora a análise na WISH ABERTA (mesmo gatilho do
// PO). Sem isso o RA analisa o projeto em abstrato — ou pior, a wish ANTERIOR
// que ficou na memória (visto em prova real de dogfooding). Sem wish aberta, segue
// como scout geral do projeto (útil do mesmo jeito).

export interface RaRailsMissionOptions {
  repository: string
  githubToken?: string | undefined
  execute: StepExecutor
  contextBlocks: string[]
  fetchImpl?: typeof fetch
}

export interface RaRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
}

export async function runRaMissionViaRails(
  options: RaRailsMissionOptions
): Promise<RaRailsMissionResult> {
  const f = options.fetchImpl ?? fetch

  // A wish é o ponto de ancoragem — best-effort: sem token ou sem wish aberta,
  // o RA roda como scout geral (não é erro).
  let wishBlock: string[] = []
  if (options.githubToken) {
    try {
      const resp = await f(
        `https://api.github.com/repos/${options.repository}/issues?labels=wishlist&state=open&sort=created&direction=desc&per_page=1`,
        {
          headers: {
            authorization: `token ${options.githubToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'gitorch',
          },
        }
      )
      if (resp.ok) {
        const wishes = (await resp.json()) as Array<{
          number: number
          title: string
          body?: string
        }>
        const wish = Array.isArray(wishes) ? wishes[0] : undefined
        if (wish) {
          // Item 6 (leva B2): `wish.body` é texto livre do cliente — nunca
          // uma instrução ao RA. `wrapClientRequest` (packages/cadence)
          // marca isso explicitamente, bem ao lado do texto.
          wishBlock = [
            `Wish under analysis (the client's CURRENT desire — anchor every area and journey on THIS, not on past work): #${wish.number} ${wish.title}\n${wrapClientRequest(wish.body ?? '')}`,
          ]
        }
      }
    } catch {
      /* wish é ancoragem, não pré-requisito */
    }
  }

  const ra = await runRaRails(options.execute, [...wishBlock, ...options.contextBlocks])
  return { exitCode: 0, output: ra.text, stderr: '' }
}
