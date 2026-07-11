/**
 * Registro dogfood (Fase 0): cria os projetos do dono (loureng/gitorch e
 * loureng/patinhas-3d-crafts) como Project reais, com github_repo_id preenchido
 * (o wizard não preenchia -> "Project not found"). Espelha a criação do
 * setup.ts (runtimeConfig + ensureDefaultSchedules + missão de clone).
 * Idempotente: re-rodar só atualiza os IDs / garante schedules.
 *
 * Uso: DATABASE_URL=<prod> pnpm exec tsx scripts/register-owner-projects.ts
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { F6_AGENT_ROLES } from '@gitorch/agents'
import { ensureDefaultSchedules } from '../src/lib/project-defaults.js'

const prisma = new PrismaClient()

// Dono (user#1, dogfood) e a instalação do GitHub App — dos dados reais do banco.
const OWNER_ID = 'cmr9zrisy00001o9le1yodaoo'
const ENGINES = ['codex'] // único motor CONECTADO hoje (Antigravity/Claude = login assistido pendente)
const PLAN = 'free'

const REPOS = [
  { full: 'loureng/gitorch', name: 'gitorch', repoId: 1274419899 },
  { full: 'loureng/patinhas-3d-crafts', name: 'patinhas-3d-crafts', repoId: 1032704304 },
]

async function main(): Promise<void> {
  // Mesmo formato que resolveRuntimeChain lê: cada papel aponta pro motor primário.
  const agentsConfig = Object.fromEntries(
    F6_AGENT_ROLES.map((role) => [role, { runtime: 'codex' }])
  )
  const runtimeConfig = {
    engines: ENGINES,
    agents: agentsConfig,
    telegram: null,
    plan: PLAN,
    envConfig: null,
  } as Prisma.JsonObject

  for (const r of REPOS) {
    let project = await prisma.project.findFirst({ where: { wingId: r.full } })
    if (project) {
      project = await prisma.project.update({
        where: { id: project.id },
        data: { githubRepoId: BigInt(r.repoId) },
      })
      console.log(`[existe] ${r.full} -> ${project.id} (repoId atualizado)`)
    } else {
      project = await prisma.project.create({
        data: {
          wingId: r.full,
          name: r.name,
          description: `Project for ${r.full}`,
          userId: OWNER_ID,
          githubRepoId: BigInt(r.repoId),
          runtimeConfig,
        },
      })
      console.log(`[criado] ${r.full} -> ${project.id}`)
    }

    await ensureDefaultSchedules(prisma, project.id)

    const existingMission = await prisma.mission.findFirst({
      where: { projectId: project.id, type: 'clone_and_start_engines' },
    })
    if (!existingMission) {
      await prisma.mission.create({
        data: {
          projectId: project.id,
          type: 'clone_and_start_engines',
          payload: {
            repoUrl: `https://github.com/${r.full}`,
            engines: ENGINES,
            telegram: null,
            envConfig: null,
          } as Prisma.JsonObject,
          status: 'pending',
        },
      })
      console.log(`  missão de clone enfileirada`)
    }
  }

  const total = await prisma.project.count()
  const schedules = await prisma.projectSchedule.findMany({
    select: { agentRole: true, cron: true, isActive: true, project: { select: { wingId: true } } },
  })
  console.log(`\ntotal de projetos: ${total}`)
  for (const s of schedules) {
    console.log(`  ${s.project.wingId} | ${s.agentRole} | ${s.cron} | active=${s.isActive}`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    return prisma.$disconnect().finally(() => process.exit(1))
  })
