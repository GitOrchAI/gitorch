/**
 * PROVA AO VIVO (D10, 01/09/2026) — chama o MESMO `ProjectV2Client.findProjectId`
 * do produto, do MESMO jeito que `scheduler.ts` (avaliarCustoDaOrdem) chama
 * (ownerType:'organization' primeiro, fallback 'user'), contra as duas
 * contas reais, com a credencial de produção (mesmo padrão de
 * `prova-fila-so-de-tasks.ts`: token via `gh auth token`, nada hardcoded).
 *
 * Uso:
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   pnpm exec tsx scripts/prova-d10-conta-pessoal.ts
 */
import { ProjectV2Client } from '@gitorch/github-sync'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_BACKFILL_TOKEN')

async function tenta(login: string, number: number): Promise<void> {
  const client = new ProjectV2Client({ token: TOKEN })
  const t0 = Date.now()
  try {
    const id =
      (await client.findProjectId({ login, number, ownerType: 'organization' })) ??
      (await client.findProjectId({ login, number, ownerType: 'user' }))
    console.log(`OK   ${login}#${number} -> ${id} (${Date.now() - t0}ms)`)
  } catch (err) {
    console.log(`ERRO ${login}#${number} -> ${(err as Error).message} (${Date.now() - t0}ms)`)
  }
}

async function main(): Promise<void> {
  console.log('=== CASO 1: GitOrchAI (organização) — precisa continuar funcionando ===')
  await tenta('GitOrchAI', 2)
  console.log('')
  console.log('=== CASO 2: loureng (conta PESSOAL) — o que estava quebrado em produção ===')
  await tenta('loureng', 3)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
