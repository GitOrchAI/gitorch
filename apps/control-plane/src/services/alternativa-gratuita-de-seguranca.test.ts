import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ACTION_CHECKOUT_SHA,
  GITLEAKS_VERSION,
  workflowDeAlternativaGratuita,
  exigeRevisaoSemAlternativa,
} from './alternativa-gratuita-de-seguranca.js'

const CI_DO_GITORCH = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/ci.yml'),
  'utf8'
)

describe('workflowDeAlternativaGratuita', () => {
  it('gera um workflow com gitleaks — a mesma ferramenta que .github/workflows/ci.yml já usa', () => {
    const yaml = workflowDeAlternativaGratuita()
    expect(yaml).toContain('gitleaks')
    expect(yaml).toContain('detect --source')
  })
})

describe('workflowDeAlternativaGratuita: o arquivo que vai para o repositório do cliente', () => {
  const yaml = workflowDeAlternativaGratuita()

  it('toda Action é fixada por SHA completo de 40 caracteres hexadecimais, nunca por tag', () => {
    const usos = [...yaml.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? '')
    expect(usos.length).toBeGreaterThan(0)
    for (const uso of usos) expect(uso).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
  })

  it('a versão do gitleaks é a mesma de GITLEAKS_VERSION no ci.yml do GitOrch', () => {
    const doCi = /GITLEAKS_VERSION:\s*(\S+)/.exec(CI_DO_GITORCH)?.[1]
    expect(doCi).toBeDefined()
    expect(GITLEAKS_VERSION).toBe(doCi)
    expect(yaml).toContain(`GITLEAKS_VERSION: ${doCi}`)
  })

  it('o commit do actions/checkout é o mesmo que o ci.yml do GitOrch já usa fixado', () => {
    expect(CI_DO_GITORCH).toContain(`actions/checkout@${ACTION_CHECKOUT_SHA}`)
  })

  it('o token do workflow só lê', () => {
    expect(yaml).toMatch(/^permissions:\n {2}contents: read$/m)
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
