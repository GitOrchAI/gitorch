/**
 * D12 — catch-up das issues que o produto criou ANTES de o board estar
 * apontado certo (D11). Sem esta passada, elas ficam de fora do quadro para
 * sempre: `addToBoard` só roda no instante em que a issue NASCE.
 *
 * MEDIDO em 01/09/2026 contra loureng/patinhas-3d-crafts: 96 issues abertas,
 * ZERO no quadro. Das 96, 85 são do PRODUTO (marcador `gitorch:node:...` no
 * corpo ou etiqueta `gitorch:agent:*`) — as outras 11 são "wishlist" (pedido
 * do dono, ainda não virou plano) ou "security" (Dependabot) e NUNCA entram
 * aqui (`issueECriadaPeloProduto`, backfill-itens-no-quadro.ts).
 *
 * 85 num quadro de 146 itens é mais da metade do tamanho atual — o tipo de
 * mudança que muda a CARA do quadro que o dono cura à mão. Por isso este
 * script tem `GITORCH_BACKFILL_LIMITE` (obrigatório, sem default): quem roda
 * decide o tamanho do lote, nunca o script sozinho. Rodar de novo com um
 * número maior pega de onde parou — idempotente (`numerosJaNoQuadro` +
 * a idempotência do próprio `addToBoard`, do lado do GitHub).
 *
 * NÃO toca nos 9 campos que o dono cura à mão (Layer, Workflow Stage, Owner
 * Role, Priority, Health, Hermes Focus, Hermes Score, Delegated,
 * WorkflowStage): só adiciona o item ao quadro, nunca escreve neles.
 *
 * Config por ambiente (nada hardcoded — repo público, cada cliente tem seu):
 *   GITORCH_BACKFILL_TOKEN            (obrigatório) token do CLIENTE, escopo
 *                                      repo+project — o App é cego para
 *                                      Projects V2 de conta pessoal (D12)
 *   GITORCH_BACKFILL_REPOSITORIO      (obrigatório) "dono/repo"
 *   GITORCH_BACKFILL_OWNER            (obrigatório) login do dono do quadro
 *   GITORCH_BACKFILL_OWNER_TYPE       (opcional, default "user") user|organization
 *   GITORCH_BACKFILL_PROJECT_NUMBER   (obrigatório) número do Project v2
 *   GITORCH_BACKFILL_LIMITE           (obrigatório) tamanho do lote desta passada
 *   GITORCH_BACKFILL_NIVEL_DE_AUTONOMIA (obrigatório) so_olhar|sugerir|cuidar —
 *                                      o nível REAL do projeto (confira no banco;
 *                                      "organizar" só é permitido em sugerir/cuidar)
 *
 * Uso:
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   GITORCH_BACKFILL_REPOSITORIO=loureng/patinhas-3d-crafts \
 *   GITORCH_BACKFILL_OWNER=loureng \
 *   GITORCH_BACKFILL_PROJECT_NUMBER=3 \
 *   GITORCH_BACKFILL_LIMITE=3 \
 *   GITORCH_BACKFILL_NIVEL_DE_AUTONOMIA=cuidar \
 *   pnpm exec tsx scripts/backfill-itens-no-quadro.ts
 */
import { ProjectV2Client } from '@gitorch/github-sync'
import { createGithubBacklog } from '../src/services/github-backlog.js'
import { backfillItensNoQuadro } from '../src/services/backfill-itens-no-quadro.js'
import { fetchDoRepositorio } from '../src/services/guarda-de-autonomia.js'
import type { NivelDeAutonomia } from '@gitorch/cadence'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_BACKFILL_TOKEN')
const REPOSITORIO = requiredEnv('GITORCH_BACKFILL_REPOSITORIO')
const OWNER = requiredEnv('GITORCH_BACKFILL_OWNER')
const OWNER_TYPE = (process.env['GITORCH_BACKFILL_OWNER_TYPE'] ?? 'user') as 'user' | 'organization'
const PROJECT_NUMBER = Number(requiredEnv('GITORCH_BACKFILL_PROJECT_NUMBER'))
const LIMITE = Number(requiredEnv('GITORCH_BACKFILL_LIMITE'))
// GUARDA DE AUTONOMIA (D12): adicionar item ao quadro é ESCRITA
// (`addProjectV2ItemById` → família 'organizar' em guarda-de-autonomia.ts,
// medido, não suposto). MEDIDO no banco em 01/09/2026: o projeto
// loureng/patinhas-3d-crafts está em "cuidar" — a família 'organizar' é
// permitida. Exigido como env (nunca hardcoded "cuidar" por default): quem
// roda este script CONFERE o nível real antes, e o script recusa sozinho se
// o nível não permitir.
const NIVEL_DE_AUTONOMIA = requiredEnv('GITORCH_BACKFILL_NIVEL_DE_AUTONOMIA') as NivelDeAutonomia

const GITHUB_API = 'https://api.github.com'

async function issuesAbertas(): Promise<
  Array<{ number: number; nodeId: string; labels: string[]; corpo: string | null }>
> {
  const resultado: Array<{
    number: number
    nodeId: string
    labels: string[]
    corpo: string | null
  }> = []
  let pagina = 1
  for (;;) {
    const res = await fetch(
      `${GITHUB_API}/repos/${REPOSITORIO}/issues?state=open&per_page=100&page=${pagina}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gitorch-backfill-quadro',
        },
      }
    )
    if (!res.ok) throw new Error(`GET issues (página ${pagina}) HTTP ${res.status}`)
    const lote = (await res.json()) as Array<{
      number: number
      node_id: string
      body?: string | null
      pull_request?: unknown
      labels: Array<{ name: string } | string>
    }>
    for (const item of lote) {
      if (item.pull_request) continue
      resultado.push({
        number: item.number,
        nodeId: item.node_id,
        labels: item.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        corpo: item.body ?? null,
      })
    }
    if (lote.length < 100) break
    pagina += 1
  }
  return resultado
}

async function main(): Promise<void> {
  if (!Number.isInteger(LIMITE) || LIMITE < 0) {
    throw new Error(`GITORCH_BACKFILL_LIMITE inválido: "${process.env['GITORCH_BACKFILL_LIMITE']}"`)
  }

  const leitor = new ProjectV2Client({ token: TOKEN })
  const projectId = await leitor.getProjectId({
    login: OWNER,
    number: PROJECT_NUMBER,
    ownerType: OWNER_TYPE,
  })
  console.log(`[backfill-quadro] quadro resolvido: ${OWNER}/${PROJECT_NUMBER} -> ${projectId}`)

  const antesDaPassada = await leitor.listarItensDoQuadro(projectId, {})
  console.log(`[backfill-quadro] itens no quadro ANTES: ${antesDaPassada.length}`)

  const github = createGithubBacklog({
    token: TOKEN,
    boardToken: TOKEN,
    repository: REPOSITORIO,
    projectId,
    // A MESMA porta de produção (fetchDoRepositorio: teto de tempo + guarda
    // de autonomia) — nunca o `fetch` cru, e nunca o default fail-closed
    // (`fetchSemPermissao`, que travaria em "só olhar" mesmo o projeto
    // estando em "cuidar" no banco).
    fetchImpl: fetchDoRepositorio({ nivel: () => NIVEL_DE_AUTONOMIA }),
  })

  const resultado = await backfillItensNoQuadro({
    listarIssuesAbertas: issuesAbertas,
    numerosJaNoQuadro: async () => new Set(antesDaPassada.map((i) => i.pedido)),
    adicionarAoQuadro: (nodeId) => github.addToBoard(nodeId),
    limite: LIMITE,
  })

  const depoisDaPassada = await leitor.listarItensDoQuadro(projectId, {})

  console.log('')
  console.log('=== RESULTADO ===')
  console.log(`issues abertas no repositório:            ${resultado.totalAbertas}`)
  console.log(`candidatas (marcador ou etiqueta de agente): ${resultado.candidatas}`)
  console.log(`já estavam no quadro:                     ${resultado.jaNoQuadro}`)
  console.log(`adicionadas AGORA (limite=${LIMITE}):       ${resultado.adicionadasAgora}`)
  if (resultado.issuesAdicionadas.length > 0) {
    console.log(`issues adicionadas: ${resultado.issuesAdicionadas.map((n) => `#${n}`).join(', ')}`)
  }
  const restantes = resultado.candidatas - resultado.jaNoQuadro - resultado.adicionadasAgora
  if (restantes > 0) {
    console.log(`AINDA FORA do quadro (candidatas não tentadas por causa do limite): ${restantes}`)
  }
  console.log(`itens no quadro ANTES: ${antesDaPassada.length}  DEPOIS: ${depoisDaPassada.length}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
