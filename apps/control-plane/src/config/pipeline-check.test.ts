import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { pipelineCheckEnabled } from './pipeline-check.js'
import { schedulerPlugin } from '../plugins/scheduler.js'
import { telegramPlugin } from '../plugins/telegram.js'
import { AgentQuestionService } from '../services/agent-question.js'
import { getTelegramUpdates } from '../services/telegram-bot.js'

// Mock parcial: mantém os demais exports reais (preserva a forma do módulo),
// substitui só o ponto de entrada do long-poll por um espião controlável — é
// ele que a asserção do teste do telegram, abaixo, prova que NUNCA é chamado
// em modo pipeline-check.
vi.mock('../services/telegram-bot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/telegram-bot.js')>()
  return { ...actual, getTelegramUpdates: vi.fn() }
})

describe('pipelineCheckEnabled', () => {
  it('liga só com "1"', () => {
    expect(pipelineCheckEnabled({ GITORCH_PIPELINE_CHECK: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(pipelineCheckEnabled({ GITORCH_PIPELINE_CHECK: 'true' } as NodeJS.ProcessEnv)).toBe(
      false
    )
    expect(pipelineCheckEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('scheduler em modo pipeline-check', () => {
  it('registra sem tocar prisma/engineConnections e o trigger recusa com reason clara', async () => {
    process.env['GITORCH_PIPELINE_CHECK'] = '1'
    try {
      // App PELADA: sem prisma, sem engineConnections, sem cortex. Sem o
      // guard, o REGISTRO não explode (buildMissionRunner/buildRuntimeStack
      // toleram app.prisma/app.engineConnections undefined nesse ponto) — a
      // regressão só aparece depois, quando o trigger real roda e devolve
      // reason: 'error' (em vez de 'pipeline-check') porque tropeça no
      // prisma ausente. É essa troca de reason que a asserção abaixo pega.
      const app = Fastify({ logger: false })
      await app.register(schedulerPlugin)
      const res = await app.triggerAgentMission('po')
      expect(res).toEqual({ triggered: false, reason: 'pipeline-check' })
      await app.close()
    } finally {
      delete process.env['GITORCH_PIPELINE_CHECK']
    }
  })
})

describe('telegram plugin em modo pipeline-check', () => {
  it('nao inicia o long-polling do bot e ainda decora agentQuestionService', async () => {
    const originalNodeEnv = process.env['NODE_ENV']
    process.env['GITORCH_PIPELINE_CHECK'] = '1'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = '000000000:FAKE-BOT-TOKEN-DE-TESTE-0000'
    // Pipeline-check roda com NODE_ENV='production' de propósito (ver
    // config/pipeline-check.ts). O setup global de teste força
    // NODE_ENV='test' (src/test/setup.ts) — sem sobrescrever aqui, o
    // early-return por NODE_ENV==='test' do plugin mascararia o guard sob
    // teste: a asserção abaixo passaria mesmo com pipelineCheckEnabled()
    // quebrado.
    process.env['NODE_ENV'] = 'production'
    const getUpdatesSpy = vi.mocked(getTelegramUpdates)
    getUpdatesSpy.mockReset()
    // Limita o dano de uma regressão: se o guard cair, o loop `listen()`
    // só tem UMA resposta resolvida disponível — a segunda chamada em
    // diante trava numa promise que nunca resolve. Sem este limite, um
    // guard quebrado faz o mock resolver instantaneamente em loop
    // (microtasks puros, sem `setTimeout`), o que morre de OOM (~27s)
    // antes do testTimeout do vitest conseguir disparar — falha lenta e
    // confusa em vez de um timeout limpo (ver timeout explícito abaixo).
    getUpdatesSpy.mockResolvedValueOnce({ updates: [], nextOffset: undefined, conflict: false })
    getUpdatesSpy.mockImplementation(() => new Promise(() => {}))
    try {
      // App PELADA (mesmo padrão do teste do scheduler acima): sem prisma,
      // sem cortex. A decoração de agentQuestionService não depende de
      // nenhum dos dois no momento do registro — só guarda a referência.
      const app = Fastify({ logger: false })
      await app.register(telegramPlugin)
      // Dá um tick pro `void listen()` rodar, se o guard não tivesse
      // disparado — a chamada ao getUpdates é assíncrona, sem isto o teste
      // passaria mesmo com o guard quebrado.
      await new Promise((resolve) => setImmediate(resolve))
      expect(getUpdatesSpy).not.toHaveBeenCalled()
      expect(app.agentQuestionService).toBeInstanceOf(AgentQuestionService)
      await app.close()
    } finally {
      delete process.env['GITORCH_PIPELINE_CHECK']
      delete process.env['GITORCH_TELEGRAM_BOT_TOKEN']
      if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = originalNodeEnv
    }
  }, 2000)
})
