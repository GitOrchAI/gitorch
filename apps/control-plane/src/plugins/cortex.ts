import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { CortexClient } from '@gitorch/cortex'

export interface MissionMemoryInput {
  wingId: string
  missionId: string
  agentRole: string
  content: string
}

/**
 * Memória de longo prazo das missões (Cortex), isolada por projeto.
 *
 * Toda gravação e leitura é carimbada com o wingId do projeto: a memória de
 * um projeto nunca é visível a outro. O resultado de cada missão vira uma
 * gaveta (drawer) na sala do agente que a produziu.
 */
const cortexPluginImpl: FastifyPluginAsync = async (app) => {
  const sqlitePath = process.env['GITORCH_CORTEX_DB'] ?? '/var/lib/gitorch/cortex.sqlite'
  // O SqliteStore abre o arquivo preguiçosamente (na 1ª escrita) e não cria o
  // diretório. Cria o diretório no boot — best-effort com AVISO ALTO se falhar:
  // a memória é um recurso opcional e não pode derrubar a API inteira, mas o
  // problema também não pode ficar calado (o aviso aparece no boot).
  try {
    mkdirSync(path.dirname(sqlitePath), { recursive: true })
  } catch (err) {
    app.log.warn(
      err,
      `[Cortex] não foi possível criar ${path.dirname(sqlitePath)}; a memória de longo prazo pode ficar indisponível (defina GITORCH_CORTEX_DB para um caminho gravável)`
    )
  }

  const client = new CortexClient({ sqlitePath })
  client.init()

  const saveMissionMemory = async (input: MissionMemoryInput): Promise<void> => {
    const now = new Date().toISOString()
    await client.writeDrawer({
      id: `mission-${input.missionId}`,
      wingId: input.wingId,
      roomId: `agent-${input.agentRole}`,
      hallId: 'missions',
      content: input.content,
      importance: 0.7,
      emotionalWeight: 0,
      createdAt: now,
      validFrom: now,
      confidence: 0.8,
      tags: ['mission', input.agentRole],
    })
  }

  app.decorate('cortex', client)
  app.decorate('saveMissionMemory', saveMissionMemory)

  app.addHook('onClose', async () => {
    client.close()
  })
}

export const cortexPlugin = fp(cortexPluginImpl)

declare module 'fastify' {
  interface FastifyInstance {
    cortex: CortexClient
    saveMissionMemory: (input: MissionMemoryInput) => Promise<void>
  }
}
