import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import type { PlanoDoDev } from '../services/plano-do-dev.js'

interface ProjectParams {
  id: string
}

// Os três planos aceitos pelo cadastro (D13). `devPlan` é opcional aqui
// porque a tela pode chamar esta rota só pra runtimeConfig (fluxo já
// existente) ou só pra declarar o plano (fluxo novo do wizard) — nunca os
// dois obrigatórios juntos.
const PLANOS_DO_DEV: readonly PlanoDoDev[] = ['free', 'pro', 'ultra']

interface RuntimeConfigBody {
  runtimeConfig?: Prisma.InputJsonValue
  devPlan?: string
}

export const runtimeConfigRoutes = async (app: FastifyInstance): Promise<void> => {
  // PATCH /api/projects/:id/runtime-config - Update project runtime config (F8 ownership)
  app.patch<{ Params: ProjectParams; Body: RuntimeConfigBody }>(
    '/api/projects/:id/runtime-config',
    async (
      request: FastifyRequest<{
        Params: ProjectParams
        Body: RuntimeConfigBody
      }>,
      reply: FastifyReply
    ) => {
      const wingId = request.wingId!
      const { id } = request.params
      const { runtimeConfig, devPlan } = request.body

      // Validar ANTES de tocar o banco: um valor inventado aqui viraria um
      // teto de delegação que nunca bate com nenhum plano real declarado em
      // plano-do-dev.ts, e cairia em silêncio no padrão gratuito lá na frente
      // — melhor recusar na porta do que deixar o dono achar que configurou
      // um plano que não existe.
      if (devPlan !== undefined && !PLANOS_DO_DEV.includes(devPlan as PlanoDoDev)) {
        return reply.code(400).send({
          error: `devPlan inválido: '${devPlan}'. Use um de: ${PLANOS_DO_DEV.join(', ')}`,
        })
      }

      const existing = await app.prisma.project.findFirst({
        where: { id, wingId },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      // Monta o `data` só com o que veio no corpo: com
      // `exactOptionalPropertyTypes` ligado, atribuir `devPlan: undefined`
      // explicitamente é erro de tipo (undefined não é o mesmo que "campo
      // ausente" para o Prisma) — e semanticamente também seria errado, já
      // que essa rota aceita atualizar só um dos dois campos por vez.
      const data: Prisma.ProjectUpdateInput = {}
      if (runtimeConfig !== undefined) {
        data.runtimeConfig = runtimeConfig
      }
      if (devPlan !== undefined) {
        data.devPlan = devPlan
      }

      const project = await app.prisma.project.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          runtimeConfig: true,
          devPlan: true,
          updatedAt: true,
        },
      })

      return project
    }
  )
}

export default runtimeConfigRoutes
