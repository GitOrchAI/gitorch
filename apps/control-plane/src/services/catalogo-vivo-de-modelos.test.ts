import { describe, it, expect } from 'vitest'
import { nomeDeExibicaoDoModelo, escolherModeloVivo } from './catalogo-vivo-de-modelos.js'

// A LISTA REAL, copiada da saída de `agy models` nesta VM em 31/08/2026
// (`cat -A` para ver o TAB): cada linha é `slug<TAB>Nome de Exibição`.
// O `--model` do agy aceita o NOME DE EXIBIÇÃO — provado ao vivo no mesmo dia:
//   agy --model "Gemini 3.5 Flash (Medium)" -p "say ok"
//   Error: invalid model selection ... Available models: Gemini 3.7 Flash (High) ...
const SAIDA_REAL_DO_AGY = [
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
]

const CATALOGO_VIVO = SAIDA_REAL_DO_AGY.map(nomeDeExibicaoDoModelo)

describe('nomeDeExibicaoDoModelo — o TAB do `agy models` separa slug de nome', () => {
  it('fica com o NOME DE EXIBIÇÃO, que é o que o --model aceita', () => {
    expect(nomeDeExibicaoDoModelo('gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)')).toBe(
      'Gemini 3.7 Flash (Medium)'
    )
  })

  it('a string COLADA que o banco guardava hoje nunca serviria como --model', () => {
    // Medido no banco em 31/08: engine_connections.models do antigravity tinha
    // 14 entradas, todas no formato colado. Um catálogo assim não valida nada.
    const colado = 'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'
    expect(nomeDeExibicaoDoModelo(colado)).not.toContain('\t')
    expect(nomeDeExibicaoDoModelo(colado)).not.toContain('gemini-3.7-flash-medium')
  })

  it('linha sem TAB passa inteira — Claude e Codex já entregam só o nome', () => {
    expect(nomeDeExibicaoDoModelo('  GPT-5.5  ')).toBe('GPT-5.5')
  })
})

describe('escolherModeloVivo — o produto PERCEBE que o modelo morreu e DIZ', () => {
  it('o modelo morto de hoje vira o substituto certo, e o produto avisa', () => {
    // Este é o defeito real: MODEL_FLASH valia 'Gemini 3.5 Flash (Medium)' e o
    // Google removeu a geração 3.5 no meio do dia 31/08.
    const r = escolherModeloVivo({
      desejado: 'Gemini 3.5 Flash (Medium)',
      catalogo: CATALOGO_VIVO,
    })
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
    expect(r.trocado).toBe(true)
    expect(r.aviso).toContain('Gemini 3.5 Flash (Medium)')
    expect(r.aviso).toContain('Gemini 3.7 Flash (Medium)')
  })

  it('casa FAMÍLIA e ESFORÇO, não só o nome mais novo da lista', () => {
    // O produto escolheu Flash+Medium de propósito para ra/sm/qa. Um substituto
    // que troca o esforço muda o comportamento do agente pelas costas.
    expect(
      escolherModeloVivo({ desejado: 'Gemini 3.5 Flash (Low)', catalogo: CATALOGO_VIVO }).modelo
    ).toBe('Gemini 3.7 Flash (Low)')
    expect(
      escolherModeloVivo({ desejado: 'Gemini 3.5 Flash (High)', catalogo: CATALOGO_VIVO }).modelo
    ).toBe('Gemini 3.7 Flash (High)')
  })

  it('pega a geração MAIS NOVA da família — a mais velha é a próxima a cair', () => {
    // 3.6 e 3.7 Flash (Medium) existiam os dois. O 3.5 morreu em menos de 7h;
    // o provedor mantém duas gerações e derruba a mais velha sem avisar.
    const r = escolherModeloVivo({ desejado: 'Gemini 3.4 Flash (Medium)', catalogo: CATALOGO_VIVO })
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
  })

  it('modelo VIVO passa intacto e sem aviso — a guarda não mexe no que funciona', () => {
    const r = escolherModeloVivo({
      desejado: 'Gemini 3.1 Pro (Low)',
      catalogo: CATALOGO_VIVO,
    })
    expect(r.modelo).toBe('Gemini 3.1 Pro (Low)')
    expect(r.trocado).toBe(false)
    expect(r.aviso).toBeUndefined()
  })

  it('FAIL-OPEN: catálogo vazio NÃO troca nem bloqueia nada', () => {
    // Catálogo vazio quer dizer "não sei", nunca "o modelo não existe". Se a
    // guarda desligasse o motor por não ter lista, ela derrubaria a esteira
    // toda vez que a leitura do banco falhasse.
    const r = escolherModeloVivo({ desejado: 'Gemini 3.5 Flash (Medium)', catalogo: [] })
    expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
    expect(r.trocado).toBe(false)
    expect(r.aviso).toBeUndefined()
  })

  it('modelo ausente SEM substituto possível: mantém o desejado, mas DIZ', () => {
    // Não inventa substituto de outra família. Mas também não repete a falha
    // em silêncio: o motivo fica no aviso para o dono agir.
    const r = escolherModeloVivo({ desejado: 'Modelo Que Nao Existe', catalogo: CATALOGO_VIVO })
    expect(r.modelo).toBe('Modelo Que Nao Existe')
    expect(r.trocado).toBe(false)
    expect(r.aviso).toContain('Modelo Que Nao Existe')
    expect(r.aviso).toMatch(/não est|nao est/i)
  })

  it('o catálogo ainda COLADO do banco não engana a guarda', () => {
    // Enquanto a coleta antiga não for refeita, o banco segue com as strings
    // coladas. Normalizar na entrada evita a guarda concluir "3.7 não existe"
    // e trocar um modelo bom por outro.
    const r = escolherModeloVivo({
      desejado: 'Gemini 3.7 Flash (Medium)',
      catalogo: SAIDA_REAL_DO_AGY,
    })
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
    expect(r.trocado).toBe(false)
  })
})
