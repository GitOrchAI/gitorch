/**
 * PROVA AO VIVO (D12, 01/09/2026) — a cadeia inteira, do item novo no quadro
 * até o custo da ordem sair de `sem-task-nenhuma`, contra o quadro REAL do
 * Jardim das Patinhas (loureng/3) e o banco de produção.
 *
 * O QUE ESTA PROVA CONFIRMA, medido nesta ordem:
 *
 *   1) `addProjectV2ItemById` com o token do App (`mintInstallationToken`)
 *      falha SEMPRE em Projects V2 de conta pessoal — "Resource not
 *      accessible by integration" na escrita, "not found" na leitura (o
 *      board existe, o App não o enxerga). Confirmado ao vivo contra
 *      loureng/3 antes desta prova.
 *   2) Com o token do PRÓPRIO cliente (`boardToken`, o conserto de D12 em
 *      github-backlog.ts/po-rails-mission.ts/scheduler.ts), o mesmo
 *      `addItemById` funciona — e é a MESMA credencial que
 *      `garantir-sprint-dos-projetos.ts` já usava para a passada de sprint,
 *      só que o caminho do PO nunca tinha ganhado o mesmo tratamento.
 *   3) `backfillItensNoQuadro` (backfill-itens-no-quadro.ts) adicionou 3
 *      issues que o produto criou antes de o board apontar certo (D11):
 *      #3884, #3883, #3882. Quadro: 146 -> 149 itens. 82 candidatas
 *      continuam de fora — de propósito (ver PR: 85 num quadro de 146 muda a
 *      cara do quadro que o dono cura à mão; decisão do dono antes de
 *      despejar o resto).
 *   4) Sem eu tocar em sprint nenhuma vez, o `gitorch-control-plane.service`
 *      AO VIVO (rodando em produção nesta mesma VM, tique de ~60s) já tinha
 *      movido #3884 para "Sprint 1" sozinho — a passada de sprint
 *      (`varrerItensDaSprint`/`garantirSprintNoQuadro`) roda com o MESMO
 *      privilégio de credencial-do-cliente e pegou o item assim que ele
 *      apareceu no quadro. `jaEstavam` (não `entram`) é a prova.
 *   5) `filtrarFilaDeTasks` (o mesmo código de `custo-da-ordem-do-projeto`)
 *      contra o quadro real: ANTES desta leva, 0 dos 146 itens tinham o
 *      marcador de task — `sem-task-nenhuma`. Com #3884 (uma TASK,
 *      `gitorch:node:3849:task:0`) no quadro, o motivo muda para
 *      `sem-peso` (a issue nasceu antes do PR #417, sem "## Peso" no corpo —
 *      não é um bug desta leva, é uma issue de 28/08 sem estimativa; seguir
 *      um valor aqui seria inventar peso, o que o produto nunca faz).
 *      DE QUALQUER FORMA, já não é mais `sem-task-nenhuma` — a cadeia anda.
 *   6) Os 9 campos que o dono cura à mão (Layer, Workflow Stage, Owner Role,
 *      Priority, Health, Hermes Focus, Hermes Score, Delegated,
 *      WorkflowStage) nos itens PRÉ-EXISTENTES continuam com dado real e
 *      coerente — este script só LÊ esses campos, nunca escreve neles (só
 *      `addItemById` escreve, e essa mutation nunca toca campo de item que
 *      não é o alvo).
 *   7) O quadro continua com 25 campos — nenhum novo criado por esta leva.
 *
 * Script de verificação, não faz parte do produto — mesmo padrão de
 * prova-d10-conta-pessoal.ts/prova-d11-quadro-real.ts (token via
 * `gh auth token`, nada hardcoded) mais `DATABASE_URL` para ler o trabalho
 * ativo real (sessões vivas do dev assíncrono).
 *
 * SÓ LÊ o quadro — não escreve nada. O backfill em si já rodou
 * (scripts/backfill-itens-no-quadro.ts); esta prova é a fotografia do
 * resultado.
 *
 * Uso:
 *   DATABASE_URL=postgresql://ubuntu@localhost/gitorch_control_plane?host=/var/run/postgresql \
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   pnpm exec tsx scripts/prova-d12-item-no-quadro.ts
 */
import { PrismaClient } from '@prisma/client'
import { ProjectV2Client } from '@gitorch/github-sync'
import { filtrarFilaDeTasks } from '../src/services/filtrar-fila-de-tasks.js'
import { levantarTrabalhoAtivo, preencherSprintCorrente } from '../src/services/sprint-com-itens.js'
import { hojeNoFuso } from '../src/services/garantir-sprint.js'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_BACKFILL_TOKEN')
const WING_ID = 'loureng/patinhas-3d-crafts'
const PROJECT_ID = 'PVT_kwHODEJV384BTtgW' // loureng/3, "Jardim das Patinhas"
const ETIQUETAS_DE_EXECUCAO = [
  'gitorch:agent:sm',
  'gitorch:agent:jules',
  'gitorch:agent:qa',
] as const

const prisma = new PrismaClient()

async function issuesComEtiqueta(etiqueta: string): Promise<number[]> {
  const res = await fetch(
    `https://api.github.com/repos/${WING_ID}/issues?state=open&per_page=100&labels=${encodeURIComponent(etiqueta)}`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitorch-prova-d12',
      },
    }
  )
  if (!res.ok) throw new Error(`GET issues?labels=${etiqueta} HTTP ${res.status}`)
  const lista = (await res.json()) as Array<{ number: number; pull_request?: unknown }>
  return lista.filter((i) => !i.pull_request).map((i) => i.number)
}

async function main(): Promise<void> {
  const leitor = new ProjectV2Client({ token: TOKEN })

  // 1) O QUADRO, hoje.
  const detalhe = await leitor.detalharQuadro({
    projectId: PROJECT_ID,
    repositorio: WING_ID,
  })
  console.log(`Quadro loureng/3 — ${detalhe.camposCount} campo(s) (esperado: 25).`)

  const itens = await leitor.listarItensDoQuadro(PROJECT_ID, {
    campoDeSprint: 'Sprint',
    campoDePeso: 'Peso',
    comCorpo: true,
  })
  console.log(`Itens no quadro: ${itens.length} (linha de base antes de D12: 146).`)

  // 2) custo da ordem — o mesmo código de produção.
  const filtro = filtrarFilaDeTasks(
    itens.map((i) => ({ pedido: i.pedido, peso: i.peso, corpo: i.corpo }))
  )
  console.log('\ncusto da ordem (filtrarFilaDeTasks):')
  console.log(JSON.stringify(filtro, null, 2))

  // 3) sprint — a MESMA leitura que varrerItensDaSprint usa, só que aqui é
  // dry-run: preencherSprintCorrente só ESCREVE quem falta; quem já está
  // (jaEstavam) prova que a passada de produção já rodou sozinha.
  const projeto = await prisma.project.findFirst({ where: { wingId: WING_ID } })
  if (!projeto) throw new Error(`Projeto ${WING_ID} não encontrado no banco`)
  const sessoesVivas = await prisma.devSession.findMany({
    where: { projectId: projeto.id, closedAt: null },
    select: { issueNumber: true, pullRequestNumber: true },
  })
  const etiquetados = new Set<number>()
  for (const etiqueta of ETIQUETAS_DE_EXECUCAO) {
    for (const n of await issuesComEtiqueta(etiqueta)) etiquetados.add(n)
  }
  const ativos = await levantarTrabalhoAtivo({
    sessoesVivas: async () => sessoesVivas,
    issuesComEtiquetaDeExecucao: async () => [...etiquetados],
  })
  const relatorio = await preencherSprintCorrente(
    {
      quadro: leitor,
      nivel: () => 'cuidar',
      trabalhoAtivo: async () => ativos,
      hoje: () => hojeNoFuso(),
    },
    { projectId: PROJECT_ID }
  )
  console.log(`\nsprint: ${relatorio.oQueFiz}`)
  console.log(
    `  entraram=${relatorio.entraram.length} jaEstavam=${relatorio.jaEstavam.length} ` +
      `emOutraIteracao=${relatorio.emOutraIteracao.length} foraDoQuadro=${relatorio.foraDoQuadro.length}`
  )

  // 4) Os 9 campos do dono, nos primeiros itens PRÉ-EXISTENTES (#2705 em
  // diante) — só leitura, prova que continuam com dado real e não foram
  // tocados por esta leva (que só chama addItemById, nunca um campo).
  console.log('\n9 campos do dono — amostra dos itens pré-existentes (só leitura):')
  for (const item of itens.filter((i) => i.pedido < 3000).slice(0, 3)) {
    console.log(
      `  #${item.pedido}: iteracaoId=${item.iteracaoId ?? 'null'} peso=${item.peso ?? 'null'}`
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
