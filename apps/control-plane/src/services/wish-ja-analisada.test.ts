import { describe, it, expect } from 'vitest'
import {
  decidirTrabalhoDoRa,
  marcarComoAnalisado,
  MARCA_DE_ANALISE_DO_RA,
} from './wish-ja-analisada.js'

const ONTEM = new Date('2026-08-24T10:00:00Z')
const HOJE = '2026-08-25T10:00:00Z'

describe('decidirTrabalhoDoRa', () => {
  // Pelo webhook o desejo acabou de chegar: é ele que precisa de análise.
  it('desejo novo pelo webhook: ancora nele', () => {
    const d = decidirTrabalhoDoRa({
      desejo: { numero: 1, corpo: 'quero busca por cor' },
      pelaAgenda: false,
    })
    expect(d.acao).toBe('ancorar-no-desejo')
  })

  // O defeito medido: duas vezes por dia ele refazia a mesma análise em vez de
  // aprender mais do projeto.
  it('pela agenda, com o desejo JÁ analisado: explora o projeto', () => {
    const d = decidirTrabalhoDoRa({
      desejo: { numero: 1, corpo: `quero busca por cor\n\n${MARCA_DE_ANALISE_DO_RA}` },
      pelaAgenda: true,
    })
    expect(d.acao).toBe('explorar-o-projeto')
    expect(d.motivo).toMatch(/já foi analisado/i)
  })

  it('pela agenda, com desejo ainda NÃO analisado: ancora nele', () => {
    const d = decidirTrabalhoDoRa({
      desejo: { numero: 1, corpo: 'quero busca por cor' },
      pelaAgenda: true,
    })
    expect(d.acao).toBe('ancorar-no-desejo')
  })

  // Sem isto, uma correção do dono no texto do desejo seria ignorada para
  // sempre — ele mudou o que quer, e a análise anterior é sobre outra coisa.
  it('desejo EDITADO depois da análise volta a ser analisado', () => {
    const d = decidirTrabalhoDoRa({
      desejo: {
        numero: 1,
        corpo: `quero busca por cor E por tamanho\n\n${MARCA_DE_ANALISE_DO_RA}`,
        atualizadoEm: HOJE,
      },
      pelaAgenda: true,
      analisadoEm: ONTEM,
    })
    expect(d.acao).toBe('ancorar-no-desejo')
    expect(d.motivo).toMatch(/editado/i)
  })

  it('edição ANTERIOR à análise não reabre nada', () => {
    const d = decidirTrabalhoDoRa({
      desejo: {
        numero: 1,
        corpo: `texto\n\n${MARCA_DE_ANALISE_DO_RA}`,
        atualizadoEm: '2026-08-23T10:00:00Z',
      },
      pelaAgenda: true,
      analisadoEm: ONTEM,
    })
    expect(d.acao).toBe('explorar-o-projeto')
  })

  it('data de edição ilegível não reabre a análise', () => {
    const d = decidirTrabalhoDoRa({
      desejo: {
        numero: 1,
        corpo: `texto\n\n${MARCA_DE_ANALISE_DO_RA}`,
        atualizadoEm: 'não é data',
      },
      pelaAgenda: true,
      analisadoEm: ONTEM,
    })
    expect(d.acao).toBe('explorar-o-projeto')
  })

  // Sem desejo aberto o RA sempre explorou — é o que o código já fazia, e
  // continua certo.
  it('sem desejo nenhum: explora o projeto', () => {
    expect(decidirTrabalhoDoRa({ desejo: null, pelaAgenda: true }).acao).toBe('explorar-o-projeto')
    expect(decidirTrabalhoDoRa({ desejo: undefined, pelaAgenda: false }).acao).toBe(
      'explorar-o-projeto'
    )
  })
})

describe('marcarComoAnalisado', () => {
  it('acrescenta a marca sem tocar no texto do dono', () => {
    const marcado = marcarComoAnalisado('quero busca por cor')
    expect(marcado).toContain('quero busca por cor')
    expect(marcado).toContain(MARCA_DE_ANALISE_DO_RA)
  })

  it('marcar duas vezes não duplica a marca', () => {
    const uma = marcarComoAnalisado('texto')
    const duas = marcarComoAnalisado(uma)
    expect(duas).toBe(uma)
    expect(duas.split(MARCA_DE_ANALISE_DO_RA)).toHaveLength(2)
  })

  it('corpo vazio ou ausente não vira texto quebrado', () => {
    expect(marcarComoAnalisado('')).toBe(MARCA_DE_ANALISE_DO_RA)
    expect(marcarComoAnalisado(null)).toBe(MARCA_DE_ANALISE_DO_RA)
  })
})
