import { describe, it, expect, vi } from 'vitest'
import { calcularExigeRevisaoDeSeguranca } from './exigir-revisao-de-seguranca.js'

describe('calcularExigeRevisaoDeSeguranca', () => {
  const baseDeps = {
    wingId: 'dono/repo',
    onWarn: vi.fn(),
  }

  it('guarda liga/desliga: retorna false se o plano já permite (desliga guarda)', async () => {
    const ghGet = vi.fn()
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: true,
      ghGet,
    })
    expect(result).toBe(false)
    expect(ghGet).not.toHaveBeenCalled() // short-circuit
  })

  it('retorna true (liga guarda) se plano não permite e não existe workflow com gitleaks', async () => {
    const ghGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('.github/workflows')) {
        return [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }]
      }
      if (path.endsWith('ci.yml')) {
        return { content: Buffer.from('sem nenhuma ferramenta de seguranca').toString('base64') }
      }
      return []
    })
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
    })
    expect(result).toBe(true)
  })

  it('retorna true (liga guarda) se diretório .github/workflows não existe (404)', async () => {
    const ghGet = vi.fn().mockRejectedValue(new Error('404 Not Found'))
    const onWarn = vi.fn()
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
      onWarn,
    })
    expect(result).toBe(true)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('retorna false (desliga guarda) se plano não permite mas existe workflow com gitleaks', async () => {
    const ghGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('.github/workflows')) {
        return [
          { name: 'ci.yml', path: '.github/workflows/ci.yml' },
          { name: 'outro.yml', path: '.github/workflows/outro.yml' },
        ]
      }
      if (path.endsWith('ci.yml')) {
        return { content: Buffer.from('echo test').toString('base64') }
      }
      if (path.endsWith('outro.yml')) {
        return {
          content: Buffer.from('uses: gitleaks/action@v1\nrun: gitleaks detect').toString('base64'),
        }
      }
      return []
    })
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
    })
    expect(result).toBe(false)
  })

  it('dado desconhecido não exige: erro de rede ao listar diretório retorna false e loga warn', async () => {
    const ghGet = vi.fn().mockRejectedValue(new Error('500 Internal Server Error'))
    const onWarn = vi.fn()
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
      onWarn,
    })
    expect(result).toBe(false)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('500 Internal Server Error'))
  })

  it('dado desconhecido não exige: retorno inesperado ao listar diretório retorna false e loga warn', async () => {
    const ghGet = vi.fn().mockResolvedValue({ notAnArray: true })
    const onWarn = vi.fn()
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
      onWarn,
    })
    expect(result).toBe(false)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('não é array'))
  })

  it('dado desconhecido não exige: erro de rede ao ler conteúdo de arquivo retorna false e loga warn', async () => {
    const ghGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('.github/workflows')) {
        return [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }]
      }
      throw new Error('ECONNRESET')
    })
    const onWarn = vi.fn()
    const result = await calcularExigeRevisaoDeSeguranca({
      ...baseDeps,
      planoPermite: false,
      ghGet,
      onWarn,
    })
    expect(result).toBe(false)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'))
  })
})
