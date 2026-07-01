import { describe, it, expect } from 'vitest'
import { extractRelevantLogSections } from './log-extraction.js'

describe('extractRelevantLogSections', () => {
  it('inclui a linha de erro mesmo quando esta longe do inicio (caso real do #189)', () => {
    const noise = Array.from({ length: 400 }, (_, i) => `postgres boot noise linha ${i}`).join('\n')
    const logText =
      noise + '\n##[error]  166:3  error  Replace `}` with `··}⏎··`  prettier/prettier\n' + noise

    // Corte ingenuo (primeiros 8000 chars) NAO pegaria o erro (esta apos ~400 linhas de ruido).
    expect(logText.substring(0, 8000)).not.toContain('prettier/prettier')

    const extracted = extractRelevantLogSections(logText, 9000)
    expect(extracted).toContain('prettier/prettier')
  })

  it('inclui o final do log mesmo sem marcador ##[error]', () => {
    const logText = Array.from({ length: 100 }, (_, i) => `linha ${i}`).join('\n')
    const extracted = extractRelevantLogSections(logText, 9000)
    expect(extracted).toContain('linha 99')
  })

  it('trunca preferindo o final quando o conteudo relevante excede o limite', () => {
    const bigError = '##[error] ' + 'x'.repeat(20000)
    const extracted = extractRelevantLogSections(bigError, 100)
    expect(extracted.length).toBeLessThanOrEqual(120)
  })

  it('log vazio retorna vazio', () => {
    expect(extractRelevantLogSections('', 9000)).toBe('')
  })

  it('inclui contexto ao redor da linha de erro (nao so a linha isolada)', () => {
    const before = Array.from({ length: 300 }, (_, i) => `setup ${i}`).join('\n')
    const logText = `${before}\ncomando executado\n##[error] falha no teste X\nstack trace linha 1\n`
    const extracted = extractRelevantLogSections(logText, 9000)
    expect(extracted).toContain('comando executado')
    expect(extracted).toContain('stack trace linha 1')
  })
})
