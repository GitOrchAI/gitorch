import { describe, it, expect } from 'vitest'
import { criarRegistroDeDescanso, origemFuraODescanso } from './descanso-apos-vazia.js'

const T0 = new Date('2026-08-21T12:00:00Z')
const emMinutos = (m: number) => new Date(T0.getTime() + m * 60_000)
const DEZ_MIN = 10 * 60_000

describe('origemFuraODescanso', () => {
  it('aviso do GitHub sobre um pull request fura — traz informação nova', () => {
    expect(origemFuraODescanso('aviso-do-github')).toBe(true)
  })
  it('fila levantada pelo SM fura — o SM viu entrega sem parecer', () => {
    expect(origemFuraODescanso('fila-do-sm')).toBe(true)
  })
  it('onboarding e disparo sob demanda furam', () => {
    expect(origemFuraODescanso('onboarding')).toBe(true)
    expect(origemFuraODescanso('sob-demanda')).toBe(true)
  })
  it('relógio e vigília NÃO furam — são justamente quem repete a acordada vazia', () => {
    expect(origemFuraODescanso('agenda')).toBe(false)
    expect(origemFuraODescanso('vigia')).toBe(false)
  })
})

describe('descanso após acordada vazia', () => {
  it('sem acordada vazia registrada, ninguém descansa', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    expect(r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: T0 }).pular).toBe(
      false
    )
  })

  it('acordada vazia faz o MESMO papel do MESMO projeto descansar', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    const d = r.consultar({ projectId: 'p1', role: 'qa', origem: 'vigia', agora: emMinutos(1) })
    expect(d.pular).toBe(true)
    expect(d.ate?.toISOString()).toBe(emMinutos(10).toISOString())
  })

  it('o descanso é por (projeto, papel): não contamina vizinho', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(
      r.consultar({ projectId: 'p2', role: 'qa', origem: 'agenda', agora: emMinutos(1) }).pular
    ).toBe(false)
    expect(
      r.consultar({ projectId: 'p1', role: 'sm', origem: 'agenda', agora: emMinutos(1) }).pular
    ).toBe(false)
  })

  it('vencido o prazo, volta a acordar sozinho', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(
      r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: emMinutos(11) }).pular
    ).toBe(false)
  })

  it('aviso do GitHub FURA o descanso — julgamento nunca fica mudo', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(
      r.consultar({
        projectId: 'p1',
        role: 'qa',
        origem: 'aviso-do-github',
        agora: emMinutos(1),
      }).pular
    ).toBe(false)
  })

  it('a fila do SM FURA o descanso — senão um conserto anularia o outro', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(
      r.consultar({ projectId: 'p1', role: 'qa', origem: 'fila-do-sm', agora: emMinutos(1) }).pular
    ).toBe(false)
  })

  it('acordada que FEZ trabalho apaga o descanso na hora', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    r.registrarAcordadaProdutiva({ projectId: 'p1', role: 'qa' })
    expect(
      r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: emMinutos(1) }).pular
    ).toBe(false)
  })

  it('avisa ALTO uma vez só; as repetições do minuto a minuto não viram spam', () => {
    const r = criarRegistroDeDescanso(DEZ_MIN)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(
      r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: emMinutos(1) })
        .primeiraVez
    ).toBe(true)
    expect(
      r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: emMinutos(2) })
        .primeiraVez
    ).toBe(false)
  })

  it('duração zero desliga o descanso por completo (válvula de escape)', () => {
    const r = criarRegistroDeDescanso(0)
    r.registrarAcordadaVazia({ projectId: 'p1', role: 'qa', agora: T0 })
    expect(r.consultar({ projectId: 'p1', role: 'qa', origem: 'agenda', agora: T0 }).pular).toBe(
      false
    )
  })
})
