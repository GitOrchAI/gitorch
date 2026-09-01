import { describe, expect, test } from 'vitest'
import {
  ESFORCOS_DO_MOTOR,
  COMO_O_MOTOR_EXPRESSA_ESFORCO,
  esforcoValidoNoMotor,
  argumentosDeEsforco,
  modeloComEsforcoNoNome,
  valorDeModeloParaOMotor,
} from './esforco-por-motor.js'

// Os valores abaixo NÃO são de doc nem de memória: cada um saiu de rodar o CLI
// real nesta VM em 01/09/2026. As saídas exatas estão no cabeçalho de
// esforco-por-motor.ts.

describe('cada motor expressa esforço do seu jeito — e um deles não expressa', () => {
  test('claude tem flag própria, com cinco níveis reais', () => {
    expect(COMO_O_MOTOR_EXPRESSA_ESFORCO.claude).toBe('flag')
    expect(ESFORCOS_DO_MOTOR.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('codex não tem flag: o esforço é uma chave de configuração', () => {
    expect(COMO_O_MOTOR_EXPRESSA_ESFORCO.codex).toBe('config')
    expect(ESFORCOS_DO_MOTOR.codex).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  test('antigravity NÃO tem esforço separável: ele vive dentro do nome do modelo', () => {
    expect(COMO_O_MOTOR_EXPRESSA_ESFORCO.antigravity).toBe('no-nome-do-modelo')
    expect(ESFORCOS_DO_MOTOR.antigravity).toEqual(['low', 'medium', 'high'])
  })

  test('esforço fora da lista do motor é recusado, não silenciado', () => {
    expect(esforcoValidoNoMotor('claude', 'max')).toBe(true)
    // 'max' existe no claude e NÃO existe no codex — a lista é por motor.
    expect(esforcoValidoNoMotor('codex', 'max')).toBe(false)
    expect(esforcoValidoNoMotor('antigravity', 'xhigh')).toBe(false)
    expect(esforcoValidoNoMotor('claude', 'bogus')).toBe(false)
  })
})

describe('o esforço vira o argumento REAL de cada CLI', () => {
  test('claude: --effort <nivel>', () => {
    expect(argumentosDeEsforco({ runtime: 'claude', esforco: 'high' }).args).toEqual([
      '--effort',
      'high',
    ])
  })

  test('codex: -c model_reasoning_effort=<nivel>, porque --effort não existe lá', () => {
    expect(argumentosDeEsforco({ runtime: 'codex', esforco: 'xhigh' }).args).toEqual([
      '-c',
      'model_reasoning_effort=xhigh',
    ])
  })

  test('antigravity com modelo fixado NUNCA recebe --effort — seria erro duro do CLI', () => {
    const r = argumentosDeEsforco({
      runtime: 'antigravity',
      esforco: 'high',
      modelo: 'Gemini 3.7 Flash (Medium)',
    })
    expect(r.args).toEqual([])
    expect(r.aviso).toMatch(/não aceita/i)
  })

  test('esforço inválido não vira argumento nenhum', () => {
    expect(argumentosDeEsforco({ runtime: 'codex', esforco: 'max' }).args).toEqual([])
    expect(argumentosDeEsforco({ runtime: 'claude', esforco: 'bogus' }).args).toEqual([])
  })

  test('sem esforço pedido, nenhum argumento e nenhum aviso', () => {
    const r = argumentosDeEsforco({ runtime: 'claude' })
    expect(r.args).toEqual([])
    expect(r.aviso).toBeUndefined()
  })
})

describe('no antigravity, escolher esforço é escolher OUTRO modelo', () => {
  // O catálogo real desta conta, lido do banco em 01/09/2026.
  const catalogo = [
    'Gemini 3.7 Flash (High)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (Low)',
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ]

  test('troca o sufixo de esforço pela variante que EXISTE no catálogo', () => {
    const r = modeloComEsforcoNoNome({
      modelo: 'Gemini 3.7 Flash (Medium)',
      esforco: 'high',
      catalogo,
    })
    expect(r.modelo).toBe('Gemini 3.7 Flash (High)')
    expect(r.trocado).toBe(true)
  })

  test('mesma geração, nunca pula para outra: 3.6 pedindo Low fica em 3.6', () => {
    const r = modeloComEsforcoNoNome({
      modelo: 'Gemini 3.6 Flash (High)',
      esforco: 'low',
      catalogo,
    })
    expect(r.modelo).toBe('Gemini 3.6 Flash (Low)')
  })

  test('variante inexistente mantém o modelo pedido e DIZ — nunca inventa', () => {
    // 'Gemini 3.1 Pro (Medium)' não existe: o catálogo real só tem High e Low.
    const r = modeloComEsforcoNoNome({
      modelo: 'Gemini 3.1 Pro (High)',
      esforco: 'medium',
      catalogo,
    })
    expect(r.modelo).toBe('Gemini 3.1 Pro (High)')
    expect(r.trocado).toBe(false)
    expect(r.aviso).toMatch(/medium/i)
  })

  test('catálogo vazio não muda nada (fail-open, igual ao resto do produto)', () => {
    const r = modeloComEsforcoNoNome({
      modelo: 'Gemini 3.7 Flash (Medium)',
      esforco: 'high',
      catalogo: [],
    })
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
    expect(r.trocado).toBe(false)
  })
})

describe('o catálogo do claude guarda nome de vitrine que o CLI RECUSA', () => {
  // Medido ao vivo em 01/09/2026 com a credencial real:
  //   claude --model "Claude Opus 5"  -> "There's an issue with the selected model"
  //   claude --model claude-opus-5    -> ok
  test('o nome de exibição do claude vira o identificador que o CLI aceita', () => {
    expect(valorDeModeloParaOMotor('claude', 'Claude Opus 5')).toBe('claude-opus-5')
    expect(valorDeModeloParaOMotor('claude', 'Claude Haiku 4.5')).toBe('claude-haiku-4-5')
    expect(valorDeModeloParaOMotor('claude', 'Claude Opus 4.8')).toBe('claude-opus-4-8')
  })

  test('quem já vem como identificador passa intacto', () => {
    expect(valorDeModeloParaOMotor('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(valorDeModeloParaOMotor('claude', 'opus')).toBe('opus')
  })

  test('antigravity passa intacto: o nome de exibição é o que o `agy` aceita', () => {
    expect(valorDeModeloParaOMotor('antigravity', 'Gemini 3.7 Flash (Medium)')).toBe(
      'Gemini 3.7 Flash (Medium)'
    )
    expect(valorDeModeloParaOMotor('antigravity', 'Claude Opus 4.6 (Thinking)')).toBe(
      'Claude Opus 4.6 (Thinking)'
    )
  })
})

describe('o catálogo do codex tem o MESMO defeito, com outra regra de conversão', () => {
  // Medido ao vivo em 01/09/2026, e o contraste é a prova:
  //   $ codex exec -m "GPT-5.5" ...
  //     ERROR: The 'GPT-5.5' model is not supported when using Codex with a
  //            ChatGPT account.                    ← morre na validação do modelo
  //   $ codex exec -m gpt-5.5 ...
  //     ERROR: You've hit your usage limit.        ← PASSOU pelo modelo
  // O segundo erro é de cota, não de modelo: o pedido chegou até o provedor.
  test('o nome de exibição do codex vira o identificador que o CLI aceita', () => {
    expect(valorDeModeloParaOMotor('codex', 'GPT-5.5')).toBe('gpt-5.5')
    expect(valorDeModeloParaOMotor('codex', 'GPT-5.4-Mini')).toBe('gpt-5.4-mini')
    expect(valorDeModeloParaOMotor('codex', 'Codex Auto Review')).toBe('codex-auto-review')
  })

  test('a regra do codex NÃO é a do claude: lá o ponto vira hífen, aqui ele fica', () => {
    // Os identificadores reais, lidos de ~/.codex/models_cache.json nesta VM:
    // `gpt-5.5` e `gpt-5.4-mini` — com o ponto preservado. Aplicar a regra do
    // claude aqui produziria `gpt-5-5`, que não existe.
    expect(valorDeModeloParaOMotor('codex', 'GPT-5.5')).not.toBe('gpt-5-5')
    expect(valorDeModeloParaOMotor('claude', 'Claude Opus 4.5')).toBe('claude-opus-4-5')
  })

  test('quem já vem como identificador passa intacto', () => {
    expect(valorDeModeloParaOMotor('codex', 'gpt-5.5')).toBe('gpt-5.5')
  })
})
