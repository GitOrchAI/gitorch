import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { AgentQuestionService } from '../services/agent-question.js'

// Rota de DEV isolada (W3.5.1 — Prova real): dispara a DÚVIDA REAL das cores
// oficiais (o exemplo do dono) pelo MESMO caminho de produção
// (AgentQuestionService.ask), pra provar o loop human-in-the-loop de ponta a
// ponta no gate do dono. Arquivo NOVO e ISOLADO de propósito — não mexe em
// routes/setup.ts (há outro PR aberto mexendo lá) e é registrado sozinho em
// plugins/index.ts.
//
// GATE — nesta ordem:
//  1) flag OFF por padrão. Feature de DEV nunca pode vazar sozinha: o ambiente
//     dev deployado roda com NODE_ENV=production (confirmado no systemd), então
//     gatear por NODE_ENV derrubaria também o gate do dono. Uma flag própria
//     (ligada manualmente só no deploy do gate) é o único jeito honesto.
//  2) sessão — igual a qualquer rota autenticada do wizard.
//  3) projeto do dono — sem projeto conectado não há onde pendurar a dúvida.
const DEV_ROUTES_FLAG = 'GITORCH_DEV_ROUTES'

// A dúvida REAL das cores (o exemplo do dono) — dedupKey fixo pra nunca
// duplicar se o dono apertar o botão/rota 2x.
const COR_AZUL_QUESTION = {
  text: 'As páginas Home, Preço e Painel usam 3 azuis diferentes. Qual é o azul oficial do site?',
  options: [
    { label: '#2563EB', value: '#2563EB' },
    { label: '#1E40AF', value: '#1E40AF' },
    { label: '#3B82F6', value: '#3B82F6' },
  ],
  dedupKey: 'cor-azul-oficial',
}

export const devAgentQuestionRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/api/v1/dev/agent-question', async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env[DEV_ROUTES_FLAG] !== '1') {
      return reply.code(404).send({ error: 'NOT_FOUND' })
    }
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
    }

    const userId = request.user.id
    const project = await app.prisma.project.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    if (!project) {
      return reply.code(400).send({ error: 'NO_PROJECT: conecte um repositório primeiro' })
    }

    // Reusa a MESMA instância decorada em plugins/telegram.ts (notify real +
    // Cortex já ligados) — assim esta rota cria E notifica pelo caminho de
    // produção. Sem o plugin ativo (ex.: teste isolado desta rota), degrada
    // com clareza: cria a dúvida mesmo assim, só sem Telegram.
    const service =
      app.agentQuestionService ?? new AgentQuestionService(app.prisma, { cortex: app.cortex })

    const result = await service.ask(userId, project.id, COR_AZUL_QUESTION)

    return reply.send({
      created: !result.deduped,
      deduped: result.deduped,
      questionId: result.question.id,
    })
  })
}

export default devAgentQuestionRoutes
