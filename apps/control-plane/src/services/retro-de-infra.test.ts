import { describe, it, expect } from 'vitest'
import { montarPromptDoRetro, runRetroDeInfra, type EntradaDoRetro } from './retro-de-infra.js'

const entrada: EntradaDoRetro = {
  issueNumber: 24,
  tituloDaIssue: 'Dependabot → Jules falhando com npm ci',
  corpoDaIssue: 'O workflow dependabot-to-jules.yml roda `npm ci` em .github/scripts...',
  briefDoRa: 'Causa raiz: .github/scripts virou pnpm, só tem pnpm-lock.yaml.',
  prsFracassados: [
    { numero: 101, motivo: 'ci-vermelho', evidencia: 'npm ERR! lockfile not found' },
    { numero: 108, motivo: 'ci-vermelho', evidencia: 'npm ERR! lockfile not found' },
    { numero: 115, motivo: 'fechado-sem-merge', evidencia: 'conflito de merge' },
  ],
}

const RESP = {
  raizDoRetrabalho: 'po-issue-incompleta',
  ajusteRecomendado: 'a issue deve citar o bloco pnpm equivalente de ci.yml a copiar',
  regraDeCodingParaODev:
    'nunca misture troca de gerenciador de pacote com outra mudança no mesmo PR',
  padraoParaMemoria: 'Jules repete o erro quando a issue não aponta o exemplo a copiar',
}

describe('montarPromptDoRetro', () => {
  it('inclui a issue, o brief do RA e os 3 PRs', () => {
    const blocos = montarPromptDoRetro(entrada).join('\n')
    expect(blocos).toContain('#24')
    expect(blocos).toContain('pnpm-lock')
    expect(blocos).toContain('PR #101')
    expect(blocos).toContain('PR #115')
  })
})

describe('runRetroDeInfra', () => {
  it('devolve raiz + ajuste + regra de coding + padrão', async () => {
    const r = await runRetroDeInfra(async () => JSON.stringify(RESP), entrada)
    expect(r.raizDoRetrabalho).toBe('po-issue-incompleta')
    expect(r.regraDeCodingParaODev).toContain('gerenciador de pacote')
    expect(r.padraoParaMemoria).toBeTruthy()
  })

  it('rejeita raiz fora do enum', async () => {
    await expect(
      runRetroDeInfra(
        async () => JSON.stringify({ ...RESP, raizDoRetrabalho: 'culpa-do-jules' }),
        entrada
      )
    ).rejects.toThrow()
  })
})
