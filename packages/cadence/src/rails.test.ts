import { describe, it, expect } from 'vitest'
import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  validateDoD,
  validateForm,
  type PoBacklogForm,
} from './rails'

describe('RAILS_SCHEMAS', () => {
  it('cobre os formulários dos papéis', () => {
    for (const key of ['raBrief', 'poPhases', 'poEpics', 'poBacklog', 'poSprint', 'qaVerdict']) {
      expect(RAILS_SCHEMAS[key as keyof typeof RAILS_SCHEMAS]).toBeTruthy()
    }
  })
})

describe('validateForm (validador minimal por schema)', () => {
  it('aceita PoPhases válido', () => {
    const r = validateForm(RAILS_SCHEMAS.poPhases, {
      phases: [{ title: 'Fase 1', goal: 'Estruturar dados', rationale: 'Base de tudo' }],
    })
    expect(r.ok).toBe(true)
  })

  it('rejeita PoPhases sem campo obrigatório e diz QUAL', () => {
    const r = validateForm(RAILS_SCHEMAS.poPhases, { phases: [{ title: 'Fase 1' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('goal')
  })

  it('rejeita enum inválido no QaVerdict', () => {
    const r = validateForm(RAILS_SCHEMAS.qaVerdict, {
      verdict: 'maybe',
      comment: {
        titulo: 'x',
        description: 'x',
        notes: 'x',
        implementationGuide: 'x',
        verificationCriteria: 'x',
        summary: 'x',
        analysisResult: 'x',
        relatedFiles: 'x',
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('verdict')
  })
})

describe('validateDoD (código puro, 8 campos)', () => {
  const good = {
    titulo: '[Task] Adicionar coluna material',
    description: 'Adicionar coluna material na tabela products.',
    notes: 'Enum inicial: PLA, PETG, ABS.',
    implementationGuide: '1. migration; 2. backfill; 3. expor na API.',
    verificationCriteria: '- GET /products?material=PLA retorna só PLA.',
    summary: 'Coluna estruturada de material.',
    analysisResult: 'Hoje material é regex na descrição (frágil).',
    relatedFiles: 'schema_tables.sql, src/pages/Products.tsx',
  }

  it('aceita item completo', () => {
    expect(validateDoD(good).ok).toBe(true)
  })

  it('rejeita campo vazio e aponta qual', () => {
    const r = validateDoD({ ...good, verificationCriteria: '  ' })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('verificationCriteria')
  })
})

describe('buildStepPrompt', () => {
  it('monta prompt curto com playbook, contexto e schema', () => {
    const p = buildStepPrompt('po', 'phases', RAILS_SCHEMAS.poPhases, [
      'Wish: filtro por material',
      'RA brief: hoje é regex',
    ])
    expect(p).toContain('Product Owner')
    expect(p).toContain('Wish: filtro por material')
    expect(p).toContain('ONLY with a single JSON object')
    expect(p).toContain('"phases"')
    // NUNCA instruir ação direta no GitHub
    expect(p.toLowerCase()).not.toContain('gh ')
    expect(p.toLowerCase()).not.toContain('create the issue')
  })
})

describe('tipos utilizáveis', () => {
  it('PoBacklogForm tipa itens com 8 campos', () => {
    const form: PoBacklogForm = {
      items: [
        {
          epicIndex: 0,
          kind: 'task',
          fields: {
            titulo: 't',
            description: 'd',
            notes: 'n',
            implementationGuide: 'i',
            verificationCriteria: 'v',
            summary: 's',
            analysisResult: 'a',
            relatedFiles: 'r',
          },
        },
      ],
    }
    expect(form.items[0].kind).toBe('task')
  })
})
