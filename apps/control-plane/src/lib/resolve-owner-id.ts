import type { PrismaClient } from '@prisma/client'

/**
 * Dono canônico da sessão. EngineConnection e Project são gravados sob o id
 * resolvido por e-mail (ver routes/setup.ts submit e plugins/engines.ts). Sem
 * e-mail (legado single-tenant), o id da sessão é o melhor que existe.
 *
 * Extraído da closure de routes/setup.ts para uma fonte única — o painel do
 * owner (routes/painel.ts) precisa do MESMO escopo de dono, e duas cópias da
 * regra divergiriam com o tempo (foi o que aconteceu com a porta do desejo).
 */
export async function resolveOwnerId(
  prisma: Pick<PrismaClient, 'user'>,
  user: { id: string; email?: string }
): Promise<string> {
  if (!user.email) return user.id
  const owner = await prisma.user.findUnique({ where: { email: user.email } })
  return owner?.id ?? user.id
}
