import { describe, it, expect, vi } from 'vitest'
import {
  chaveDoDevDoProjeto,
  chaveDaContaDoDev,
  chaveDaSessaoDoDev,
  type PrismaParaChaveDoDev,
} from './chave-do-dev-assincrono.js'

// L4-T3: extraído de `plugins/scheduler.ts` (`chaveDoDevDoProjeto`/
// `chaveDaConta`/`chaveDaSessao` viviam presas em closures do
// `schedulerPlugin`, só acessíveis dentro dele) para virar função INJETÁVEL
// — `services/retomar-sessao-com-resposta.ts` (a resposta do dono que retoma
// a sessão) roda fora do scheduler (é chamada por `agent-question.ts
// answer()`, ligada em `plugins/telegram.ts`) e precisa da MESMA lógica de
// resolução de chave BYOK (D34), nunca uma segunda implementação divergente.
// `scheduler.ts` passa a DELEGAR para estas funções (mesmas assinaturas de
// closure, comportamento idêntico) em vez de duplicar.

function decifrarFake(envelope: string): string {
  if (envelope === 'ENVELOPE_INVALIDO') throw new Error('não decifra')
  return envelope.replace('cifrado:', '')
}

function prismaFalso(overrides: Partial<PrismaParaChaveDoDev> = {}): PrismaParaChaveDoDev {
  return {
    project: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    devSession: {
      findUnique: vi.fn(async () => null),
    },
    ...overrides,
  } as PrismaParaChaveDoDev
}

describe('chaveDoDevDoProjeto', () => {
  it('projeto com credencial própria: decifra e devolve', async () => {
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => ({ encryptedDevApiKey: 'cifrado:chave-do-cliente' })),
        findFirst: vi.fn(async () => null),
      },
    })

    const chave = await chaveDoDevDoProjeto(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      'proj1'
    )

    expect(chave).toBe('chave-do-cliente')
  })

  it('sem credencial própria: recua para a chave da instância', async () => {
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => ({ encryptedDevApiKey: null })),
        findFirst: vi.fn(async () => null),
      },
    })

    const chave = await chaveDoDevDoProjeto(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      'proj1'
    )

    expect(chave).toBe('chave-da-instancia')
  })

  it('credencial ilegível: avisa e devolve undefined — nunca cai na conta errada', async () => {
    const onWarn = vi.fn()
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => ({ encryptedDevApiKey: 'ENVELOPE_INVALIDO' })),
        findFirst: vi.fn(async () => null),
      },
    })

    const chave = await chaveDoDevDoProjeto(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia', onWarn },
      'proj1'
    )

    expect(chave).toBeUndefined()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('proj1'))
  })
})

describe('chaveDaContaDoDev', () => {
  it('sem devAccountId: é a conta da instância', async () => {
    const prisma = prismaFalso()
    const chave = await chaveDaContaDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      null
    )
    expect(chave).toBe('chave-da-instancia')
  })

  it('com devAccountId: busca a credencial do DONO daquela conta, sem recuar para a instância', async () => {
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ encryptedDevApiKey: 'cifrado:chave-do-cliente' })),
      },
    })
    const chave = await chaveDaContaDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      'conta-x'
    )
    expect(chave).toBe('chave-do-cliente')
  })

  it('conta sem credencial utilizável: NUNCA recua para a chave da instância (evita gastar conta errada)', async () => {
    const onWarn = vi.fn()
    const prisma = prismaFalso({
      project: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
    })
    const chave = await chaveDaContaDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia', onWarn },
      'conta-x'
    )
    expect(chave).toBeUndefined()
    expect(onWarn).toHaveBeenCalled()
  })
})

describe('chaveDaSessaoDoDev', () => {
  it('resolve pela conta em que a sessão nasceu, não pela do projeto', async () => {
    const prisma = prismaFalso({
      devSession: { findUnique: vi.fn(async () => ({ devAccountId: 'conta-y' })) },
      project: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ encryptedDevApiKey: 'cifrado:chave-da-conta-y' })),
      },
    })

    const chave = await chaveDaSessaoDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      'sessions/1'
    )

    expect(chave).toBe('chave-da-conta-y')
  })

  it('sessão sem devAccountId: cai na conta da instância', async () => {
    const prisma = prismaFalso({
      devSession: { findUnique: vi.fn(async () => ({ devAccountId: null })) },
    })

    const chave = await chaveDaSessaoDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia' },
      'sessions/1'
    )

    expect(chave).toBe('chave-da-instancia')
  })

  it('erro ao descobrir a conta da sessão: avisa e devolve undefined — falha aberta, nunca na conta errada', async () => {
    const onWarn = vi.fn()
    const prisma = prismaFalso({
      devSession: {
        findUnique: vi.fn(async () => {
          throw new Error('banco fora do ar')
        }),
      },
    })

    const chave = await chaveDaSessaoDoDev(
      { prisma, decifrar: decifrarFake, chaveDaInstancia: 'chave-da-instancia', onWarn },
      'sessions/1'
    )

    expect(chave).toBeUndefined()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('sessions/1'))
  })
})
