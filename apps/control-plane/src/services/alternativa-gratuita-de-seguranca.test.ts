import { describe, it, expect } from 'vitest'
import {
  workflowDeAlternativaGratuita,
  exigeRevisaoSemAlternativa,
} from './alternativa-gratuita-de-seguranca.js'

describe('workflowDeAlternativaGratuita', () => {
  it('gera um workflow com gitleaks — a mesma ferramenta que .github/workflows/ci.yml já usa', () => {
    const yaml = workflowDeAlternativaGratuita()
    expect(yaml).toContain('gitleaks')
    expect(yaml).toContain('detect --source')
  })
})

describe('exigeRevisaoSemAlternativa', () => {
  it('quando o plano não permite a melhoria E a alternativa gratuita ainda não está instalada, exige revisão antes de mesclar', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: false, alternativaInstalada: false })).toBe(
      true
    )
  })
  it('alternativa instalada: não exige a guarda extra (o gitleaks do próprio workflow já cobre)', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: false, alternativaInstalada: true })).toBe(
      false
    )
  })
  it('plano permite: não precisa de alternativa nenhuma', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: true, alternativaInstalada: false })).toBe(
      false
    )
  })
})
