import { PrismaClient } from '@prisma/client'
import { ensureDefaultSchedules } from '../src/lib/project-defaults.js'

// Seed idempotente: cria os planos base, garante o usuário dono da instância
// e migra dados legados (projetos sem dono e agenda fixa) para o modelo
// multi-tenant. Seguro de rodar quantas vezes for preciso.
const prisma = new PrismaClient()

// Limites dos planos base. maxMissionsPerDay comporta a agenda padrão de um
// projeto (ra 1x + po 2x + sm 4x = 7 missões/dia) com folga.
const DEFAULT_PLANS = [
  { id: 'free', name: 'Free', maxProjects: 1, maxMissionsPerDay: 10 },
  { id: 'pro', name: 'Pro', maxProjects: 5, maxMissionsPerDay: 60 },
]

async function main(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      update: {
        name: plan.name,
        maxProjects: plan.maxProjects,
        maxMissionsPerDay: plan.maxMissionsPerDay,
      },
      create: plan,
    })
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
