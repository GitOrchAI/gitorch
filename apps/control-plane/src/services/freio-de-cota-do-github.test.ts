import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErroDoGitHub, erroDaRespostaDoGitHub } from './erro-do-github.js'
import {
  TETO_DO_FREIO_DE_COTA_MS,
  donoDoCaminho,
  donoDoRepositorio,
  freioDeCotaAte,
  freioDeCotaAtivo,
  lancarErroDoGitHub,
  limparFreiosDeCota,
  pularSeFreioDeCotaAtivo,
  registrarFreioDeCota,
} from './freio-de-cota-do-github.js'

const agora = new Date('2026-10-08T12:00:00.000Z')
const emSegundos = (d: Date) => Math.floor(d.getTime() / 1000)

function erro(status: number, cabecalhos: Record<string, string> = {}): ErroDoGitHub {
  return erroDaRespostaDoGitHub(`GitHub GET /x failed (${status})`, {
    status,
    headers: new Headers(cabecalhos),
  })
}

beforeEach(() => limparFreiosDeCota())

describe('donoDoRepositorio / donoDoCaminho', () => {
  it('pega o dono em minúsculas, a cota é por instalação', () => {
    expect(donoDoRepositorio('GitOrchAI/gitorch')).toBe('gitorchai')
    expect(donoDoCaminho('/repos/GitOrchAI/gitorch/issues/7')).toBe('gitorchai')
    expect(donoDoCaminho('/user/installations')).toBeNull()
  })
})

describe('registrarFreioDeCota', () => {
  it('403 com a cota zerada freia o dono até a hora do reset', () => {
    const reset = new Date(agora.getTime() + 5 * 60_000)
    const ate = registrarFreioDeCota(
      'acme',
      erro(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(emSegundos(reset)) }),
      agora
    )
    expect(ate).toEqual(reset)
    expect(freioDeCotaAtivo('acme', agora)).toBe(true)
    expect(freioDeCotaAte('acme', agora)).toEqual(reset)
  })

  it('429 com retry-after freia pelo tempo pedido', () => {
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '90' }), agora)
    expect(freioDeCotaAte('acme', agora)).toEqual(new Date(agora.getTime() + 90_000))
  })

  it('403 com retry-after (limite secundário) também freia', () => {
    registrarFreioDeCota('acme', erro(403, { 'retry-after': '30' }), agora)
    expect(freioDeCotaAtivo('acme', agora)).toBe(true)
  })

  it('o freio nunca passa de 15 minutos', () => {
    const reset = new Date(agora.getTime() + 60 * 60_000)
    const ate = registrarFreioDeCota(
      'acme',
      erro(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(emSegundos(reset)) }),
      agora
    )
    expect(ate).toEqual(new Date(agora.getTime() + TETO_DO_FREIO_DE_COTA_MS))
    expect(TETO_DO_FREIO_DE_COTA_MS).toBe(15 * 60_000)
  })

  it('403 de permissão (sem retry-after e com cota sobrando) NÃO freia', () => {
    expect(
      registrarFreioDeCota(
        'acme',
        erro(403, { 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '1790000000' }),
        agora
      )
    ).toBeNull()
    expect(freioDeCotaAtivo('acme', agora)).toBe(false)
  })

  it('403 sem nenhum cabeçalho, 404 e 500 não freiam', () => {
    for (const e of [erro(403), erro(404), erro(500, { 'retry-after': '60' })]) {
      expect(registrarFreioDeCota('acme', e, agora)).toBeNull()
    }
    expect(freioDeCotaAtivo('acme', agora)).toBe(false)
  })

  it('reset que já passou não freia', () => {
    const passado = new Date(agora.getTime() - 60_000)
    expect(
      registrarFreioDeCota(
        'acme',
        erro(403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(emSegundos(passado)),
        }),
        agora
      )
    ).toBeNull()
  })

  it('erro que não é do GitHub é ignorado', () => {
    expect(registrarFreioDeCota('acme', new Error('rede caiu'), agora)).toBeNull()
    expect(registrarFreioDeCota('acme', 'texto solto', agora)).toBeNull()
  })

  it('um freio novo mais curto não encurta o que já estava valendo', () => {
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '600' }), agora)
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '10' }), agora)
    expect(freioDeCotaAte('acme', agora)).toEqual(new Date(agora.getTime() + 600_000))
  })

  it('o freio de um dono não vale para outro', () => {
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '60' }), agora)
    expect(freioDeCotaAtivo('outro', agora)).toBe(false)
  })

  it('o freio se solta sozinho quando a hora passa', () => {
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '60' }), agora)
    const depois = new Date(agora.getTime() + 61_000)
    expect(freioDeCotaAtivo('acme', depois)).toBe(false)
    expect(freioDeCotaAte('acme', depois)).toBeNull()
  })
})

describe('lancarErroDoGitHub', () => {
  it('lança o erro tipado com a mensagem recebida e já registra o freio do dono do caminho', () => {
    const resp = { status: 429, headers: new Headers({ 'retry-after': '120' }) }
    let lancado: unknown
    try {
      lancarErroDoGitHub(
        'GitHub GET /repos/Acme/api/issues/7 failed (429)',
        resp,
        '/repos/Acme/api/issues/7',
        agora
      )
    } catch (e) {
      lancado = e
    }
    expect(lancado).toBeInstanceOf(ErroDoGitHub)
    expect((lancado as Error).message).toBe('GitHub GET /repos/Acme/api/issues/7 failed (429)')
    expect(freioDeCotaAte('acme', agora)).toEqual(new Date(agora.getTime() + 120_000))
  })

  it('caminho sem dono (ex. /user) ainda lança, só não registra freio', () => {
    const resp = { status: 403, headers: new Headers({ 'retry-after': '120' }) }
    expect(() => lancarErroDoGitHub('GitHub GET /user failed (403)', resp, '/user', agora)).toThrow(
      /failed \(403\)/
    )
    expect(freioDeCotaAtivo('acme', agora)).toBe(false)
  })
})

describe('pularSeFreioDeCotaAtivo', () => {
  it('sem freio devolve false e não escreve nada no log', () => {
    const info = vi.fn()
    expect(
      pularSeFreioDeCotaAtivo({
        etapa: 'varrerArvoreDosPlanos',
        repositorio: 'acme/api',
        agora,
        jaAvisados: new Set(),
        info,
      })
    ).toBe(false)
    expect(info).not.toHaveBeenCalled()
  })

  it('com freio devolve true e escreve UMA linha por dono, mesmo com vários repositórios', () => {
    registrarFreioDeCota('acme', erro(429, { 'retry-after': '120' }), agora)
    const info = vi.fn()
    const jaAvisados = new Set<string>()
    const pular = (repositorio: string) =>
      pularSeFreioDeCotaAtivo({
        etapa: 'varrerTarefasEntregues',
        repositorio,
        agora,
        jaAvisados,
        info,
      })
    expect(pular('Acme/api')).toBe(true)
    expect(pular('acme/web')).toBe(true)
    expect(pular('outro/x')).toBe(false)
    expect(info).toHaveBeenCalledTimes(1)
    const linha = String(info.mock.calls[0]![0])
    expect(linha).toContain('varrerTarefasEntregues')
    expect(linha).toContain('acme')
    expect(linha).toContain('2026-10-08T12:02:00.000Z')
  })
})
