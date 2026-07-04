// Captura as credenciais dos motores já logados no HOME do host para conexões
// do usuário dono da instância (GITORCH_OWNER_EMAIL). Uso: cliente de teste.
import { createRequire } from 'node:module'
import { EngineConnectionService } from '../dist/services/engine-connection.js'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const HOME = process.env.HOME
const ownerEmail = process.env.GITORCH_OWNER_EMAIL
if (!ownerEmail) throw new Error('GITORCH_OWNER_EMAIL ausente')

const owner = await prisma.user.findUnique({ where: { email: ownerEmail } })
if (!owner) throw new Error(`Usuário dono não encontrado: ${ownerEmail}`)

const svc = new EngineConnectionService(prisma)
for (const runtime of ['antigravity', 'codex', 'claude']) {
  try {
    const status = await svc.captureFromHome(owner.id, runtime, HOME)
    console.log(`OK  ${runtime}: ${status.status}`)
  } catch (err) {
    console.log(`SKIP ${runtime}: ${err?.message ?? err}`)
  }
}
await prisma.$disconnect()
