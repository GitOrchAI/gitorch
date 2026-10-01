import { describe, it, expect } from 'vitest'
import { instrucaoDePrNovoAPartirDoRamo } from './pedido-de-pr-novo.js'

describe('instrucaoDePrNovoAPartirDoRamo', () => {
  const texto = instrucaoDePrNovoAPartirDoRamo({ numeroDoPr: 154, ramoDoPr: 'jules-1084-abc' })

  it('diz onde está o trabalho antigo e como buscá-lo', () => {
    expect(texto).toContain('O trabalho anterior desta tarefa está no ramo `jules-1084-abc`')
    expect(texto).toContain('git fetch origin jules-1084-abc')
  })

  it('manda criar o ramo a partir da main, trazer só o escopo da tarefa e publicar contra a main', () => {
    expect(texto).toContain('Crie seu ramo a partir da main')
    expect(texto).toContain('APENAS o que pertence à tarefa')
    expect(texto.replace(/\n/g, ' ')).toContain(
      'publique o resultado como pull request contra a `main`'
    )
    expect(texto).toContain('Não inclua arquivos fora do escopo da tarefa.')
  })

  it('não manda mais PARTIR do ramo antigo nem empurrar para ele', () => {
    expect(texto).not.toMatch(/Parta do ramo/)
    expect(texto).not.toMatch(/para dentro dele/)
  })
})
