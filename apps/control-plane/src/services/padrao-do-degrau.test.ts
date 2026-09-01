import { describe, expect, test } from 'vitest'
import { EXIGENCIA_DO_PAPEL, padraoDoDegrau } from './padrao-do-degrau.js'

// Os três catálogos REAIS desta conta, lidos de engine_connections em
// 01/09/2026 (`select runtime, models from engine_connections`).
const CATALOGO_ANTIGRAVITY = [
  'Gemini 3.7 Flash (High)',
  'Gemini 3.7 Flash (Medium)',
  'Gemini 3.7 Flash (Low)',
  'Gemini 3.6 Flash (High)',
  'Gemini 3.6 Flash (Medium)',
  'Gemini 3.6 Flash (Low)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
]
const CATALOGO_CLAUDE = [
  'Claude Opus 5',
  'Claude Sonnet 5',
  'Claude Fable 5',
  'Claude Opus 4.8',
  'Claude Opus 4.7',
  'Claude Sonnet 4.6',
  'Claude Opus 4.6',
  'Claude Opus 4.5',
  'Claude Haiku 4.5',
  'Claude Sonnet 4.5',
]
const CATALOGO_CODEX = ['GPT-5.5', 'GPT-5.4-Mini', 'Codex Auto Review']

describe('a exigência de cada papel está declarada, não herdada por acaso', () => {
  test('quem DECIDE e quem JULGA pedem modelo forte; quem só movimenta, o barato', () => {
    expect(EXIGENCIA_DO_PAPEL.po).toBe('forte')
    expect(EXIGENCIA_DO_PAPEL.qa).toBe('forte')
    expect(EXIGENCIA_DO_PAPEL.ra).toBe('medio')
    expect(EXIGENCIA_DO_PAPEL.sm).toBe('barato')
  })
})

describe('o padrão sai do catálogo VIVO de cada motor, nunca de um literal', () => {
  test('claude: qa (forte) pega Opus, sm (barato) pega Haiku', () => {
    expect(padraoDoDegrau({ role: 'qa', runtime: 'claude', catalogo: CATALOGO_CLAUDE }).model).toBe(
      'Claude Opus 5'
    )
    expect(padraoDoDegrau({ role: 'sm', runtime: 'claude', catalogo: CATALOGO_CLAUDE }).model).toBe(
      'Claude Haiku 4.5'
    )
    expect(padraoDoDegrau({ role: 'ra', runtime: 'claude', catalogo: CATALOGO_CLAUDE }).model).toBe(
      'Claude Sonnet 5'
    )
  })

  test('codex: forte é o modelo cheio, barato é o Mini', () => {
    expect(padraoDoDegrau({ role: 'po', runtime: 'codex', catalogo: CATALOGO_CODEX }).model).toBe(
      'GPT-5.5'
    )
    expect(padraoDoDegrau({ role: 'sm', runtime: 'codex', catalogo: CATALOGO_CODEX }).model).toBe(
      'GPT-5.4-Mini'
    )
  })

  test('antigravity: forte é Pro, e o esforço já vem embutido no nome', () => {
    const qa = padraoDoDegrau({
      role: 'qa',
      runtime: 'antigravity',
      catalogo: CATALOGO_ANTIGRAVITY,
    })
    expect(qa.model).toBe('Gemini 3.1 Pro (High)')
    // O nome já carrega o esforço: pedir --effort junto seria erro duro do CLI.
    expect(qa.effort).toBeUndefined()

    const sm = padraoDoDegrau({
      role: 'sm',
      runtime: 'antigravity',
      catalogo: CATALOGO_ANTIGRAVITY,
    })
    expect(sm.model).toBe('Gemini 3.7 Flash (Low)')
    expect(sm.effort).toBeUndefined()
  })

  test('nos motores com esforço separável, o padrão TRAZ o esforço', () => {
    expect(
      padraoDoDegrau({ role: 'qa', runtime: 'claude', catalogo: CATALOGO_CLAUDE }).effort
    ).toBe('high')
    expect(
      padraoDoDegrau({ role: 'sm', runtime: 'claude', catalogo: CATALOGO_CLAUDE }).effort
    ).toBe('low')
    expect(padraoDoDegrau({ role: 'ra', runtime: 'codex', catalogo: CATALOGO_CODEX }).effort).toBe(
      'medium'
    )
  })
})

describe('o defeito medido ao vivo: o padrão de um motor entregue a outro', () => {
  // Rodando resolveRuntimeChain com os padrões antigos, os TRÊS degraus vinham
  // com `Gemini 3.7 Flash (Medium)` — um nome do Antigravity, porque
  // `modelByRole` era uma constante só. E, medido em 01/09:
  //   claude --model "Gemini 3.7 Flash (Medium)" → "issue with the selected model"
  test('cada motor recebe um modelo do PRÓPRIO catálogo dele', () => {
    const porMotor = [
      { runtime: 'antigravity', catalogo: CATALOGO_ANTIGRAVITY },
      { runtime: 'claude', catalogo: CATALOGO_CLAUDE },
      { runtime: 'codex', catalogo: CATALOGO_CODEX },
    ] as const

    for (const { runtime, catalogo } of porMotor) {
      const escolhido = padraoDoDegrau({ role: 'ra', runtime, catalogo }).model
      expect(escolhido).toBeDefined()
      expect(catalogo).toContain(escolhido)
    }
  })

  test('nenhum motor recebe o modelo do vizinho', () => {
    const doClaude = padraoDoDegrau({ role: 'ra', runtime: 'claude', catalogo: CATALOGO_CLAUDE })
    expect(CATALOGO_ANTIGRAVITY).not.toContain(doClaude.model)
    expect(CATALOGO_CODEX).not.toContain(doClaude.model)
  })
})

describe('catálogo indisponível não pode virar palpite', () => {
  test('sem catálogo, o padrão não inventa modelo — só o esforço, que é do motor', () => {
    const r = padraoDoDegrau({ role: 'qa', runtime: 'claude', catalogo: [] })
    expect(r.model).toBeUndefined()
    expect(r.effort).toBe('high')
  })

  test('catálogo sem nenhuma família conhecida também não inventa', () => {
    const r = padraoDoDegrau({
      role: 'qa',
      runtime: 'claude',
      catalogo: ['Modelo Que Nunca Vimos'],
    })
    expect(r.model).toBeUndefined()
  })
})
