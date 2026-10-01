import { afterEach, describe, expect, it } from 'vitest'
import { baseDoDev, branchPadraoDoRepositorio } from './base-do-dev.js'

const ORIGINAL = process.env['GITORCH_DEV_BASE_BRANCH']

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['GITORCH_DEV_BASE_BRANCH']
  else process.env['GITORCH_DEV_BASE_BRANCH'] = ORIGINAL
})

describe('baseDoDev', () => {
  it('padrão main; GITORCH_DEV_BASE_BRANCH manda quando existe', () => {
    delete process.env['GITORCH_DEV_BASE_BRANCH']
    expect(baseDoDev()).toBe('main')
    process.env['GITORCH_DEV_BASE_BRANCH'] = 'develop'
    expect(baseDoDev()).toBe('develop')
  })
})

describe('branchPadraoDoRepositorio', () => {
  it('usa o default_branch que o GitHub devolve', async () => {
    expect(await branchPadraoDoRepositorio(async () => ({ default_branch: 'master' }))).toBe(
      'master'
    )
  })

  it('sem default_branch ou com falha de leitura → cai na base do dev (nunca lança)', async () => {
    delete process.env['GITORCH_DEV_BASE_BRANCH']
    expect(await branchPadraoDoRepositorio(async () => ({}))).toBe('main')
    expect(await branchPadraoDoRepositorio(async () => null)).toBe('main')
    const avisos: string[] = []
    expect(
      await branchPadraoDoRepositorio(
        async () => {
          throw new Error('rede')
        },
        (m) => avisos.push(m)
      )
    ).toBe('main')
    expect(avisos[0]).toContain('rede')
  })
})
