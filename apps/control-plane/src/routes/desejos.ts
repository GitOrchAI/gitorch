import type { FastifyInstance } from 'fastify'
import { montarDesejo } from '../services/desejo.js'

// Porta HTTP do desejo: o dono descreve o que quer em linguagem de gente e o
// produto registra a issue oficial. As dependências entram por injeção porque
// a rota tem de ser testável sem banco e sem rede — quem monta as de verdade é
// `routes/index.ts`.
export interface DependenciasDeDesejos {
  buscarProjeto: (args: { projectId: string; userId: string }) => Promise<{
    id: string
    githubRepo: string
  } | null>
  criarIssue: (args: {
    repo: string
    titulo: string
    corpo: string
    etiquetas: string[]
  }) => Promise<{ numero: number }>
}

export async function desejosRoutes(app: FastifyInstance, deps: DependenciasDeDesejos) {
  app.post<{ Body: { projectId?: string; texto?: string } }>(
    '/api/v1/desejos',
    async (request, reply) => {
      const userId = (request as unknown as { user?: { id?: string } }).user?.id
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

      const projectId = request.body?.projectId
      const texto = request.body?.texto
      if (typeof projectId !== 'string' || typeof texto !== 'string' || texto.trim() === '') {
        return reply.code(400).send({ error: 'Pedido vazio ou projeto ausente.' })
      }

      const projeto = await deps.buscarProjeto({ projectId, userId })
      if (!projeto) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      const desejo = montarDesejo({ texto, autor: userId })

      try {
        const criada = await deps.criarIssue({
          repo: projeto.githubRepo,
          titulo: desejo.titulo,
          corpo: desejo.corpo,
          etiquetas: desejo.etiquetas,
        })
        return reply.code(201).send({
          numero: criada.numero,
          endereco: `https://github.com/${projeto.githubRepo}/issues/${criada.numero}`,
        })
      } catch (erro) {
        // O erro do GitHub pode conter credencial; nunca repassar ao cliente.
        request.log.error({ erro }, 'falha ao registrar o desejo no GitHub')
        return reply.code(502).send({ error: 'Não consegui registrar o pedido agora.' })
      }
    }
  )
}

export default desejosRoutes
