import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { encryptCredential } from '../lib/credential-crypto.js'
import { identidadeDaConta } from '../services/credencial-do-dev-do-cliente.js'

/**
 * BYOK do dev assíncrono (D34): o cliente conecta a conta DELE.
 *
 * A chave entra por aqui uma vez, é cifrada com a mesma chave e pelo mesmo
 * caminho das credenciais dos motores de IA, e nunca mais sai: nem na resposta
 * desta rota, nem em log, nem em arquivo. O que sai é o ESTADO ("conectada" ou
 * não) e a impressão digital da conta, que é o que o painel precisa mostrar e o
 * que o teto precisa para somar os projetos do mesmo cliente.
 */

interface Params {
  id: string
}

interface Body {
  apiKey?: string
}

export const contaDoDevRoutes = async (app: FastifyInstance): Promise<void> => {
  app.put<{ Params: Params; Body: Body }>(
    '/api/projects/:id/conta-do-dev',
    async (request: FastifyRequest<{ Params: Params; Body: Body }>, reply: FastifyReply) => {
      const wingId = request.wingId!
      const chave = request.body?.apiKey?.trim()
      if (!chave) {
        return reply.code(400).send({ error: 'informe a chave da sua conta do dev assíncrono' })
      }

      // Dono ANTES de qualquer coisa: sem isso, um cliente plantaria a própria
      // conta no projeto de outro e passaria a pagar (ou a esgotar) a cota
      // alheia sem nunca aparecer no painel de ninguém.
      const projeto = await app.prisma.project.findFirst({
        where: { id: request.params.id, wingId },
        select: { id: true },
      })
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      const conta = identidadeDaConta(chave)
      await app.prisma.project.update({
        where: { id: projeto.id },
        data: { encryptedDevApiKey: encryptCredential(chave), devAccountId: conta },
      })

      // Log com a IMPRESSÃO DIGITAL, nunca com a chave.
      app.log.info(`[BYOK] projeto ${projeto.id} passou a usar a conta ${conta} do dev assíncrono`)
      return reply.send({ conectada: true, conta })
    }
  )

  app.get<{ Params: Params }>(
    '/api/projects/:id/conta-do-dev',
    async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      const projeto = await app.prisma.project.findFirst({
        where: { id: request.params.id, wingId: request.wingId! },
        select: { encryptedDevApiKey: true, devAccountId: true },
      })
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      const conectada = Boolean(projeto.encryptedDevApiKey)
      return reply.send(
        conectada ? { conectada: true, conta: projeto.devAccountId } : { conectada: false }
      )
    }
  )

  app.delete<{ Params: Params }>(
    '/api/projects/:id/conta-do-dev',
    async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      const projeto = await app.prisma.project.findFirst({
        where: { id: request.params.id, wingId: request.wingId! },
        select: { id: true },
      })
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      // Os dois campos caem JUNTOS: uma identidade sobrevivente sem credencial
      // faria o teto continuar somando este projeto na conta de um cliente que
      // já saiu, roubando vaga de quem ficou.
      await app.prisma.project.update({
        where: { id: projeto.id },
        data: { encryptedDevApiKey: null, devAccountId: null },
      })
      return reply.send({ conectada: false })
    }
  )
}

export default contaDoDevRoutes
