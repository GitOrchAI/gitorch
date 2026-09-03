import { describe, it, expect } from 'vitest'
import { marcador, lerMarcador, TETO_DE_CARACTERES_DO_MARCADOR } from './marcador-de-issue.js'

// R1 (fix-up L4-T2): helper único de marcador HTML — hoje duplicado em
// `services/proposta.ts` (marcadorDaProposta) e
// `services/reconciliar-incidentes-legados.ts` (identidadeDoMarcador), cada
// um com a própria regex. `marcador`/`lerMarcador` viram a ÚNICA fonte.

describe('marcador', () => {
  it('monta o comentário HTML exato <!-- gitorch:<tipo>:<id> -->', () => {
    expect(marcador('incident', 'wf:11')).toBe('<!-- gitorch:incident:wf:11 -->')
    expect(marcador('proposta', 'wf:77')).toBe('<!-- gitorch:proposta:wf:77 -->')
    expect(marcador('proposta:arquivo', '.github/workflows/x.yml')).toBe(
      '<!-- gitorch:proposta:arquivo:.github/workflows/x.yml -->'
    )
  })
})

describe('lerMarcador', () => {
  it('extrai o id do marcador do tipo pedido no corpo da issue', () => {
    expect(lerMarcador('texto\n<!-- gitorch:incident:wf:11 -->\nmais texto', 'incident')).toBe(
      'wf:11'
    )
  })

  it('ignora marcador de OUTRO tipo (não confunde proposta com proposta:arquivo)', () => {
    const body =
      '<!-- gitorch:proposta:wf:77 -->\n<!-- gitorch:proposta:arquivo:.github/workflows/x.yml -->'
    expect(lerMarcador(body, 'proposta')).toBe('wf:77')
    expect(lerMarcador(body, 'proposta:arquivo')).toBe('.github/workflows/x.yml')
  })

  it('extrai id com travessão e espaços (mesmo caso legado do identidadeDoMarcador)', () => {
    expect(
      lerMarcador(
        '<!--gitorch:incident:ci:Jules API Retry — re-dispara via API direta-->',
        'incident'
      )
    ).toBe('ci:Jules API Retry — re-dispara via API direta')
  })

  it('sem marcador do tipo pedido → null', () => {
    expect(lerMarcador('issue comum, sem marcador nenhum', 'incident')).toBeNull()
    expect(lerMarcador('<!-- gitorch:proposta:x -->', 'incident')).toBeNull()
  })

  it('body vazio/ausente → null, nunca explode', () => {
    expect(lerMarcador(null, 'incident')).toBeNull()
    expect(lerMarcador(undefined, 'incident')).toBeNull()
    expect(lerMarcador('', 'incident')).toBeNull()
  })

  it('id maior que 200 caracteres → corta em 200', () => {
    const bruto = 'x'.repeat(300)
    const resultado = lerMarcador(`<!-- gitorch:incident:${bruto} -->`, 'incident')
    expect(resultado).not.toBeNull()
    expect(resultado).toHaveLength(TETO_DE_CARACTERES_DO_MARCADOR)
    expect(resultado).toBe('x'.repeat(200))
  })

  it('marcador vazio → null (não string vazia)', () => {
    expect(lerMarcador('<!-- gitorch:incident: -->', 'incident')).toBeNull()
  })

  it('marcador só espaços → null', () => {
    expect(lerMarcador('<!-- gitorch:incident:    -->', 'incident')).toBeNull()
  })
})
