import { describe, expect, it, vi } from 'vitest'
import { avisarMotorRevogado, chaveDeMotorRevogado } from './avisar-motor-revogado.js'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'

function buildFakePrisma(projeto: { id: string } | null) {
  return {
    project: {
      findFirst: vi.fn(async () => projeto),
    },
  }
}

describe('chaveDeMotorRevogado', () => {
  it('monta motor-revogado:<runtime>:<userId> — estável para a MESMA conexão', () => {
    expect(chaveDeMotorRevogado('codex', 'user_1')).toBe('motor-revogado:codex:user_1')
  })
})

describe('avisarMotorRevogado — D76 (10/09) + pedido do dono (26/08): AS DUAS pontas', () => {
  it('motor revogado com Telegram ligado E projeto ativo: chama AS DUAS — Telegram intacto, painel novo, no MESMO evento', async () => {
    const prisma = buildFakePrisma({ id: 'proj_1' })
    const avisarPorTelegram = vi.fn(async (_texto: string) => true)
    const registrarNoPainel = vi.fn(
      async (_projectId: string, _chave: string, _texto: string) => undefined
    )

    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram,
      registrarNoPainel,
    })

    // Telegram: chamado com o MESMO texto sintetizado de sempre
    // (recado-de-motor-revogado.ts) — nunca condicionado ao painel.
    expect(avisarPorTelegram).toHaveBeenCalledTimes(1)
    const textoDoTelegram = avisarPorTelegram.mock.calls[0]?.[0] as string
    expect(textoDoTelegram).toContain('Codex')
    expect(textoDoTelegram).toMatch(/revogada/i)

    // Painel: chamado com o projeto ativo do dono, chave estável, e o MESMO
    // texto que foi para o Telegram — a mesma escrita, dois canais.
    expect(registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj_1',
      'motor-revogado:codex:user_1',
      textoDoTelegram
    )

    // Nem uma condiciona a outra: as duas terminam no mesmo disparo.
    expect(avisarPorTelegram).toHaveBeenCalled()
    expect(registrarNoPainel).toHaveBeenCalled()
  })

  it('sem vínculo de Telegram (bot/chat não configurado): o painel AINDA registra — nunca dependeu do canal de chat', async () => {
    const prisma = buildFakePrisma({ id: 'proj_2' })
    const registrarNoPainel = vi.fn(async () => undefined)

    await avisarMotorRevogado({
      prisma,
      userId: 'user_2',
      runtime: 'antigravity',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })

    expect(registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj_2',
      'motor-revogado:antigravity:user_2',
      expect.stringContaining('Antigravity')
    )
  })

  it('dono sem NENHUM projeto ativo (só conectou o motor, nunca cadastrou projeto): Telegram roda igual, painel é best-effort e não quebra', async () => {
    const prisma = buildFakePrisma(null)
    const avisarPorTelegram = vi.fn(async () => true)
    const registrarNoPainel = vi.fn(async () => undefined)

    await expect(
      avisarMotorRevogado({
        prisma,
        userId: 'user_sem_projeto',
        runtime: 'claude',
        avisarPorTelegram,
        registrarNoPainel,
      })
    ).resolves.toBeUndefined()

    expect(avisarPorTelegram).toHaveBeenCalledTimes(1)
    // Sem projeto para anexar o registro — nada para registrar, e SEM lançar.
    expect(registrarNoPainel).not.toHaveBeenCalled()
  })

  it('busca de projeto falha (erro de banco): não derruba o aviso — Telegram já rodou, e o erro não escapa', async () => {
    const prisma = {
      project: {
        findFirst: vi.fn(async () => {
          throw new Error('conexão com o banco caiu')
        }),
      },
    }
    const avisarPorTelegram = vi.fn(async () => true)
    const registrarNoPainel = vi.fn(async () => undefined)

    await expect(
      avisarMotorRevogado({
        prisma,
        userId: 'user_3',
        runtime: 'codex',
        avisarPorTelegram,
        registrarNoPainel,
      })
    ).resolves.toBeUndefined()

    expect(avisarPorTelegram).toHaveBeenCalledTimes(1)
    expect(registrarNoPainel).not.toHaveBeenCalled()
  })

  it('dedupe: reprocessar o MESMO evento de revogação chama registrarNoPainel de novo com a MESMA chave — quem dedupa de fato é registrarNoPainelUmaVez (registro-no-painel.ts), best-effort aqui não reimplementa isso', async () => {
    // avisarMotorRevogado não guarda estado entre chamadas (é isso que o
    // teste prova) — o dedupe real fica em `registrarNoPainelUmaVez`, que já
    // tem sua própria suíte (registro-no-painel.test.ts se existir) provando
    // que a MESMA chave não grava duas vezes no Prisma de verdade. Aqui a
    // prova é que este orquestrador sempre chama com a MESMA chave estável
    // para o MESMO par (runtime, userId) — pré-condição para aquele dedupe
    // funcionar.
    const prisma = buildFakePrisma({ id: 'proj_1' })
    const registrarNoPainel = vi.fn(
      async (_projectId: string, _chave: string, _texto: string) => undefined
    )

    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })
    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })

    expect(registrarNoPainel).toHaveBeenCalledTimes(2)
    const chaveDaPrimeira = registrarNoPainel.mock.calls[0]?.[1]
    const chaveDaSegunda = registrarNoPainel.mock.calls[1]?.[1]
    expect(chaveDaPrimeira).toBe(chaveDaSegunda)
    expect(chaveDaPrimeira).toBe('motor-revogado:codex:user_1')
  })
})

describe('avisarMotorRevogado + registrarNoPainelUmaVez REAL (sem mock do dedupe) — reprocessar o MESMO evento de revogação não duplica no painel', () => {
  it('duas chamadas para o MESMO (runtime, userId) na mesma sessão: só UM evento grava — a segunda é no-op pelo dedupe real de registrarNoPainelUmaVez', async () => {
    // Prisma FALSO com um banco de eventos em memória de verdade (não um
    // vi.fn() que só conta chamadas): prova o dedupe pelo comportamento real
    // de `registrarNoPainelUmaVez` (findFirst por chave -> create só se não
    // achou), exatamente como o Prisma real faria.
    const eventos: Array<{
      projectId: string
      type: 'audit'
      payload: { texto: string; chave: string }
    }> = []
    const prisma = {
      project: { findFirst: vi.fn(async () => ({ id: 'proj_1' })) },
      event: {
        findFirst: vi.fn(
          async (args: {
            where: {
              projectId: string
              type: 'audit'
              payload: { path: ['chave']; equals: string }
            }
          }) =>
            eventos.find(
              (e) =>
                e.projectId === args.where.projectId &&
                e.type === args.where.type &&
                e.payload.chave === args.where.payload.equals
            ) ?? null
        ),
        create: vi.fn(
          async (args: {
            data: { projectId: string; type: 'audit'; payload: { texto: string; chave: string } }
          }) => {
            eventos.push(args.data)
            return { id: `evt_${eventos.length}` }
          }
        ),
      },
    }
    const registrarNoPainel = (projectId: string, chave: string, texto: string) =>
      registrarNoPainelUmaVez({ prisma, projectId, chave, texto })

    // Simula a MESMA vigília horária reprocessando o MESMO evento de
    // revogação (ex.: dois tiques antes do status virar 'needs_reconnect'
    // no banco em algum cenário de corrida) — `jaEstavaCaido` no scheduler
    // já corta a maior parte disso, mas o dedupe por chave no painel é o
    // cinto de segurança que não depende de estado em memória.
    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })
    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })

    expect(prisma.event.create).toHaveBeenCalledTimes(1)
    expect(eventos).toHaveLength(1)
    expect(eventos[0]?.payload.chave).toBe('motor-revogado:codex:user_1')
  })

  it('runtimes DIFERENTES do MESMO dono: cada um grava o SEU próprio evento — o dedupe é por chave, não por dono', async () => {
    const eventos: Array<{
      projectId: string
      type: 'audit'
      payload: { texto: string; chave: string }
    }> = []
    const prisma = {
      project: { findFirst: vi.fn(async () => ({ id: 'proj_1' })) },
      event: {
        findFirst: vi.fn(
          async (args: {
            where: {
              projectId: string
              type: 'audit'
              payload: { path: ['chave']; equals: string }
            }
          }) =>
            eventos.find(
              (e) =>
                e.projectId === args.where.projectId &&
                e.type === args.where.type &&
                e.payload.chave === args.where.payload.equals
            ) ?? null
        ),
        create: vi.fn(
          async (args: {
            data: { projectId: string; type: 'audit'; payload: { texto: string; chave: string } }
          }) => {
            eventos.push(args.data)
            return { id: `evt_${eventos.length}` }
          }
        ),
      },
    }
    const registrarNoPainel = (projectId: string, chave: string, texto: string) =>
      registrarNoPainelUmaVez({ prisma, projectId, chave, texto })

    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'codex',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })
    await avisarMotorRevogado({
      prisma,
      userId: 'user_1',
      runtime: 'antigravity',
      avisarPorTelegram: undefined,
      registrarNoPainel,
    })

    expect(prisma.event.create).toHaveBeenCalledTimes(2)
    expect(eventos.map((e) => e.payload.chave)).toEqual([
      'motor-revogado:codex:user_1',
      'motor-revogado:antigravity:user_1',
    ])
  })
})
