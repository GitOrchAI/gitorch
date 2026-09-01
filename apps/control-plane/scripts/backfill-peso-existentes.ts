/**
 * D8 — preenche o campo "Peso" dos itens que já existiam no quadro do
 * cliente quando `setWeight` nasceu (PR #417, 31/08/2026). O mecanismo novo
 * só cobre issue NOVA; sem esta passada a feature "Sua ordem custa caro?"
 * (D1) fica muda por semanas — foi o que já aconteceu com o campo Sprint
 * (PR #416): mecanismo no ar, quadro do dono com 3 de 124 preenchidos até
 * este mesmo levantamento achar o irmão gêmeo no campo Peso.
 *
 * NÃO CHUMBA o id do campo nem o id do quadro: os dois são descobertos por
 * nome/número, do jeito que `createGithubBacklog` já faz — cada cliente tem
 * um quadro diferente. Se "Peso" não existir como NUMBER, tenta CRIAR (mesmo
 * precedente de `resolvePesoField`/`criarCampoNumerico` em
 * github-backlog.ts); se não der (nome ocupado por outro tipo), este script
 * PARA e diz por quê — nunca segue em silêncio.
 *
 * NÃO INVENTA peso: onde o corpo da issue não tem "## Peso" (fase/épico/
 * feature — nunca carregam peso por desenho — ou issue anterior ao PR #417,
 * ou valor fora da ESCALA_DE_PESO), o item fica sem peso e entra na
 * contagem `semPesoNoCorpo` do relatório final.
 *
 * Config por ambiente (nada hardcoded — repo público, e cada cliente tem
 * quadro próprio):
 *   GITORCH_BACKFILL_TOKEN           (obrigatório) token com escopo project+repo
 *   GITORCH_BACKFILL_OWNER           (obrigatório) login da org/usuário dono do quadro
 *   GITORCH_BACKFILL_OWNER_TYPE      (opcional, default "organization") organization|user
 *   GITORCH_BACKFILL_PROJECT_NUMBER  (obrigatório) número do Project v2 (ex.: 2)
 *   GITORCH_BACKFILL_WEIGHT_FIELD    (opcional, default "Peso") nome do campo NUMBER
 *
 * Uso:
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   GITORCH_BACKFILL_OWNER=GitOrchAI \
 *   GITORCH_BACKFILL_PROJECT_NUMBER=2 \
 *   pnpm exec tsx scripts/backfill-peso-existentes.ts
 */
import {
  ProjectV2Client,
  CampoNumericoAusenteError,
  NomeDeCampoEmConflitoError,
} from '@gitorch/github-sync'
import { backfillPesoDosItensExistentes } from '../src/services/backfill-peso-existentes.js'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_BACKFILL_TOKEN')
const OWNER = requiredEnv('GITORCH_BACKFILL_OWNER')
const OWNER_TYPE = (process.env['GITORCH_BACKFILL_OWNER_TYPE'] ?? 'organization') as
  'organization' | 'user'
const PROJECT_NUMBER = Number(requiredEnv('GITORCH_BACKFILL_PROJECT_NUMBER'))
const WEIGHT_FIELD = process.env['GITORCH_BACKFILL_WEIGHT_FIELD'] ?? 'Peso'

async function main(): Promise<void> {
  if (!Number.isInteger(PROJECT_NUMBER) || PROJECT_NUMBER <= 0) {
    throw new Error(
      `GITORCH_BACKFILL_PROJECT_NUMBER inválido: "${process.env['GITORCH_BACKFILL_PROJECT_NUMBER']}"`
    )
  }

  const client = new ProjectV2Client({ token: TOKEN })

  const projectId = await client.getProjectId({
    login: OWNER,
    number: PROJECT_NUMBER,
    ownerType: OWNER_TYPE,
  })
  console.log(`[backfill-peso] quadro resolvido: ${OWNER}/${PROJECT_NUMBER} -> ${projectId}`)

  // Ler-depois-criar, mesma ordem de resolvePesoField (github-backlog.ts):
  // criar às cegas devolve "Name has already been taken" quando o campo já
  // existe — confirmado ao vivo em 31/08/2026.
  let fieldId: string
  try {
    fieldId = (await client.getNumberField({ projectId, fieldName: WEIGHT_FIELD })).fieldId
    console.log(`[backfill-peso] campo "${WEIGHT_FIELD}" já existe: ${fieldId}`)
  } catch (error) {
    if (error instanceof CampoNumericoAusenteError) {
      fieldId = (await client.criarCampoNumerico({ projectId, fieldName: WEIGHT_FIELD })).fieldId
      console.log(`[backfill-peso] campo "${WEIGHT_FIELD}" criado: ${fieldId}`)
    } else if (error instanceof NomeDeCampoEmConflitoError) {
      throw new Error(
        `[backfill-peso] PAROU: existe um campo "${WEIGHT_FIELD}" de outro tipo no quadro ` +
          `${OWNER}/${PROJECT_NUMBER}. Preciso que o dono renomeie ou apague antes de eu ` +
          `continuar — não vou inventar outro nome. Detalhe: ${String(error)}`
      )
    } else {
      throw error
    }
  }

  let leituraIncompleta = false
  const itens = await client.listarItensDoQuadro(projectId, {
    campoDePeso: WEIGHT_FIELD,
    comCorpo: true,
    onTruncado: () => {
      leituraIncompleta = true
    },
  })
  if (leituraIncompleta) {
    throw new Error(
      `[backfill-peso] PAROU: a leitura do quadro foi cortada pelo teto de páginas — a lista ` +
        `não é o quadro inteiro. Rodar o backfill sobre uma lista incompleta deixaria itens de ` +
        `fora sem ninguém notar. Aumente o teto ou rode de novo.`
    )
  }
  console.log(`[backfill-peso] ${itens.length} itens lidos do quadro.`)

  const resultado = await backfillPesoDosItensExistentes({
    listarItens: async () =>
      itens.map((i) => ({
        itemId: i.itemId,
        issueNumber: i.pedido,
        pesoAtual: i.peso,
        corpo: i.corpo,
      })),
    gravarPeso: async (itemId, peso) => {
      await client.setNumberField({ projectId, itemId, fieldId, number: peso })
    },
  })

  console.log('')
  console.log('=== RESULTADO ===')
  console.log(`total de itens no quadro:        ${resultado.totalItens}`)
  console.log(`já tinham peso no campo:         ${resultado.jaTinhaPeso}`)
  console.log(`preenchidos AGORA (a partir do corpo): ${resultado.preenchidosAgora}`)
  console.log(
    `ficaram SEM peso (sem "## Peso" no corpo, ou fora da escala): ${resultado.semPesoNoCorpo}`
  )
  if (resultado.issuesSemPeso.length > 0) {
    console.log(
      `issues que ficaram sem peso: ${resultado.issuesSemPeso.map((n) => `#${n}`).join(', ')}`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
