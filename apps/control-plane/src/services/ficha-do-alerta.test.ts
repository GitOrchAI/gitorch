import { describe, it, expect } from 'vitest'
import { estadoDaFichaDoAlerta, estadoDaFichaDoAlertaDoDependabot } from './ficha-do-alerta.js'
import type { AlertaDeSeguranca } from './security-debt-collector.js'

const ALERTA: AlertaDeSeguranca = {
  numero: 12,
  severidade: 'high',
  pacote: 'sharp',
  ecossistema: 'npm',
  manifesto: 'pnpm-lock.yaml',
  resumo: 'resumo',
  versaoCorrigida: '0.34.5',
  ghsa: 'GHSA-wq5f-xc86-pv6w',
  url: 'https://github.com/dono/repo/security/dependabot/12',
  criadoEm: '2026-10-01T00:00:00Z',
  escopo: 'runtime',
}

describe('estadoDaFichaDoAlerta', () => {
  it('grava pacote, GHSA, gravidade, escopo, correção e o destino decidido', () => {
    const estado = estadoDaFichaDoAlerta(ALERTA, 'open')
    expect(estado.status).toBe('open')
    expect(estado.verificacao).toBe('high')
    expect(estado.alerta).toMatchObject({
      fonte: 'dependabot',
      pacote: 'sharp',
      ecossistema: 'npm',
      ghsa: 'GHSA-wq5f-xc86-pv6w',
      gravidade: 'high',
      escopo: 'runtime',
      versaoCorrigida: '0.34.5',
      temCorrecao: true,
      destino: 'sprint-atual',
    })
    expect(estado.alerta?.motivo).toMatch(/produção/)
  })

  it('dev-only sem correção fica na ficha com o motivo de não virar tarefa', () => {
    const estado = estadoDaFichaDoAlerta(
      { ...ALERTA, escopo: 'development', versaoCorrigida: null },
      'open'
    )
    expect(estado.alerta?.destino).toBe('sem-tarefa')
    expect(estado.alerta?.temCorrecao).toBe(false)
    expect(estado.alerta?.motivo).toMatch(/desenvolvimento/)
  })
})

describe('estadoDaFichaDoAlertaDoDependabot (aviso do webhook)', () => {
  it('lê o mesmo formato do aviso e devolve a mesma ficha da varredura', () => {
    const estado = estadoDaFichaDoAlertaDoDependabot({
      number: 12,
      state: 'fixed',
      html_url: ALERTA.url,
      dependency: {
        package: { name: 'sharp', ecosystem: 'npm' },
        manifest_path: 'pnpm-lock.yaml',
        scope: 'runtime',
      },
      security_advisory: { severity: 'high', summary: 'resumo', ghsa_id: ALERTA.ghsa },
      security_vulnerability: { first_patched_version: { identifier: '0.34.5' } },
    })
    expect(estado.status).toBe('fixed')
    expect(estado.alerta).toMatchObject({ pacote: 'sharp', ghsa: ALERTA.ghsa, escopo: 'runtime' })
  })
})
