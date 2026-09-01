/**
 * PROVA AO VIVO (D11, 01/09/2026) — aponta o Jardim das Patinhas para o
 * quadro REAL do dono (loureng/3, "Jardim das Patinhas", 146 itens) em vez
 * do quadro vazio que o próprio produto criou por engano (loureng/12), e
 * prova com a API real e o mesmo código de produção que:
 *
 *   1) `runtime_config.envConfig.GITORCH_PROJECT_BOARD` muda de 'loureng/12'
 *      para 'loureng/3' — MESCLA, nunca substitui o objeto inteiro (mesmo
 *      padrão de `scheduler.ts`).
 *   2) `decidirQuadro` (o MESMO código de `varrerSprintDosProjetos` e
 *      `varrerItensDaSprint`) escolhe o #3 sozinho, sem "continue" mudo,
 *      porque o #5 (fechado, 0 itens) sai da disputa na primeira regra.
 *   3) O campo "Peso" não existe no #3 — confere ANTES de criar — e é criado
 *      pelo MESMO caminho de produção (`criarCampoNumerico`, o precedente de
 *      `garantirSprintNoQuadro`).
 *   4) O campo "Sprint" já existe, é do tipo ITERAÇÃO, e não é recriado nem
 *      reconfigurado — só lido.
 *   5) O produto agora LÊ os 146 itens do quadro (mesma leitura que
 *      `custo da ordem` usa) e `filtrarFilaDeTasks` roda contra dado real.
 *   6) Quantos itens ATIVOS reais (sessões vivas do dev assíncrono + issues
 *      com etiqueta de execução, ambos lidos ao vivo) entraram na sprint
 *      corrente.
 *
 * ESCREVE no quadro real do dono: cria o campo "Peso" (vazio, se ausente) e
 * move para dentro da sprint corrente os itens que já estão ativos hoje —
 * exatamente o que o dono aceitou ao escolher D11. Nada além disso: nenhum
 * campo do dono (Layer, Workflow Stage, Owner Role, Priority, Health, Hermes
 * Focus, Hermes Score, Delegated, WorkflowStage, Sprint (texto antigo)) é
 * tocado por este script.
 *
 * Script de verificação, não faz parte do produto — mesmo padrão de
 * `prova-d10-conta-pessoal.ts`/`prova-fila-so-de-tasks.ts` (token via
 * `gh auth token`, nada hardcoded) mais `DATABASE_URL` para a mudança de
 * dado, mesmo padrão de `register-owner-projects.ts`.
 *
 * Uso:
 *   DATABASE_URL=postgresql://ubuntu@localhost/gitorch_control_plane?host=/var/run/postgresql \
 *   GITORCH_BACKFILL_TOKEN=$(gh auth token) \
 *   pnpm exec tsx scripts/prova-d11-quadro-real.ts
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { ProjectV2Client, CampoNumericoAusenteError } from '@gitorch/github-sync'
import { decidirQuadro } from '../src/services/resolver-quadro.js'
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
const [OWNER, REPO_NAME] = WING_ID.split('/') as [string, string]
const NOVO_BOARD = 'loureng/3'

const GITHUB_API = 'https://api.github.com'
const ETIQUETAS_DE_EXECUCAO = [
  'gitorch:agent:sm',
  'gitorch:agent:jules',
  'gitorch:agent:qa',
] as const

async function issuesComEtiqueta(etiqueta: string): Promise<number[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${WING_ID}/issues?state=open&per_page=100&labels=${encodeURIComponent(etiqueta)}`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitorch-prova-d11',
      },
    }
  )
  if (!res.ok) throw new Error(`GET issues?labels=${etiqueta} HTTP ${res.status}`)
  const lista = (await res.json()) as Array<{ number: number; pull_request?: unknown }>
  return lista.filter((i) => !i.pull_request).map((i) => i.number)
}

const prisma = new PrismaClient()

async function main(): Promise<void> {
  // 0) Confere a linha certa ANTES de escrever qualquer coisa no banco.
  const projeto = await prisma.project.findFirst({ where: { wingId: WING_ID } })
  if (!projeto) throw new Error(`Projeto ${WING_ID} não encontrado no banco`)
  const runtimeConfigAtual = (projeto.runtimeConfig as Record<string, unknown> | null) ?? {}
  const envConfigAtual =
    (runtimeConfigAtual['envConfig'] as Record<string, unknown> | undefined) ?? {}
  console.log(`ANTES: GITORCH_PROJECT_BOARD = ${String(envConfigAtual['GITORCH_PROJECT_BOARD'])}`)

  // 1) MESCLA — nunca substitui runtimeConfig/envConfig inteiros (mesmo
  // padrão de scheduler.ts:1825-1838).
  const novoRuntimeConfig = {
    ...runtimeConfigAtual,
    envConfig: { ...envConfigAtual, GITORCH_PROJECT_BOARD: NOVO_BOARD },
  }
  await prisma.project.update({
    where: { id: projeto.id },
    data: { runtimeConfig: novoRuntimeConfig as Prisma.InputJsonValue },
  })
  const releitura = await prisma.project.findUniqueOrThrow({ where: { id: projeto.id } })
  const envDepois =
    ((releitura.runtimeConfig as Record<string, unknown>)['envConfig'] as Record<
      string,
      unknown
    >) ?? {}
  console.log(`DEPOIS: GITORCH_PROJECT_BOARD = ${String(envDepois['GITORCH_PROJECT_BOARD'])}`)
  if (envDepois['GITORCH_PROJECT_BOARD'] !== NOVO_BOARD) {
    throw new Error('A gravação no banco não bateu com o valor esperado — PARANDO.')
  }

  // 2) decidirQuadro com os candidatos REAIS ligados ao repositório — a
  // MESMA chamada de `varrerSprintDosProjetos`/`varrerItensDaSprint`.
  const leitor = new ProjectV2Client({ token: TOKEN })
  const candidatos = await leitor.listarQuadrosDoRepositorio({ owner: OWNER, repo: REPO_NAME })
  console.log(`\nQuadros ligados ao repositório ${WING_ID}: ${candidatos.length}`)
  for (const c of candidatos) {
    console.log(
      `  #${c.number} "${c.title}" closed=${c.closed} itens=${c.itensCount} campos=${c.camposCount}`
    )
  }
  const decisao = decidirQuadro({ candidatos: candidatos.map((c) => ({ ...c, linkado: true })) })
  console.log(`decidirQuadro -> ${decisao.acao}: ${decisao.motivo}`)
  if (decisao.acao !== 'usar') {
    throw new Error(
      `decidirQuadro NÃO escolheu um quadro sozinho (ação: ${decisao.acao}) — PARANDO, não mexo em nada.`
    )
  }
  const projectId = decisao.quadro.id
  console.log(
    `Quadro escolhido: #${decisao.quadro.number} "${decisao.quadro.title}" (${projectId})`
  )

  // 3) Campo "Peso" — CONFERE antes de criar (nunca duplicar).
  try {
    const existente = await leitor.getNumberField({ projectId, fieldName: 'Peso' })
    console.log(`\nCampo "Peso" JÁ EXISTE (fieldId=${existente.fieldId}) — não crio outro.`)
  } catch (erro) {
    if (!(erro instanceof CampoNumericoAusenteError)) throw erro
    console.log('\nCampo "Peso" ausente — criando pelo caminho de produção (criarCampoNumerico)...')
    const criado = await leitor.criarCampoNumerico({ projectId, fieldName: 'Peso' })
    console.log(`Campo "Peso" criado: fieldId=${criado.fieldId}`)
  }

  // 4) Campo "Sprint" — só LÊ. Já existe, é do dono, nunca é recriado.
  const sprintField = await leitor.getIterationField({ projectId, fieldName: 'Sprint' })
  console.log(
    `\nCampo "Sprint" (fieldId=${sprintField.fieldId}): ${sprintField.iterations.length} iteração(ões) — ` +
      sprintField.iterations
        .map((it) => `${it.title} (início ${it.startDate}, ${it.duration}d)`)
        .join(', ')
  )

  // 5) Os itens do quadro, pela MESMA leitura que `custo da ordem` usa.
  let leituraIncompleta = false
  const itens = await leitor.listarItensDoQuadro(projectId, {
    campoDeSprint: 'Sprint',
    campoDePeso: 'Peso',
    comCorpo: true,
    onTruncado: () => {
      leituraIncompleta = true
    },
  })
  console.log(
    `\nItens lidos do quadro: ${itens.length}${leituraIncompleta ? ' (LEITURA INCOMPLETA — teto de páginas)' : ''}`
  )

  const filtro = filtrarFilaDeTasks(
    itens.map((i) => ({ pedido: i.pedido, peso: i.peso, corpo: i.corpo }))
  )
  if (filtro.fila) {
    console.log(`custo da ordem: FILA CALCULÁVEL com ${filtro.fila.length} task(s).`)
  } else if (filtro.motivo === 'sem-task-nenhuma') {
    console.log(
      'custo da ordem: nenhum item do quadro tem o marcador de task do produto ainda (silêncio normal).'
    )
  } else if (filtro.motivo === 'sem-peso') {
    console.log(
      `custo da ordem: ${filtro.semPeso.length} de ${filtro.totalDeTasks} task(s) ainda sem peso: ` +
        `#${filtro.semPeso.join(', #')}`
    )
  } else {
    console.log(
      `custo da ordem: ${filtro.pedidos.length} de ${filtro.totalDeTasks} task(s) com peso fora da escala: ` +
        `#${filtro.pedidos.join(', #')}`
    )
  }

  // 6) Sprint com itens — trabalho ativo REAL, lido ao vivo (banco + GitHub),
  // mesma composição de fontes de `varrerItensDaSprint`.
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
  console.log(
    `\nTrabalho ativo real (sessões vivas + etiquetas de execução): ${ativos.length} pedido(s) — ` +
      `#${ativos.map((a) => a.pedido).join(', #')}`
  )

  const relatorio = await preencherSprintCorrente(
    {
      quadro: leitor,
      nivel: () => 'cuidar',
      trabalhoAtivo: async () => ativos,
      hoje: () => hojeNoFuso(),
    },
    { projectId }
  )
  console.log(`\npreencherSprintCorrente: ${relatorio.oQueFiz}`)
  console.log(
    `  entraram=${relatorio.entraram.length} jaEstavam=${relatorio.jaEstavam.length} ` +
      `emOutraIteracao=${relatorio.emOutraIteracao.length} foraDoQuadro=${relatorio.foraDoQuadro.length}`
  )
  if (relatorio.entraram.length > 0) {
    console.log(`  entraram: #${relatorio.entraram.map((e) => e.pedido).join(', #')}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
