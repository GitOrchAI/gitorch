import { PrismaClient } from '@prisma/client'
import { ensureDefaultSchedules } from '../src/lib/project-defaults.js'

// Seed idempotente: cria os planos base e, fora do modo --plans-only, garante
// o usuário dono da instância e migra dados legados (projetos sem dono e
// agenda fixa) para o modelo multi-tenant.
//
// --plans-only (achado de review I5): scripts/db-migrate.sh SEMPRE roda com
// esta flag, em todo deploy. O bloco de upsert dos planos é seguro de repetir
// (só upsert). O bloco de dono/legado NÃO é — é uma migração de dados de
// 2025 (reivindicar pro dono da instância todo Project com userId nulo) que,
// promovida a hot path automático num sistema multi-tenant, reescreveria o
// projeto (missões e API keys inclusas) de um cliente real no dia em que
// qualquer caminho produzisse um userId nulo por engano (Project.userId é
// nulo só pra registro legado por design — ver prisma/schema.prisma). Por
// isso o bloco de dono/legado só roda SEM a flag, invocado manualmente e uma
// vez (`node_modules/.bin/tsx prisma/seed.ts`) — nunca em automação.
const PLANS_ONLY = process.argv.includes('--plans-only')

const prisma = new PrismaClient()

// Planos base. tierRank ordena a fila; maxConcurrentMissions é o teto de
// missões simultâneas do dono; features governa os direitos (entitlements).
// persistentMemory é o fosso de retenção (Free não tem, por decisão de produto).
const DEFAULT_PLANS = [
  {
    id: 'free',
    name: 'Free',
    maxProjects: 1,
    maxMissionsPerDay: 10,
    tierRank: 0,
    maxConcurrentMissions: 1,
    seats: 1,
    features: {
      autoAutonomy: false,
      sensors: false,
      priorityQueue: false,
      persistentMemory: false,
      sso: false,
    },
  },
  {
    id: 'solo',
    name: 'Solo',
    maxProjects: 2,
    maxMissionsPerDay: 30,
    tierRank: 1,
    maxConcurrentMissions: 1,
    seats: 1,
    features: {
      autoAutonomy: true,
      sensors: true,
      priorityQueue: false,
      persistentMemory: true,
      sso: false,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    maxProjects: 5,
    maxMissionsPerDay: 90,
    tierRank: 2,
    maxConcurrentMissions: 2,
    seats: 1,
    features: {
      autoAutonomy: true,
      sensors: true,
      priorityQueue: true,
      persistentMemory: true,
      sso: false,
    },
  },
  {
    id: 'team',
    name: 'Team',
    maxProjects: 20,
    maxMissionsPerDay: 300,
    tierRank: 3,
    maxConcurrentMissions: 4,
    seats: 10,
    features: {
      autoAutonomy: true,
      sensors: true,
      priorityQueue: true,
      persistentMemory: true,
      sso: true,
    },
  },
]

async function main(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      update: {
        name: plan.name,
        maxProjects: plan.maxProjects,
        maxMissionsPerDay: plan.maxMissionsPerDay,
        tierRank: plan.tierRank,
        maxConcurrentMissions: plan.maxConcurrentMissions,
        seats: plan.seats,
        features: plan.features,
      },
      create: plan,
    })
  }

  if (PLANS_ONLY) {
    console.log(
      '[seed] --plans-only: pulando dono da instância e reivindicação de projetos legados sem dono'
    )
    return
  }

  const ownerEmail = process.env['GITORCH_OWNER_EMAIL']
  const ownerGithub = process.env['GITORCH_OWNER_GITHUB'] ?? null
  if (!ownerEmail) {
    console.log('[seed] GITORCH_OWNER_EMAIL ausente; pulando criação do usuário dono')
    return
  }

  const owner = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: { githubLogin: ownerGithub ?? undefined, planId: 'pro' },
    create: { email: ownerEmail, githubLogin: ownerGithub, planId: 'pro' },
  })
  console.log(`[seed] usuário dono: ${owner.id}`)

  // Projetos legados (sem dono) passam a pertencer ao dono da instância.
  const orphans = await prisma.project.updateMany({
    where: { userId: null },
    data: { userId: owner.id },
  })
  console.log(`[seed] projetos vinculados ao dono: ${orphans.count}`)

  // Projetos ativos ganham a agenda padrão que faltar (idempotente por papel).
  const projects = await prisma.project.findMany({ where: { isActive: true } })
  for (const project of projects) {
    const created = await ensureDefaultSchedules(prisma, project.id)
    if (created > 0) {
      console.log(`[seed] ${created} agenda(s) padrão criada(s) para ${project.wingId}`)
    }
  }
}

main()
  .catch((err) => {
    console.error('[seed] falhou:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
