/**
 * PROVA EM PRODUÇÃO (D9, 01/09) — roda `filtrarFilaDeTasks` contra o quadro
 * REAL (GitOrchAI #2) e mostra o resultado: ou a fila calculável (só
 * tasks, todas com peso), ou o motivo exato do silêncio com a contagem.
 *
 * Script de verificação, não faz parte do produto — mesmo padrão de
 * `backfill-peso-existentes.ts` (token via `gh auth token`, nada
 * hardcoded).
 *
 * Uso:
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   pnpm exec tsx scripts/prova-fila-so-de-tasks.ts
 */
import { ProjectV2Client } from '@gitorch/github-sync'
import { filtrarFilaDeTasks } from '../src/services/filtrar-fila-de-tasks.js'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_BACKFILL_TOKEN')
const OWNER = process.env['GITORCH_BACKFILL_OWNER'] ?? 'GitOrchAI'
const OWNER_TYPE = (process.env['GITORCH_BACKFILL_OWNER_TYPE'] ?? 'organization') as
  'organization' | 'user'
const PROJECT_NUMBER = Number(process.env['GITORCH_BACKFILL_PROJECT_NUMBER'] ?? '2')

async function main(): Promise<void> {
  const client = new ProjectV2Client({ token: TOKEN })

  const projectId =
    (await client.findProjectId({ login: OWNER, number: PROJECT_NUMBER, ownerType: OWNER_TYPE })) ??
    (await client.findProjectId({
      login: OWNER,
      number: PROJECT_NUMBER,
      ownerType: OWNER_TYPE === 'organization' ? 'user' : 'organization',
    }))
  if (!projectId) throw new Error(`Quadro ${OWNER}#${PROJECT_NUMBER} não encontrado`)

  let leituraIncompleta = false
  const itens = await client.listarItensDoQuadro(projectId, {
    campoDePeso: 'Peso',
    comCorpo: true,
    onTruncado: () => {
      leituraIncompleta = true
    },
  })

  console.log(`Quadro ${OWNER}#${PROJECT_NUMBER}: ${itens.length} item(ns) lido(s) no total.`)
  if (leituraIncompleta) {
    console.log('LEITURA INCOMPLETA (teto de páginas) — mesma prudência do produto: silêncio.')
    return
  }

  const resultado = filtrarFilaDeTasks(
    itens.map((i) => ({ pedido: i.pedido, peso: i.peso, corpo: i.corpo }))
  )

  if (resultado.fila) {
    console.log(`FILA CALCULÁVEL: ${resultado.fila.length} task(s), todas com peso conhecido.`)
    console.log(JSON.stringify(resultado.fila, null, 2))
    return
  }

  console.log(`SILÊNCIO — motivo: ${resultado.motivo}`)
  if (resultado.motivo === 'sem-peso') {
    console.log(
      `${resultado.semPeso.length} de ${resultado.totalDeTasks} task(s) ainda sem peso: ` +
        `#${resultado.semPeso.join(', #')}`
    )
  } else if (resultado.motivo === 'peso-fora-da-escala') {
    console.log(
      `${resultado.pedidos.length} de ${resultado.totalDeTasks} task(s) com peso fora da escala: ` +
        `#${resultado.pedidos.join(', #')}`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
