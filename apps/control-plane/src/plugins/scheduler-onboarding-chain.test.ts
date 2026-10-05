import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  nextOnboardingStep,
  resolveRailsBoard,
  resolverBoardDoProjeto,
  shouldChainOnboarding,
  tentarAutoRemediarQuadroDaSprint,
} from './scheduler.js'

// Crítico 1, item (c): a mecânica da cascata de onboarding (dado o que resta
// da fila, qual é o próximo papel a disparar) isolada da decisão de entrega
// (resolveMissionDelivery, testada em mission-outcome.test.ts). Combinadas,
// as duas provam que uma missão de trilhos que entrega de verdade encadeia
// normalmente: o único gate que ficava entre elas (o contrato de entregável
// aplicado indevidamente aos trilhos) foi removido, e a mecânica de avançar
// a fila continua correta.
describe('nextOnboardingStep', () => {
  test('fila com múltiplos papéis: devolve o primeiro como próximo e o resto como remaining', () => {
    expect(nextOnboardingStep(['ra', 'po', 'sm', 'qa'])).toEqual({
      role: 'ra',
      remaining: ['po', 'sm', 'qa'],
    })
  })

  test('último papel da fila: remaining vazio, mas ainda dispara', () => {
    expect(nextOnboardingStep(['qa'])).toEqual({ role: 'qa', remaining: [] })
  })

  test('fila vazia: não há próximo papel (cascata terminou)', () => {
    expect(nextOnboardingStep([])).toBeNull()
  })

  test('sequência ausente (missão fora de uma cascata de onboarding): não há próximo papel', () => {
    expect(nextOnboardingStep(undefined)).toBeNull()
    expect(nextOnboardingStep(null)).toBeNull()
  })
})

// Visto em produção: a esteira de onboarding morreu no SM. O SM não tinha
// nada para delegar (projeto recém-registrado, sem issues) — um no-op
// LEGÍTIMO — e o QA nunca acordou, então o reconhecimento de qualidade não
// aconteceu. O encadeamento morava dentro do mesmo bloco que grava memória,
// que é (corretamente) pulado em no-op. São decisões diferentes: memória
// depende de ter entregue; a cascata depende de ainda haver fila.
describe('shouldChainOnboarding', () => {
  test('missão sem trabalho a fazer NÃO interrompe a cascata (o caso que matou o QA)', () => {
    expect(shouldChainOnboarding({ isNoOp: true, sequence: ['qa'] })).toBe(true)
  })

  test('missão que entregou também encadeia', () => {
    expect(shouldChainOnboarding({ isNoOp: false, sequence: ['sm', 'qa'] })).toBe(true)
  })

  test('fila vazia: a cascata terminou, não encadeia', () => {
    expect(shouldChainOnboarding({ isNoOp: false, sequence: [] })).toBe(false)
    expect(shouldChainOnboarding({ isNoOp: true, sequence: [] })).toBe(false)
  })

  test('missão fora de uma cascata de onboarding: não encadeia nada', () => {
    expect(shouldChainOnboarding({ isNoOp: false, sequence: undefined })).toBe(false)
    expect(shouldChainOnboarding({ isNoOp: true, sequence: null })).toBe(false)
  })
})

// Crítico 2: o board dos trilhos NUNCA cai no board global de outro
// projeto — mesmo que a env global esteja setada, um projeto sem board
// próprio gravado deve ficar SEM board (trilhos do PO desligados), nunca
// herdar o board alheio.
describe('resolveRailsBoard (Crítico 2: sem fallback pro board global de outro projeto)', () => {
  const originalGlobalBoard = process.env['GITORCH_PROJECT_BOARD']

  beforeEach(() => {
    // Simula a env global do dono apontando pro board de OUTRO projeto —
    // exatamente a configuração real que causava o vazamento.
    process.env['GITORCH_PROJECT_BOARD'] = 'outro-dono/999'
  })

  afterEach(() => {
    if (originalGlobalBoard === undefined) delete process.env['GITORCH_PROJECT_BOARD']
    else process.env['GITORCH_PROJECT_BOARD'] = originalGlobalBoard
  })

  test('projeto SEM board próprio: undefined, mesmo com o board global setado (nunca herda o de outro projeto)', () => {
    const projetoSemBoard = { runtimeConfig: { envConfig: {} } }
    expect(resolveRailsBoard(projetoSemBoard)).toBeUndefined()
  })

  test('projeto sem runtimeConfig nenhum: undefined, mesmo com o board global setado', () => {
    expect(resolveRailsBoard({})).toBeUndefined()
    expect(resolveRailsBoard({ runtimeConfig: null })).toBeUndefined()
  })

  test('projeto COM board próprio: usa o board do PROJETO, não o global', () => {
    const projetoComBoard = {
      runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'meu-dono/7' } },
    }
    expect(resolveRailsBoard(projetoComBoard)).toBe('meu-dono/7')
  })

  test('projeto COM githubBoardNumber no runtimeConfig: devolve dono/numero a partir do wingId', () => {
    const projetoComWizardBoard = {
      wingId: 'meu-dono/meu-repo',
      runtimeConfig: { githubBoardNumber: 42 },
    }
    expect(resolveRailsBoard(projetoComWizardBoard)).toBe('meu-dono/42')
  })

  test('sem NENHUMA env global setada, o comportamento é idêntico (a função nunca olha pro env)', () => {
    delete process.env['GITORCH_PROJECT_BOARD']
    const projetoSemBoard = { runtimeConfig: { envConfig: {} } }
    expect(resolveRailsBoard(projetoSemBoard)).toBeUndefined()
  })

  test('resolverBoardDoProjeto é alias funcional de resolveRailsBoard', () => {
    const projeto = {
      wingId: 'GitOrchAI/autocandidata',
      runtimeConfig: { githubBoardNumber: 15 },
    }
    expect(resolverBoardDoProjeto(projeto)).toBe('GitOrchAI/15')
  })
})

describe('tentarAutoRemediarQuadroDaSprint', () => {
  test('quando o repositório não tem quadro linkado mas tem githubBoardNumber no runtimeConfig: auto-remedia e vincula', async () => {
    const leitor = {
      findProjectId: vi.fn(async () => 'PVT_remediado'),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    }
    const resolveOwnerId = vi.fn(async () => ({ id: 'O_org', type: 'organization' as const }))
    const resolveRepositoryId = vi.fn(async () => 'R_repo_id')

    const decisao = await tentarAutoRemediarQuadroDaSprint({
      project: {
        id: 'p1',
        wingId: 'GitOrchAI/autocandidata',
        runtimeConfig: { githubBoardNumber: 15 },
      },
      token: 'tok-app',
      leitor: leitor as never,
      resolveOwnerId,
      resolveRepositoryId,
    })

    expect(decisao).toEqual({
      acao: 'usar',
      quadro: {
        id: 'PVT_remediado',
        number: 15,
        title: 'GitOrchAI/autocandidata',
        closed: false,
        linkado: true,
      },
      precisaLigar: false,
      motivo: 'quadro configurado no runtimeConfig auto-remediado com sucesso',
    })
    expect(leitor.findProjectId).toHaveBeenCalledWith({
      login: 'GitOrchAI',
      number: 15,
      ownerType: 'organization',
    })
    expect(resolveRepositoryId).toHaveBeenCalledWith('GitOrchAI/autocandidata', 'tok-app')
    expect(leitor.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_remediado',
      repositoryId: 'R_repo_id',
    })
  })

  test('quando o leitor principal não encontra o board mas há token alternativo decodificado: busca e vincula via alternativo', async () => {
    const { encryptCredential } = await import('../lib/credential-crypto.js')
    const leitorPrincipal = {
      findProjectId: vi.fn(async () => null),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    }
    const leitorAlternativo = {
      findProjectId: vi.fn(async () => 'PVT_alternativo'),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    }
    const criarClienteAlternativo = vi.fn(() => leitorAlternativo)

    const decisao = await tentarAutoRemediarQuadroDaSprint({
      project: {
        id: 'p2',
        wingId: 'dono/repo',
        runtimeConfig: { githubBoardNumber: 42 },
        encryptedClientToken: encryptCredential('tok-pat-cliente'),
      },
      token: 'tok-app',
      leitor: leitorPrincipal as never,
      resolveOwnerId: async () => ({ id: 'U_dono', type: 'user' as const }),
      resolveRepositoryId: async () => 'R_repo_id',
      criarClienteAlternativo: criarClienteAlternativo as never,
    })

    expect(decisao).toEqual({
      acao: 'usar',
      quadro: {
        id: 'PVT_alternativo',
        number: 42,
        title: 'dono/repo',
        closed: false,
        linkado: true,
      },
      precisaLigar: false,
      motivo: 'quadro configurado no runtimeConfig auto-remediado com sucesso',
    })
    expect(criarClienteAlternativo).toHaveBeenCalledWith('tok-pat-cliente')
    expect(leitorAlternativo.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_alternativo',
      repositoryId: 'R_repo_id',
    })
  })

  test('quando não há board configurado no runtimeConfig: devolve null sem buscar', async () => {
    const leitor = {
      findProjectId: vi.fn(async () => 'PVT_x'),
      linkProjectV2ToRepository: vi.fn(),
    }

    const decisao = await tentarAutoRemediarQuadroDaSprint({
      project: {
        id: 'p3',
        wingId: 'dono/repo',
        runtimeConfig: {},
      },
      token: 'tok-app',
      leitor: leitor as never,
    })

    expect(decisao).toBeNull()
    expect(leitor.findProjectId).not.toHaveBeenCalled()
  })
})
