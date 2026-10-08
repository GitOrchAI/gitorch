import { describe, it, expect, vi } from 'vitest'
import { aplicarMelhoriaDeSeguranca } from './aplicar-melhoria-de-seguranca.js'
import {
  INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA,
  INTERRUPTOR_GERAL_DA_SEGURANCA,
  INTERRUPTOR_POR_MELHORIA,
  MELHORIAS_DE_SEGURANCA,
} from './interruptores-de-seguranca.js'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import type { ResultadoDaAplicacao } from './executores-de-seguranca.js'

const PROJETO = { id: 'cm1', wingId: 'acme/api' }
const OK: ResultadoDaAplicacao = { estado: 'aplicado', motivo: 'feito' }

function base(sobrepor: Partial<Parameters<typeof aplicarMelhoriaDeSeguranca>[0]> = {}) {
  const aplicar = vi.fn(async () => OK)
  const deps = {
    projeto: PROJETO,
    melhoria: 'alertas-de-dependencias',
    autonomia: 'cuidar',
    autonomiaDeSeguranca: 'cuidar',
    env: {},
    aplicar,
    ...sobrepor,
  } satisfies Parameters<typeof aplicarMelhoriaDeSeguranca>[0]
  return { deps, aplicar }
}

describe('aplicarMelhoriaDeSeguranca: as travas empilhadas', () => {
  it('com todas as travas abertas executa UMA vez e devolve o resultado', async () => {
    const { deps, aplicar } = base()
    const r = await aplicarMelhoriaDeSeguranca(deps)
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ executado: true, resultado: OK })
  })

  it.each([
    ['so_olhar', 'cuidar'],
    ['sugerir', 'cuidar'],
    ['cuidar', 'so_olhar'],
    ['cuidar', 'sugerir'],
    ['so_olhar', 'so_olhar'],
    [null, 'cuidar'],
    ['cuidar', null],
    [undefined, undefined],
    ['CUIDAR', 'cuidar'],
    ['talvez', 'cuidar'],
  ])('autonomia "%s" e autonomia de segurança "%s": não executa', async (autonomia, seguranca) => {
    const { deps, aplicar } = base({ autonomia, autonomiaDeSeguranca: seguranca })
    const r = await aplicarMelhoriaDeSeguranca(deps)
    expect(aplicar).not.toHaveBeenCalled()
    expect(r.executado).toBe(false)
  })

  it('a trava da autonomia geral é independente da trava de segurança (cada uma sozinha barra)', async () => {
    const a = await aplicarMelhoriaDeSeguranca(base({ autonomia: 'sugerir' }).deps)
    expect(a).toMatchObject({ executado: false, bloqueadoPor: 'autonomia' })
    const b = await aplicarMelhoriaDeSeguranca(base({ autonomiaDeSeguranca: 'sugerir' }).deps)
    expect(b).toMatchObject({ executado: false, bloqueadoPor: 'autonomia-de-seguranca' })
  })

  it('interruptor geral desligado: não executa', async () => {
    const { deps, aplicar } = base({ env: { [INTERRUPTOR_GERAL_DA_SEGURANCA]: 'off' } })
    const r = await aplicarMelhoriaDeSeguranca(deps)
    expect(aplicar).not.toHaveBeenCalled()
    expect(r).toMatchObject({ executado: false, bloqueadoPor: 'interruptor' })
  })

  it.each(MELHORIAS_DE_SEGURANCA)('o interruptor da peça "%s" barra só ela', async (peca) => {
    const env = { [INTERRUPTOR_POR_MELHORIA[peca]]: 'desligado' }
    for (const outra of MELHORIAS_DE_SEGURANCA) {
      const instancia =
        outra === 'permissoes-minimas-dos-workflows' ? `${outra}:.github/workflows/ci.yml` : outra
      const { deps, aplicar } = base({ env, melhoria: instancia })
      const r = await aplicarMelhoriaDeSeguranca(deps)
      expect(aplicar).toHaveBeenCalledTimes(outra === peca ? 0 : 1)
      expect(r.executado).toBe(outra !== peca)
    }
  })

  it('a instância "peça:caminho" obedece ao interruptor da peça-mãe', async () => {
    const env = { [INTERRUPTOR_POR_MELHORIA['permissoes-minimas-dos-workflows']]: 'off' }
    const { deps, aplicar } = base({
      env,
      melhoria: 'permissoes-minimas-dos-workflows:.github/workflows/ci.yml',
    })
    const r = await aplicarMelhoriaDeSeguranca(deps)
    expect(aplicar).not.toHaveBeenCalled()
    expect(r).toMatchObject({ bloqueadoPor: 'interruptor' })
  })

  it('projeto fora da allowlist: não executa; dentro dela, executa', async () => {
    const fora = base({ env: { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'outro/repo' } })
    const r = await aplicarMelhoriaDeSeguranca(fora.deps)
    expect(fora.aplicar).not.toHaveBeenCalled()
    expect(r).toMatchObject({ executado: false, bloqueadoPor: 'fora-da-allowlist' })

    const dentro = base({ env: { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'ACME/API' } })
    await aplicarMelhoriaDeSeguranca(dentro.deps)
    expect(dentro.aplicar).toHaveBeenCalledTimes(1)
  })

  it('LISTA BRANCA: uma melhoria que não está na lista é recusada, mesmo com todas as travas abertas', async () => {
    for (const melhoria of [
      'protecao-de-branch',
      'branch-protection',
      'apagar-repositorio',
      '',
      'alertas-de-dependencias-outra',
      'permissoes-minimas-dos-workflows',
      'permissoes-minimas-dos-workflows:',
      'permissoes-minimas-dos-workflows:src/index.ts',
      'permissoes-minimas-dos-workflows:.github/workflows/../../x.yml',
      '__proto__',
    ]) {
      const { deps, aplicar } = base({ melhoria })
      const r = await aplicarMelhoriaDeSeguranca(deps)
      expect(aplicar).not.toHaveBeenCalled()
      expect(r).toMatchObject({ executado: false, bloqueadoPor: 'fora-da-lista-branca' })
    }
  })

  it('a ordem das travas: lista branca primeiro, depois interruptor, allowlist e as duas autonomias', async () => {
    const tudo = base({
      melhoria: 'x',
      env: {
        [INTERRUPTOR_GERAL_DA_SEGURANCA]: 'off',
        [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'z',
      },
      autonomia: 'so_olhar',
      autonomiaDeSeguranca: 'so_olhar',
    })
    expect(await aplicarMelhoriaDeSeguranca(tudo.deps)).toMatchObject({
      bloqueadoPor: 'fora-da-lista-branca',
    })
    const semLista = base({
      env: {
        [INTERRUPTOR_GERAL_DA_SEGURANCA]: 'off',
        [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'z',
      },
      autonomia: 'so_olhar',
    })
    expect(await aplicarMelhoriaDeSeguranca(semLista.deps)).toMatchObject({
      bloqueadoPor: 'interruptor',
    })
  })

  it('a decisão da trava é lida na hora: o nível vem do que se passa, sem memória entre chamadas', async () => {
    const { deps, aplicar } = base()
    await aplicarMelhoriaDeSeguranca(deps)
    await aplicarMelhoriaDeSeguranca({ ...deps, autonomia: 'sugerir' })
    await aplicarMelhoriaDeSeguranca(deps)
    expect(aplicar).toHaveBeenCalledTimes(2)
  })

  it('o que a execução lança não escapa: vira "falhou" sem credencial no texto', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const aplicar = vi.fn(async () => {
      throw new Error(`rede caiu com Authorization: Bearer ${token}`)
    })
    const r = await aplicarMelhoriaDeSeguranca(base({ aplicar }).deps)
    expect(r.executado).toBe(true)
    if (r.executado) {
      expect(r.resultado.estado).toBe('falhou')
      expect(r.resultado.motivo).not.toContain(token)
      expect(r.resultado.motivo.length).toBeGreaterThan(0)
    }
  })

  // A guarda de autonomia (na saída de rede) recusou: nada saiu para o GitHub.
  // Não é falha de rede nem "incerto": é uma recusa, e o motivo é o dela.
  it('a recusa da guarda de autonomia na saída de rede vira "recusado" com o motivo, nunca "incerto"', async () => {
    const aplicar = vi.fn(async () => {
      throw new EscritaNaoAutorizadaError(
        'mesclar',
        'sugerir',
        'cuidar',
        'o projeto está em "sugerir"; escrever pede "cuidar"'
      )
    })
    const r = await aplicarMelhoriaDeSeguranca(base({ aplicar }).deps)
    expect(r.executado).toBe(true)
    if (r.executado) {
      expect(r.resultado.estado).toBe('recusado')
      expect(r.resultado.motivo).toContain('autonomia')
      expect(r.resultado.motivo).toContain('sugerir')
    }
  })

  it('o que a execução lança e não é Error também vira "falhou"', async () => {
    const aplicar = vi.fn(async () => {
      throw undefined
    })
    const r = await aplicarMelhoriaDeSeguranca(base({ aplicar }).deps)
    expect(r.executado).toBe(true)
    if (r.executado) expect(r.resultado.estado).toBe('falhou')
  })
})
