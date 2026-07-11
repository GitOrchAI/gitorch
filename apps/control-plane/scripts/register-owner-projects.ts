/**
 * Registra projetos (Project) para um usuário, com github_repo_id preenchido —
 * o wizard não preenchia esse campo, então o webhook (que resolve por repo_id)
 * dava "Project not found". Espelha a criação do setup.ts (runtimeConfig +
 * ensureDefaultSchedules + missão de clone). Idempotente: re-rodar só atualiza
 * os IDs / garante schedules.
 *
 * Config por ambiente (nada de ID hardcoded — repo público):
 *   GITORCH_OWNER_USER_ID   (obrigatório) id do User dono dos projetos
 *   GITORCH_REGISTER_REPOS  (obrigatório) JSON: [{ "full":"owner/repo", "name":"repo", "repoId":123 }]
 *   GITORCH_REGISTER_ENGINES (opcional, default "codex") lista separada por vírgula
 *   GITORCH_REGISTER_PLAN    (opcional, default "free")
 *   DATABASE_URL             (obrigatório) banco alvo
 *
 * Uso: DATABASE_URL=... GITORCH_OWNER_USER_ID=... GITORCH_REGISTER_REPOS='[...]' \
 *      pnpm exec tsx scripts/register-owner-projects.ts
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { F6_AGENT_ROLES } from '@gitorch/agents'
import { ensureDefaultSchedules } from '../src/lib/project-defaults.js'

interface RepoInput {
  full: string
  name: string
  repoId: number
}

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const prisma = new PrismaClient()

const OWNER_ID = requiredEnv('GITORCH_OWNER_USER_ID')
const REPOS = JSON.parse(requiredEnv('GITORCH_REGISTER_REPOS')) as RepoInput[]
const ENGINES = (process.env['GITORCH_REGISTER_ENGINES'] ?? 'codex').split(',').map((s) => s.trim())
const PLAN = process.env['GITORCH_REGISTER_PLAN'] ?? 'free'

async function main(): Promise<void> {
  // Mesmo formato que resolveRuntimeChain lê: cada papel aponta pro motor primário.
  const primary = ENGINES[0]
  const agentsConfig = Object.fromEntries(
    F6_AGENT_ROLES.map((role) => [role, { runtime: primary }])
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
  console.log(`\ntotal de projetos: ${total}`)
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    return prisma.$disconnect().finally(() => process.exit(1))
  })
