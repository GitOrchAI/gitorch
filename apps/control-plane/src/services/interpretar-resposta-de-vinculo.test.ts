import { describe, expect, it } from 'vitest'
import { interpretarRespostaDeVinculo } from './interpretar-resposta-de-vinculo.js'

const REPO = 'acme/api'

describe('interpretarRespostaDeVinculo: número de tarefa', () => {
  it.each([
    ['#3976', 3976],
    ['3976', 3976],
    ['  3976  ', 3976],
    ['é a 3976', 3976],
    ['E A 3976', 3976],
    ['é o #3976', 3976],
    ['tarefa 3976', 3976],
    ['Tarefa nº 3976', 3976],
    ['issue 3976', 3976],
    ['a tarefa #3976, por favor', 3976],
    ['3976.', 3976],
    ['3976!', 3976],
    ['3976 👍', 3976],
    ['é a 3976, obrigado', 3976],
    ['#3976 #3976', 3976],
    ['é a 3976 (https://github.com/acme/api/issues/3976)', 3976],
  ])('%j vira a tarefa %i', (texto, numero) => {
    expect(interpretarRespostaDeVinculo(texto, REPO)).toEqual({ tipo: 'tarefa', numero })
  })

  it('link da tarefa do próprio projeto vale, sem importar maiúsculas nem parâmetros', () => {
    for (const link of [
      'https://github.com/acme/api/issues/3976',
      'https://github.com/Acme/API/issues/3976',
      'https://www.github.com/acme/api/issues/3976?foo=bar#issuecomment-1',
      'olha: https://github.com/acme/api/issues/3976/ valeu',
    ]) {
      expect(interpretarRespostaDeVinculo(link, REPO)).toEqual({ tipo: 'tarefa', numero: 3976 })
    }
  })

  it('link de outro repositório não é entendido e diz qual repositório', () => {
    expect(interpretarRespostaDeVinculo('https://github.com/acme/outro/issues/3976', REPO)).toEqual(
      { tipo: 'outro-repositorio', repositorio: 'acme/outro' }
    )
  })

  it('link de outro site com número não vira tarefa', () => {
    expect(interpretarRespostaDeVinculo('https://exemplo.com/acme/api/issues/3976', REPO)).toEqual({
      tipo: 'nao-entendida',
    })
  })

  it('dois ou mais números diferentes pedem para escolher uma só, citando os que vieram', () => {
    expect(interpretarRespostaDeVinculo('3976 e 4010', REPO)).toEqual({
      tipo: 'varias',
      numeros: [3976, 4010],
    })
    expect(interpretarRespostaDeVinculo('#12, #7 ou #12', REPO)).toEqual({
      tipo: 'varias',
      numeros: [12, 7],
    })
  })

  it('número que é outra coisa (dinheiro, horário, data, porcentagem, decimal) não vira tarefa', () => {
    for (const texto of [
      'custa R$ 500',
      'foi 500 reais',
      'às 14h',
      'às 14:30',
      '15/10/2030',
      'em 2030',
      'ano de 2030',
      '50%',
      '3,5 horas',
      '1.500,00',
    ]) {
      expect(interpretarRespostaDeVinculo(texto, REPO)).toEqual({ tipo: 'nao-entendida' })
    }
  })

  it('número solto que parece ano mas veio como resposta vale como tarefa', () => {
    expect(interpretarRespostaDeVinculo('2030', REPO)).toEqual({ tipo: 'tarefa', numero: 2030 })
    expect(interpretarRespostaDeVinculo('#2030', REPO)).toEqual({ tipo: 'tarefa', numero: 2030 })
  })

  it('um número de verdade ao lado de outro que é outra coisa fica só com o de verdade', () => {
    expect(interpretarRespostaDeVinculo('é a 3976, feita às 14h', REPO)).toEqual({
      tipo: 'tarefa',
      numero: 3976,
    })
  })

  it('zero e números enormes não viram tarefa', () => {
    expect(interpretarRespostaDeVinculo('0', REPO)).toEqual({ tipo: 'nao-entendida' })
    expect(interpretarRespostaDeVinculo('#99999999999999', REPO)).toEqual({
      tipo: 'nao-entendida',
    })
  })
})

describe('interpretarRespostaDeVinculo: "não há tarefa"', () => {
  it.each([
    'nenhuma',
    'Nenhuma.',
    'NENHUMA!',
    'nenhuma tarefa',
    'nenhuma destas',
    'não',
    'Não.',
    'nao',
    'não tem',
    'nao tem tarefa',
    'Não tem tarefa nenhuma',
    'não há tarefa',
    'é avulso',
    'é avulsa',
    'é um pedido avulso',
    'avulso',
    'sem tarefa',
    'sem tarefa nenhuma',
    'pode seguir',
    'pode seguir sem tarefa',
    'Pode seguir, obrigado',
    'nenhuma 👍',
  ])('%j quer dizer que não há tarefa', (texto) => {
    expect(interpretarRespostaDeVinculo(texto, REPO)).toEqual({ tipo: 'nenhuma' })
  })

  it('negação junto de número é ambígua e não é adivinhada', () => {
    for (const texto of ['não é a 3976', 'não tem tarefa, mas a 3976 parece', 'sem tarefa 3976']) {
      expect(interpretarRespostaDeVinculo(texto, REPO).tipo).not.toBe('nenhuma')
      expect(interpretarRespostaDeVinculo(texto, REPO).tipo).not.toBe('tarefa')
    }
  })

  it('frase que só começa com "não" não é um "nenhuma"', () => {
    for (const texto of [
      'Não sei do que se trata, pode deletar se quiser.',
      'não sei',
      'não entendi a pergunta',
    ]) {
      expect(interpretarRespostaDeVinculo(texto, REPO)).toEqual({ tipo: 'nao-entendida' })
    }
  })
})

describe('interpretarRespostaDeVinculo: conversa que não responde', () => {
  it.each(['ok', 'vi', 'depois vejo', 'beleza', '👍', '', '   ', 'qual é a diferença?'])(
    '%j não é entendida',
    (texto) => {
      expect(interpretarRespostaDeVinculo(texto, REPO)).toEqual({ tipo: 'nao-entendida' })
    }
  )
})
