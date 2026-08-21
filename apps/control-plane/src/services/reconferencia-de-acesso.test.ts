import { describe, expect, it, vi } from 'vitest'
import {
  precisaReconferir,
  decidirAcessoDoProjeto,
  reconferirAcessoDosProjetos,
  projetoEstaSuspensoPorAcesso,
  INTERVALO_DE_RECONFERENCIA_MS,
  INTERVALO_DE_NOVA_TENTATIVA_MS,
  FALHAS_ATE_AVISAR,
  type EstadoDeAcesso,
  type ProjetoParaReconferir,
} from './reconferencia-de-acesso.js'
import {
  AcessoNaoVerificavelError,
  CredencialDoGithubInvalidaError,
} from './acesso-ao-repositorio.js'

/**
 * O buraco que este arquivo fecha: a reconferência de acesso só existia nas
 * duas portas do PEDIDO (a tela e o mensageiro). O relógio — que escreve muito
 * mais, sozinho, sem ninguém clicar em nada — nunca reconferia.
 *
 * Alice é colaboradora com escrita em `acme/api`, conclui o cadastro (a prova
 * passa), o projeto nasce com as agendas padrão. A Acme remove a Alice. As
 * portas do pedido passam a recusar na hora — e o relógio continua disparando
 * missão e escrevendo no repositório com a credencial da instalação.
 *
 * O desenho NÃO é provar a cada operação (seria uma chamada a mais por missão,
 * contra a cota do cliente, e o produto age com a credencial da instalação,
 * que continua legítima). É PERIÓDICO e por PROJETO: uma prova por projeto por
 * ciclo, e quem perdeu o acesso tem o projeto SUSPENSO até recuperar.
 */

const AGORA = new Date('2026-03-10T12:00:00Z')

function estado(parcial: Partial<EstadoDeAcesso> = {}): EstadoDeAcesso {
  return {
    conferidoEm: null,
    suspensoEm: null,
    motivoDaSuspensao: null,
    falhasSeguidas: 0,
    ...parcial,
  }
}

describe('precisaReconferir', () => {
  it('projeto que nunca foi conferido é conferido na primeira oportunidade', () => {
    expect(precisaReconferir(estado(), AGORA)).toBe(true)
  })

  it('conferido agora há pouco NÃO gasta chamada de novo', () => {
    const conferidoEm = new Date(AGORA.getTime() - 60_000)
    expect(precisaReconferir(estado({ conferidoEm }), AGORA)).toBe(false)
  })

  it('vencido o intervalo do ciclo, confere de novo', () => {
    const conferidoEm = new Date(AGORA.getTime() - INTERVALO_DE_RECONFERENCIA_MS)
    expect(precisaReconferir(estado({ conferidoEm }), AGORA)).toBe(true)
  })

  // "Sempre antes do primeiro disparo do dia": as agendas padrão acordam de
  // manhã, e uma conferência de ontem à noite não pode autorizar o dia inteiro
  // de hoje.
  it('primeira vez no dia confere, mesmo dentro do intervalo', () => {
    const ontemTarde = new Date('2026-03-09T23:50:00Z')
    const madrugada = new Date('2026-03-10T00:10:00Z')
    expect(precisaReconferir(estado({ conferidoEm: ontemTarde }), madrugada)).toBe(true)
  })

  // Uma indisponibilidade do GitHub não pode empurrar a próxima tentativa para
  // daqui a seis horas: enquanto há falha em aberto, o intervalo é curto.
  it('com falha em aberto, tenta de novo em intervalo curto — mas não a cada minuto', () => {
    const cedoDemais = new Date(AGORA.getTime() - 60_000)
    const jaPode = new Date(AGORA.getTime() - INTERVALO_DE_NOVA_TENTATIVA_MS)
    expect(precisaReconferir(estado({ conferidoEm: cedoDemais, falhasSeguidas: 2 }), AGORA)).toBe(
      false
    )
    expect(precisaReconferir(estado({ conferidoEm: jaPode, falhasSeguidas: 2 }), AGORA)).toBe(true)
  })

  it('relógio adiantado (conferido no futuro) não vira conferência em cascata', () => {
    const futuro = new Date(AGORA.getTime() + 3_600_000)
    expect(precisaReconferir(estado({ conferidoEm: futuro }), AGORA)).toBe(false)
  })
})

describe('decidirAcessoDoProjeto', () => {
  it('ACESSO OK: nada muda, o contador de falhas zera e ninguém é incomodado', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ falhasSeguidas: 3 }),
      prova: { tipo: 'escreve' },
      agora: AGORA,
    })

    expect(d.virada).toBeNull()
    expect(d.avisoAoDono).toBeNull()
    expect(d.estado).toEqual({
      conferidoEm: AGORA,
      suspensoEm: null,
      motivoDaSuspensao: null,
      falhasSeguidas: 0,
    })
  })

  it('SEM ACESSO: o projeto é suspenso e o dono é avisado do motivo, em português de gente', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ conferidoEm: new Date('2026-03-10T00:00:00Z') }),
      prova: { tipo: 'nao-escreve' },
      agora: AGORA,
    })

    expect(d.virada).toBe('suspendeu')
    expect(d.estado.suspensoEm).toEqual(AGORA)
    expect(d.estado.motivoDaSuspensao).toBeTruthy()
    expect(d.avisoAoDono).toContain('acme/api')
    expect(d.avisoAoDono).toMatch(/não tem mais acesso/i)
  })

  it('SEM ACESSO de novo: continua suspenso pela MESMA data e o dono não é avisado duas vezes', () => {
    const suspensoEm = new Date('2026-03-09T06:00:00Z')
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ suspensoEm, motivoDaSuspensao: 'sem escrita', falhasSeguidas: 0 }),
      prova: { tipo: 'nao-escreve' },
      agora: AGORA,
    })

    expect(d.virada).toBeNull()
    expect(d.avisoAoDono).toBeNull()
    expect(d.estado.suspensoEm).toEqual(suspensoEm)
    expect(d.estado.conferidoEm).toEqual(AGORA)
  })

  it('INVERIFICÁVEL uma vez: NÃO suspende ninguém — só conta a falha, em silêncio', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado(),
      prova: { tipo: 'inconclusiva', motivo: 'HTTP 500' },
      agora: AGORA,
    })

    expect(d.virada).toBeNull()
    expect(d.avisoAoDono).toBeNull()
    expect(d.estado.suspensoEm).toBeNull()
    expect(d.estado.falhasSeguidas).toBe(1)
    expect(d.estado.conferidoEm).toEqual(AGORA)
  })

  it('INVERIFICÁVEL várias vezes seguidas: avisa que não está conseguindo conferir — e ainda assim não suspende', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ falhasSeguidas: FALHAS_ATE_AVISAR - 1 }),
      prova: { tipo: 'inconclusiva', motivo: 'HTTP 500' },
      agora: AGORA,
    })

    expect(d.estado.falhasSeguidas).toBe(FALHAS_ATE_AVISAR)
    expect(d.estado.suspensoEm).toBeNull()
    expect(d.avisoAoDono).toContain('acme/api')
    expect(d.avisoAoDono).toMatch(/não estou conseguindo confirmar/i)
  })

  it('o aviso de "não consigo conferir" não vira ruído: sai uma vez, não a cada ciclo', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ falhasSeguidas: FALHAS_ATE_AVISAR + 3 }),
      prova: { tipo: 'inconclusiva', motivo: 'HTTP 500' },
      agora: AGORA,
    })

    expect(d.avisoAoDono).toBeNull()
  })

  it('credencial recusada é inverificável (não suspende), mas o aviso manda RECONECTAR', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ falhasSeguidas: FALHAS_ATE_AVISAR - 1 }),
      prova: { tipo: 'inconclusiva', motivo: 'HTTP 401', credencial: true },
      agora: AGORA,
    })

    expect(d.estado.suspensoEm).toBeNull()
    expect(d.avisoAoDono).toMatch(/reconecte/i)
  })

  it('projeto SUSPENSO que fica inverificável continua suspenso — dúvida não solta o freio', () => {
    const suspensoEm = new Date('2026-03-09T06:00:00Z')
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({ suspensoEm, motivoDaSuspensao: 'sem escrita' }),
      prova: { tipo: 'inconclusiva', motivo: 'HTTP 500' },
      agora: AGORA,
    })

    expect(d.estado.suspensoEm).toEqual(suspensoEm)
    expect(d.virada).toBeNull()
  })

  it('RECUPEROU o acesso: volta a rodar sozinho, sem ninguém precisar mexer, e o dono é avisado', () => {
    const d = decidirAcessoDoProjeto({
      repo: 'acme/api',
      estado: estado({
        suspensoEm: new Date('2026-03-09T06:00:00Z'),
        motivoDaSuspensao: 'sem escrita',
        falhasSeguidas: 2,
      }),
      prova: { tipo: 'escreve' },
      agora: AGORA,
    })

    expect(d.virada).toBe('liberou')
    expect(d.estado.suspensoEm).toBeNull()
    expect(d.estado.motivoDaSuspensao).toBeNull()
    expect(d.estado.falhasSeguidas).toBe(0)
    expect(d.avisoAoDono).toContain('acme/api')
    expect(d.avisoAoDono).toMatch(/voltei/i)
  })
})

describe('projetoEstaSuspensoPorAcesso', () => {
  it('projeto com suspensão registrada não dispara missão', () => {
    expect(projetoEstaSuspensoPorAcesso({ accessSuspendedAt: AGORA })).toBe(true)
  })

  it('projeto sem suspensão dispara normalmente', () => {
    expect(projetoEstaSuspensoPorAcesso({ accessSuspendedAt: null })).toBe(false)
    expect(projetoEstaSuspensoPorAcesso({})).toBe(false)
  })
})

describe('reconferirAcessoDosProjetos', () => {
  function projeto(parcial: Partial<ProjetoParaReconferir> = {}): ProjetoParaReconferir {
    return {
      id: 'proj_1',
      repo: 'acme/api',
      ownerId: 'user_1',
      estado: estado(),
      ...parcial,
    }
  }

  it('dono que perdeu o acesso: o projeto é suspenso, gravado e o dono avisado pelo Telegram', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)
    const avisarDono = vi.fn(async (_projectId: string, _texto: string) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto()],
      provarEscrita: async () => false,
      salvar,
      avisarDono,
      agora: AGORA,
    })

    expect(resumo.suspensos).toBe(1)
    expect(salvar).toHaveBeenCalledWith(
      'proj_1',
      expect.objectContaining({ suspensoEm: AGORA, conferidoEm: AGORA })
    )
    expect(avisarDono).toHaveBeenCalledWith('proj_1', expect.stringContaining('acme/api'))
  })

  it('uma prova por projeto por ciclo — nunca uma por missão', async () => {
    const provarEscrita = vi.fn(async () => true)

    await reconferirAcessoDosProjetos({
      projetos: async () => [
        projeto({ id: 'p1', repo: 'acme/api' }),
        projeto({ id: 'p2', repo: 'acme/web' }),
      ],
      provarEscrita,
      salvar: async () => undefined,
      agora: AGORA,
    })

    expect(provarEscrita).toHaveBeenCalledTimes(2)
    expect(provarEscrita).toHaveBeenCalledWith('acme/api', 'user_1')
    expect(provarEscrita).toHaveBeenCalledWith('acme/web', 'user_1')
  })

  it('projeto conferido há pouco não é perguntado de novo — a cota do cliente não é nossa', async () => {
    const provarEscrita = vi.fn(async () => true)
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [
        projeto({ estado: estado({ conferidoEm: new Date(AGORA.getTime() - 60_000) }) }),
      ],
      provarEscrita,
      salvar,
      agora: AGORA,
    })

    expect(provarEscrita).not.toHaveBeenCalled()
    expect(salvar).not.toHaveBeenCalled()
    expect(resumo.conferidos).toBe(0)
  })

  it('GitHub fora do ar NÃO derruba o trabalho de todo mundo: ninguém é suspenso', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)
    const avisarDono = vi.fn(async (_projectId: string, _texto: string) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto({ id: 'p1' }), projeto({ id: 'p2' })],
      provarEscrita: async () => {
        throw new AcessoNaoVerificavelError('o GitHub respondeu HTTP 500')
      },
      salvar,
      avisarDono,
      agora: AGORA,
    })

    expect(resumo.suspensos).toBe(0)
    expect(resumo.inconclusivos).toBe(2)
    for (const chamada of salvar.mock.calls) {
      expect(chamada[1].suspensoEm).toBeNull()
      expect(chamada[1].falhasSeguidas).toBe(1)
    }
    expect(avisarDono).not.toHaveBeenCalled()
  })

  it('credencial revogada não suspende — mas depois de várias, o dono ouve que precisa reconectar', async () => {
    const avisarDono = vi.fn(async (_projectId: string, _texto: string) => undefined)

    await reconferirAcessoDosProjetos({
      projetos: async () => [
        projeto({ estado: estado({ falhasSeguidas: FALHAS_ATE_AVISAR - 1 }) }),
      ],
      provarEscrita: async () => {
        throw new CredencialDoGithubInvalidaError('HTTP 401 Bad credentials')
      },
      salvar: async () => undefined,
      avisarDono,
      agora: AGORA,
    })

    expect(avisarDono).toHaveBeenCalledWith('proj_1', expect.stringMatching(/reconecte/i))
  })

  // Um defeito nosso (bug de programação no meio do caminho) tem de resolver
  // no lado seguro: dúvida NUNCA suspende o trabalho de um cliente.
  it('erro inesperado na prova também é dúvida — não suspende', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto()],
      provarEscrita: async () => {
        throw new TypeError('undefined is not a function')
      },
      salvar,
      agora: AGORA,
    })

    expect(resumo.suspensos).toBe(0)
    expect(salvar.mock.calls[0]?.[1].suspensoEm).toBeNull()
  })

  it('recuperou o acesso: a suspensão é apagada sozinha, sem ninguém mexer', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)
    const avisarDono = vi.fn(async (_projectId: string, _texto: string) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [
        projeto({ estado: estado({ suspensoEm: new Date('2026-03-01T00:00:00Z') }) }),
      ],
      provarEscrita: async () => true,
      salvar,
      avisarDono,
      agora: AGORA,
    })

    expect(resumo.liberados).toBe(1)
    expect(salvar.mock.calls[0]?.[1].suspensoEm).toBeNull()
    expect(avisarDono).toHaveBeenCalledWith('proj_1', expect.stringMatching(/voltei/i))
  })

  it('projeto sem dono (registro legado) é ignorado: não há credencial com que perguntar', async () => {
    const provarEscrita = vi.fn(async () => true)
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)

    await reconferirAcessoDosProjetos({
      projetos: async () => [projeto({ ownerId: null })],
      provarEscrita,
      salvar,
      agora: AGORA,
    })

    expect(provarEscrita).not.toHaveBeenCalled()
    expect(salvar).not.toHaveBeenCalled()
  })

  it('falha ao gravar um projeto não impede a conferência dos outros', async () => {
    const salvar = vi.fn(async (projectId: string, _estado: EstadoDeAcesso) => {
      if (projectId === 'p1') throw new Error('banco fora do ar')
    })
    const onWarn = vi.fn()

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto({ id: 'p1' }), projeto({ id: 'p2' })],
      provarEscrita: async () => true,
      salvar,
      onWarn,
      agora: AGORA,
    })

    expect(salvar).toHaveBeenCalledTimes(2)
    expect(onWarn).toHaveBeenCalled()
    expect(resumo.conferidos).toBe(2)
  })

  it('sem vínculo de Telegram o trabalho continua: a suspensão vale mesmo sem aviso', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto()],
      provarEscrita: async () => false,
      salvar,
      agora: AGORA,
    })

    expect(resumo.suspensos).toBe(1)
    expect(salvar.mock.calls[0]?.[1].suspensoEm).toEqual(AGORA)
  })

  it('aviso que falha (Telegram fora) não desfaz a suspensão já gravada', async () => {
    const salvar = vi.fn(async (_projectId: string, _estado: EstadoDeAcesso) => undefined)
    const onWarn = vi.fn()

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [projeto()],
      provarEscrita: async () => false,
      salvar,
      avisarDono: async () => {
        throw new Error('telegram fora')
      },
      onWarn,
      agora: AGORA,
    })

    expect(resumo.suspensos).toBe(1)
    expect(salvar).toHaveBeenCalled()
    expect(onWarn).toHaveBeenCalled()
  })

  it('nenhum projeto para conferir: nem uma chamada ao GitHub', async () => {
    const provarEscrita = vi.fn(async () => true)

    const resumo = await reconferirAcessoDosProjetos({
      projetos: async () => [],
      provarEscrita,
      salvar: async () => undefined,
      agora: AGORA,
    })

    expect(provarEscrita).not.toHaveBeenCalled()
    expect(resumo).toEqual({ conferidos: 0, suspensos: 0, liberados: 0, inconclusivos: 0 })
  })
})
