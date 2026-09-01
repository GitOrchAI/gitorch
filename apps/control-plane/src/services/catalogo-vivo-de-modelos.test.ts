import { describe, it, expect } from 'vitest'
import {
  nomeDeExibicaoDoModelo,
  escolherModeloVivo,
  atualizarModelosIndisponiveis,
} from './catalogo-vivo-de-modelos.js'

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

  it('nome de OUTRO motor: roda sem --model (o motor usa o dele) e DIZ', () => {
    // Não inventa substituto de outra família — mas também não desiste do
    // degrau. Um nome cuja MARCA não aparece em lugar nenhum deste catálogo
    // nunca foi modelo deste motor: mandar o motor rodar com o modelo padrão
    // DELE entrega trabalho; pular o degrau não entrega nada.
    const r = escolherModeloVivo({ desejado: 'Modelo Que Nao Existe', catalogo: CATALOGO_VIVO })
    expect(r.veredito).toBe('de-outro-motor')
    expect(r.modelo).toBeUndefined()
    expect(r.trocado).toBe(false)
    expect(r.aviso).toContain('Modelo Que Nao Existe')
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

describe('escolherModeloVivo — o veredito que decide se o degrau vale a tentativa', () => {
  // MEDIDO AO VIVO em 01/09/2026, nesta VM, com a credencial real do dono:
  //   $ claude --model "Gemini 3.7 Flash (Medium)" -p "say ok"
  //   "Gemini 3.7 Flash (Medium)" is not a model this version of Claude Code
  //   recognizes ... There's an issue with the selected model (Gemini 3.7 Flash
  //   (Medium)). It may not exist or you may not have access to it.
  // E o resolvedor ENTREGA esse nome ao degrau do claude — provado rodando
  // resolveRuntimeChain('ra', null, defaults, ['antigravity','claude','codex']):
  // os TRÊS degraus vinham com 'Gemini 3.7 Flash (Medium)'. O catálogo do
  // claude no banco tem 10 modelos, nenhum deles Gemini.
  const CATALOGO_DO_CLAUDE = [
    'Claude Opus 5',
    'Claude Sonnet 5',
    'Claude Fable 5',
    'Claude Opus 4.8',
    'Claude Haiku 4.5',
  ]

  it('o modelo do Antigravity no degrau do Claude NÃO mata o degrau — tira o --model', () => {
    const r = escolherModeloVivo({
      desejado: 'Gemini 3.7 Flash (Medium)',
      catalogo: CATALOGO_DO_CLAUDE,
    })
    expect(r.veredito).toBe('de-outro-motor')
    expect(r.modelo).toBeUndefined()
    expect(r.aviso).toContain('Gemini 3.7 Flash (Medium)')
  })

  it('modelo que SAIU do catálogo do próprio motor, sem equivalente: o degrau não vale a tentativa', () => {
    // A marca `gemini` ESTÁ neste catálogo — é modelo deste motor mesmo. Só que
    // este esforço não existe mais e não há geração nova com ele. Rodar assim é
    // pagar um container inteiro para receber `invalid model selection`.
    const r = escolherModeloVivo({
      desejado: 'Gemini 3.5 Flash (Ultra)',
      catalogo: CATALOGO_VIVO,
    })
    expect(r.veredito).toBe('saiu-do-catalogo')
    expect(r.aviso).toContain('Gemini 3.5 Flash (Ultra)')
  })

  it('nome de outro motor que o catálogo do motor TEM: vale, sem drama', () => {
    // O catálogo do Antigravity de verdade lista `Claude Opus 4.6 (Thinking)`.
    const r = escolherModeloVivo({
      desejado: 'Claude Opus 4.6 (Thinking)',
      catalogo: CATALOGO_VIVO,
    })
    expect(r.veredito).toBe('vale')
    expect(r.modelo).toBe('Claude Opus 4.6 (Thinking)')
  })

  it('FAIL-OPEN: catálogo vazio dá veredito "vale" — nunca "saiu-do-catalogo"', () => {
    // Lista vazia é "não sei". Um veredito de ausência aqui pularia TODOS os
    // degraus toda vez que a leitura do banco piscasse — trocar desperdício por
    // paralisação é exatamente o que este produto não faz.
    const r = escolherModeloVivo({ desejado: 'Gemini 3.5 Flash (Medium)', catalogo: [] })
    expect(r.veredito).toBe('vale')
    expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
  })

  it('substituição continua ganhando de pular: 3.5 vira 3.7 e o degrau roda', () => {
    const r = escolherModeloVivo({ desejado: 'Gemini 3.5 Flash (Medium)', catalogo: CATALOGO_VIVO })
    expect(r.veredito).toBe('trocado')
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
  })
})

describe('atualizarModelosIndisponiveis — o modelo que sumiu fica MARCADO, não apagado', () => {
  const AGORA = new Date('2026-09-01T12:00:00.000Z')

  it('modelo que saiu do catálogo entra na lista de indisponíveis com a data', () => {
    const r = atualizarModelosIndisponiveis({
      anterior: ['Gemini 3.5 Flash (Medium)', 'Gemini 3.7 Flash (Medium)'],
      atual: ['Gemini 3.7 Flash (Medium)'],
      indisponiveis: [],
      agora: AGORA,
    })
    expect(r).toEqual([{ nome: 'Gemini 3.5 Flash (Medium)', sumiuEm: AGORA.toISOString() }])
  })

  it('a data de quando sumiu NÃO é reescrita na coleta seguinte', () => {
    // Quem escolheu o modelo precisa saber HÁ QUANTO TEMPO ele saiu. Carimbar
    // de novo a cada coleta faria toda ausência parecer de agora.
    const jaMarcado = [{ nome: 'Gemini 3.5 Flash (Medium)', sumiuEm: '2026-08-31T23:00:00.000Z' }]
    const r = atualizarModelosIndisponiveis({
      anterior: ['Gemini 3.7 Flash (Medium)'],
      atual: ['Gemini 3.7 Flash (Medium)'],
      indisponiveis: jaMarcado,
      agora: AGORA,
    })
    expect(r).toEqual(jaMarcado)
  })

  it('modelo que VOLTOU sai da lista de indisponíveis', () => {
    const r = atualizarModelosIndisponiveis({
      anterior: ['Gemini 3.7 Flash (Medium)'],
      atual: ['Gemini 3.7 Flash (Medium)', 'Gemini 3.5 Flash (Medium)'],
      indisponiveis: [{ nome: 'Gemini 3.5 Flash (Medium)', sumiuEm: '2026-08-31T23:00:00.000Z' }],
      agora: AGORA,
    })
    expect(r).toEqual([])
  })

  it('catálogo anterior COLADO não faz o modelo parecer que sumiu', () => {
    // As linhas antigas do banco vinham `slug<TAB>Nome`. Comparar cru marcaria
    // os 14 modelos como sumidos na primeira coleta nova.
    const r = atualizarModelosIndisponiveis({
      anterior: ['gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'],
      atual: ['Gemini 3.7 Flash (Medium)'],
      indisponiveis: [],
      agora: AGORA,
    })
    expect(r).toEqual([])
  })

  it('lista de indisponíveis com forma estranha no banco não quebra nem inventa', () => {
    const r = atualizarModelosIndisponiveis({
      anterior: ['A', 'B'],
      atual: ['A'],
      indisponiveis: [{ nao: 'é isso' }, null, 'texto', { nome: 'B' }] as never,
      agora: AGORA,
    })
    expect(r).toEqual([{ nome: 'B', sumiuEm: AGORA.toISOString() }])
  })
})
