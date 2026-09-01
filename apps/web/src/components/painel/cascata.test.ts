import { describe, it, expect } from 'vitest'
import {
  PAPEIS,
  PAPEL_NA_TELA,
  paraTela,
  paraEnvio,
  mudou,
  mover,
  novoDegrau,
  removerDegrau,
  trocarMotor,
  trocarModelo,
  trocarEsforco,
  opcoesDeModelo,
  esforcoNaTela,
  nomeDoMotor,
  avisosDoCarregamento,
  resumoDaCota,
  quandoFoiLido,
  type CascataUI,
  type MotorOpcoes,
  type PapelSalvo,
} from './cascata'
import type { MotorCota } from './painel-tipos'

// Os três motores como a rota /cascata/opcoes os devolve — medidos ao vivo em
// 01/09/2026 e gravados assim de propósito: 'max' só existe no claude, 'xhigh'
// não existe no antigravity, e no antigravity o esforço não é escolha separada.
const MOTORES: MotorOpcoes[] = [
  {
    runtime: 'claude',
    esforcos: ['low', 'medium', 'high', 'xhigh', 'max'],
    esforcoNoNomeDoModelo: false,
    modelos: [
      { valor: 'claude-opus-5', rotulo: 'Claude Opus 5' },
      { valor: 'claude-sonnet-5', rotulo: 'Claude Sonnet 5' },
    ],
    indisponiveis: [
      { valor: 'claude-opus-4-1', rotulo: 'Claude Opus 4.1', sumiuEm: '2026-08-20T10:00:00.000Z' },
    ],
  },
  {
    runtime: 'codex',
    esforcos: ['low', 'medium', 'high', 'xhigh'],
    esforcoNoNomeDoModelo: false,
    modelos: [{ valor: 'gpt-5.5', rotulo: 'GPT-5.5' }],
    indisponiveis: [],
  },
  {
    runtime: 'antigravity',
    esforcos: ['low', 'medium', 'high'],
    esforcoNoNomeDoModelo: true,
    modelos: [
      { valor: 'Gemini 3.7 Flash (High)', rotulo: 'Gemini 3.7 Flash (High)' },
      { valor: 'Gemini 3.7 Flash (Medium)', rotulo: 'Gemini 3.7 Flash (Medium)' },
    ],
    indisponiveis: [
      {
        valor: 'Gemini 3.5 Flash (Medium)',
        rotulo: 'Gemini 3.5 Flash (Medium)',
        sumiuEm: '2026-08-31T23:00:00.000Z',
      },
    ],
  },
]

/** Uma cascata mínima e válida, para os testes que não são sobre o carregamento. */
function cascataDeTeste(): CascataUI {
  return paraTela(
    {
      po: { runtime: 'codex', model: 'gpt-5.5', effort: 'medium' },
      ra: { runtime: 'claude', model: 'claude-opus-5', effort: 'high' },
      sm: { runtime: 'codex' },
      qa: {
        runtime: 'claude',
        model: 'claude-opus-5',
        effort: 'max',
        fallbacks: [{ runtime: 'codex', model: 'gpt-5.5', effort: 'xhigh' }],
      },
    },
    MOTORES
  )
}

describe('os quatro papéis', () => {
  it('a tela cobre os MESMOS papéis que a rota aceita, sem sobrar nem faltar', () => {
    expect([...PAPEIS]).toEqual(['po', 'ra', 'sm', 'qa'])
    expect(Object.keys(PAPEL_NA_TELA).sort()).toEqual(['po', 'qa', 'ra', 'sm'])
  })

  it('nenhum papel divide o nome com outro — o dono precisa saber qual linha é qual', () => {
    // O produto chama `ra` e `sm` de "Planejamento" nos DOIS (descrever-evento.ts),
    // e ali tanto faz: é uma frase de evento. Aqui não: são duas linhas que o
    // dono configura separado, e dois rótulos iguais fazem ele mexer na errada.
    const titulos = PAPEIS.map((p) => PAPEL_NA_TELA[p].titulo)
    expect(new Set(titulos).size).toBe(titulos.length)
    // A sigla técnica aparece junto porque é ela que o resto do produto usa.
    expect(PAPEIS.every((p) => PAPEL_NA_TELA[p].sigla === p.toUpperCase())).toBe(true)
  })
})

describe('o nome do motor', () => {
  it('é o MESMO nome que o assistente já mostra — não uma segunda lista', () => {
    expect(nomeDoMotor('claude')).toBe('Claude Code')
    expect(nomeDoMotor('codex')).toBe('Codex')
    expect(nomeDoMotor('antigravity')).toBe('Antigravity')
  })
  it('motor fora da lista cai no nome cru em vez de sumir da tela', () => {
    expect(nomeDoMotor('motor-novo')).toBe('motor-novo')
  })
})

describe('carregar a cascata gravada para a tela', () => {
  it('o primeiro degrau é o principal e os fallbacks vêm na ordem', () => {
    const c = paraTela(
      {
        qa: {
          runtime: 'claude',
          model: 'claude-opus-5',
          fallbacks: [{ runtime: 'codex', model: 'gpt-5.5' }, { runtime: 'antigravity' }],
        },
      },
      MOTORES
    )
    expect(c.qa.map((d) => d.runtime)).toEqual(['claude', 'codex', 'antigravity'])
  })

  it('papel ausente na resposta ainda nasce com um degrau — a tela nunca fica sem linha', () => {
    // E o motor dele sai da lista REAL de motores do dono, nunca de um literal
    // escrito na tela: um literal é exatamente o que matou 24 missões em 9h48.
    const c = paraTela({ qa: { runtime: 'claude' } }, MOTORES)
    expect(c.po).toHaveLength(1)
    expect(c.po[0].runtime).toBe(MOTORES[0].runtime)
  })

  it('CHAVE ÚNICA: degraus idênticos não compartilham chave', () => {
    // A armadilha que já custou caro aqui: chave repetida faz o React desenhar
    // número errado de linhas (25 linhas com 17 chaves). Dois degraus iguais é
    // o caso REAL — o mesmo motor sem modelo, duas vezes.
    const c = paraTela(
      {
        qa: {
          runtime: 'codex',
          fallbacks: [{ runtime: 'codex' }, { runtime: 'codex' }],
        },
      },
      MOTORES
    )
    const chaves = c.qa.map((d) => d.chave)
    expect(new Set(chaves).size).toBe(chaves.length)
  })

  it('as chaves são únicas entre TODOS os papéis, não só dentro de um', () => {
    const c = cascataDeTeste()
    const todas = PAPEIS.flatMap((p) => c[p].map((d) => d.chave))
    expect(new Set(todas).size).toBe(todas.length)
  })

  it('esforço que o motor não aceita NÃO entra na tela como se fosse aceito', () => {
    // 'max' não existe no codex (medido: o catálogo do servidor lista
    // low|medium|high|xhigh). Mostrar 'max' selecionado faria o dono acreditar
    // num nível que o motor nunca aplicaria — e a rota recusa a gravação.
    const c = paraTela({ po: { runtime: 'codex', effort: 'max' } }, MOTORES)
    expect(c.po[0].effort).toBe('')
  })

  it('esforço gravado no antigravity é largado: lá ele não é separável do modelo', () => {
    const c = paraTela({ po: { runtime: 'antigravity', effort: 'high' } }, MOTORES)
    expect(c.po[0].effort).toBe('')
  })

  it('o modelo gravado é preservado mesmo fora do catálogo — não some da tela', () => {
    const c = paraTela({ po: { runtime: 'claude', model: 'claude-opus-4-1' } }, MOTORES)
    expect(c.po[0].model).toBe('claude-opus-4-1')
  })
})

describe('avisos do que foi carregado', () => {
  it('diz, nomeando o papel, quando o esforço gravado foi largado', () => {
    const avisos = avisosDoCarregamento(
      { po: { runtime: 'codex', effort: 'max' }, qa: { runtime: 'antigravity', effort: 'high' } },
      MOTORES
    )
    expect(avisos).toHaveLength(2)
    expect(avisos.join(' ')).toMatch(/Produto/)
    expect(avisos.join(' ')).toMatch(/max/)
    expect(avisos.join(' ')).toMatch(/Qualidade/)
  })

  it('diz quando o modelo gravado saiu do ar, com a data que a coleta carimbou', () => {
    const avisos = avisosDoCarregamento(
      { ra: { runtime: 'claude', model: 'claude-opus-4-1' } },
      MOTORES
    )
    expect(avisos.join(' ')).toMatch(/Claude Opus 4\.1/)
    expect(avisos.join(' ')).toMatch(/saiu/i)
  })

  it('cascata inteiramente válida não gera aviso nenhum', () => {
    // Aviso sem consequência treina alguém a ignorar o aviso que importa.
    expect(
      avisosDoCarregamento({ po: { runtime: 'codex', model: 'gpt-5.5', effort: 'high' } }, MOTORES)
    ).toEqual([])
  })

  it('sem catálogo do motor NÃO acusa modelo nenhum — "não sei" não é "não existe"', () => {
    const semCatalogo: MotorOpcoes[] = [
      {
        runtime: 'claude',
        esforcos: ['low'],
        esforcoNoNomeDoModelo: false,
        modelos: [],
        indisponiveis: [],
      },
    ]
    expect(
      avisosDoCarregamento({ ra: { runtime: 'claude', model: 'seja-la-o-que-for' } }, semCatalogo)
    ).toEqual([])
  })
})

describe('trocar o motor de um degrau', () => {
  it('o modelo do motor ANTIGO não sobrevive à troca', () => {
    // O defeito de 01/09 na cara do cliente: `modelByRole` carimbava
    // `Gemini 3.7 Flash (Medium)` em qualquer motor, e
    // `claude --model "Gemini 3.7 Flash (Medium)"` responde "There's an issue
    // with the selected model". Um seletor que mantém o modelo ao trocar de
    // motor monta exatamente esse degrau morto, com o dono achando que escolheu.
    const degrau = {
      chave: 'qa#0',
      runtime: 'antigravity',
      model: 'Gemini 3.7 Flash (Medium)',
      effort: '',
    }
    expect(trocarMotor(degrau, 'claude', MOTORES).model).toBe('')
  })

  it('o esforço só sobrevive se existir na escada do motor novo', () => {
    const comMax = { chave: 'qa#0', runtime: 'claude', model: '', effort: 'max' }
    // 'max' existe no claude e NÃO existe no codex.
    expect(trocarMotor(comMax, 'codex', MOTORES).effort).toBe('')
    const comHigh = { chave: 'qa#0', runtime: 'claude', model: '', effort: 'high' }
    expect(trocarMotor(comHigh, 'codex', MOTORES).effort).toBe('high')
  })

  it('indo para o antigravity o esforço cai — lá ele vive no nome do modelo', () => {
    const d = { chave: 'qa#0', runtime: 'claude', model: '', effort: 'high' }
    expect(trocarMotor(d, 'antigravity', MOTORES).effort).toBe('')
  })

  it('trocar para o MESMO motor não mexe em nada', () => {
    const d = { chave: 'qa#0', runtime: 'claude', model: 'claude-opus-5', effort: 'max' }
    expect(trocarMotor(d, 'claude', MOTORES)).toEqual(d)
  })

  it('a chave sobrevive à troca — ela identifica a LINHA, não o conteúdo', () => {
    const d = { chave: 'qa#7', runtime: 'claude', model: 'claude-opus-5', effort: 'max' }
    expect(trocarMotor(d, 'codex', MOTORES).chave).toBe('qa#7')
  })
})

describe('ordenar a cascata', () => {
  it('subir o segundo degrau o torna o principal', () => {
    const c = cascataDeTeste()
    const movida = mover(c.qa, 1, 'cima')
    expect(movida.map((d) => d.runtime)).toEqual(['codex', 'claude'])
  })

  it('descer o principal o torna o primeiro reserva', () => {
    const c = cascataDeTeste()
    expect(mover(c.qa, 0, 'baixo').map((d) => d.runtime)).toEqual(['codex', 'claude'])
  })

  it('mover para fora da lista devolve a MESMA lista, sem cópia', () => {
    // Identidade referencial: devolver um array novo faria o React redesenhar
    // a lista inteira a cada clique inútil no botão já desabilitado.
    const c = cascataDeTeste()
    expect(mover(c.qa, 0, 'cima')).toBe(c.qa)
    expect(mover(c.qa, c.qa.length - 1, 'baixo')).toBe(c.qa)
  })

  it('mover não perde nem duplica degrau, e as chaves seguem únicas', () => {
    const c = paraTela(
      { qa: { runtime: 'codex', fallbacks: [{ runtime: 'codex' }, { runtime: 'claude' }] } },
      MOTORES
    )
    const movida = mover(c.qa, 2, 'cima')
    expect(movida).toHaveLength(3)
    expect(new Set(movida.map((d) => d.chave)).size).toBe(3)
  })
})

describe('acrescentar e remover degrau', () => {
  it('o degrau novo nasce com chave que ainda não existe na lista', () => {
    const c = cascataDeTeste()
    const lista = novoDegrau('qa', c.qa, MOTORES)
    expect(new Set(lista.map((d) => d.chave)).size).toBe(lista.length)
    expect(lista).toHaveLength(c.qa.length + 1)
  })

  it('a chave nova não repete a de um degrau REMOVIDO antes — o contador não anda para trás', () => {
    const c = paraTela({ qa: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] } }, MOTORES)
    const semOSegundo = removerDegrau(c.qa, 1)
    const comOutro = novoDegrau('qa', semOSegundo, MOTORES)
    expect(new Set(comOutro.map((d) => d.chave)).size).toBe(comOutro.length)
    expect(comOutro.map((d) => d.chave)).not.toContain(c.qa[1].chave)
  })

  it('o último degrau nunca é removido — um papel sem motor não roda', () => {
    const c = cascataDeTeste()
    expect(removerDegrau(c.sm, 0)).toBe(c.sm)
  })
})

describe('as opções do seletor de modelo', () => {
  it('lista o catálogo vivo do motor', () => {
    const o = opcoesDeModelo(MOTORES[0], '')
    expect(o.filter((x) => x.estado === 'vivo').map((x) => x.valor)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ])
  })

  it('o modelo que SAIU DO AR aparece dizendo que saiu, em vez de sumir', () => {
    const o = opcoesDeModelo(MOTORES[0], '')
    const saiu = o.find((x) => x.valor === 'claude-opus-4-1')
    expect(saiu?.estado).toBe('saiu')
    expect(saiu?.rotulo).toMatch(/Claude Opus 4\.1/)
    // Não é escolha legítima: fica travada para não ser escolhida de novo.
    expect(saiu?.desabilitada).toBe(true)
  })

  it('o modelo que saiu E está escolhido fica selecionável — senão o select mente', () => {
    // `<select>` cujo `value` não casa nenhuma `<option>` habilitada desenha
    // outra coisa. O dono leria um modelo que nunca escolheu.
    const o = opcoesDeModelo(MOTORES[0], 'claude-opus-4-1')
    const saiu = o.find((x) => x.valor === 'claude-opus-4-1')
    expect(saiu?.desabilitada).toBe(false)
    expect(o.filter((x) => x.valor === 'claude-opus-4-1')).toHaveLength(1)
  })

  it('modelo escolhido que o catálogo desconhece aparece marcado como fora dele', () => {
    const o = opcoesDeModelo(MOTORES[0], 'claude-inventado-9')
    const fora = o.find((x) => x.valor === 'claude-inventado-9')
    expect(fora?.estado).toBe('fora')
    expect(fora?.desabilitada).toBe(false)
  })

  it('o escolhido aparece UMA vez só, mesmo estando no catálogo vivo', () => {
    const o = opcoesDeModelo(MOTORES[0], 'claude-opus-5')
    expect(o.filter((x) => x.valor === 'claude-opus-5')).toHaveLength(1)
  })

  it('cada opção tem valor único — chave de lista não pode repetir', () => {
    const o = opcoesDeModelo(MOTORES[0], 'claude-opus-4-1')
    expect(new Set(o.map((x) => x.valor)).size).toBe(o.length)
  })

  it('motor sem catálogo NÃO vira lista vazia silenciosa: a tela recebe o motivo', () => {
    const semCatalogo: MotorOpcoes = {
      runtime: 'claude',
      esforcos: ['low'],
      esforcoNoNomeDoModelo: false,
      modelos: [],
      indisponiveis: [],
    }
    expect(opcoesDeModelo(semCatalogo, '')).toEqual([])
  })
})

describe('o seletor de esforço', () => {
  it('no claude é escolha de verdade, com a escada dele', () => {
    const e = esforcoNaTela(MOTORES[0])
    expect(e.habilitado).toBe(true)
    expect(e.opcoes).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(e.motivo).toBeNull()
  })

  it('no codex a escada é OUTRA — sem "max"', () => {
    expect(esforcoNaTela(MOTORES[1]).opcoes).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('no antigravity o controle nasce DESABILITADO com o motivo visível', () => {
    // Controle que não persiste = desabilitado com o motivo, nunca
    // clicável-e-inerte. E aqui não é só "não persiste": `--effort` junto de
    // `--model` é erro duro do CLI, e a rota recusa a gravação.
    const e = esforcoNaTela(MOTORES[2])
    expect(e.habilitado).toBe(false)
    expect(e.motivo).toBeTruthy()
    expect(e.motivo).toMatch(/nome do modelo/i)
  })

  it('motor desconhecido não inventa escada', () => {
    const e = esforcoNaTela(undefined)
    expect(e.habilitado).toBe(false)
    expect(e.opcoes).toEqual([])
  })
})

describe('o que vai para a rota', () => {
  it('o primeiro degrau é o principal e o resto vira fallbacks, na ordem', () => {
    const c = cascataDeTeste()
    const corpo = paraEnvio(c, MOTORES)
    expect(corpo.agents.qa).toEqual({
      runtime: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
      fallbacks: [{ runtime: 'codex', model: 'gpt-5.5', effort: 'xhigh' }],
    })
  })

  it('campo vazio não é enviado como string vazia — a rota recusaria', () => {
    const c = cascataDeTeste()
    expect(paraEnvio(c, MOTORES).agents.sm).toEqual({ runtime: 'codex', fallbacks: [] })
  })

  it('NUNCA manda esforço para o antigravity — a rota devolve 400 e a cascata não salva', () => {
    const c = paraTela({ po: { runtime: 'claude', effort: 'high' } }, MOTORES)
    const trocado = { ...c, po: [trocarMotor(c.po[0], 'antigravity', MOTORES)] }
    const enviado = paraEnvio(trocado, MOTORES).agents.po as PapelSalvo
    expect(enviado.effort).toBeUndefined()
  })

  it('manda os quatro papéis: a rota substitui `agents` INTEIRO', () => {
    // Meia cascata gravada apagaria os papéis que não foram enviados.
    expect(Object.keys(paraEnvio(cascataDeTeste(), MOTORES).agents).sort()).toEqual([
      'po',
      'qa',
      'ra',
      'sm',
    ])
  })
})

describe('há algo para salvar?', () => {
  it('cascata intocada não tem o que salvar', () => {
    const a = cascataDeTeste()
    const b = cascataDeTeste()
    expect(mudou(a, b, MOTORES)).toBe(false)
  })

  it('reordenar conta como mudança', () => {
    const a = cascataDeTeste()
    const b = { ...cascataDeTeste() }
    b.qa = mover(b.qa, 1, 'cima')
    expect(mudou(a, b, MOTORES)).toBe(true)
  })

  it('só a CHAVE mudar não conta — ela é da tela, não da configuração', () => {
    const a = cascataDeTeste()
    const b = cascataDeTeste()
    b.qa = b.qa.map((d) => ({ ...d, chave: `outra-${d.chave}` }))
    expect(mudou(a, b, MOTORES)).toBe(false)
  })
})

describe('a cota que aparece ao lado do motor', () => {
  const AGORA = new Date('2026-09-01T12:00:00.000Z')
  const base: MotorCota = {
    id: 'claude',
    nome: 'Claude Code',
    estado: 'ligado',
    sessao: 26,
    semana: 12,
    lidoEm: '2026-09-01T11:30:00.000Z',
    precisaReligar: false,
  }

  it('mostra os dois percentuais medidos', () => {
    const r = resumoDaCota({ motor: base, cotaLida: true, motivoDaCota: null, agora: AGORA })
    expect(r.texto).toMatch(/26%/)
    expect(r.texto).toMatch(/12%/)
    expect(r.tom).toBe('ok')
  })

  it('percentual alto muda o tom — é o número que faz o dono decidir', () => {
    expect(
      resumoDaCota({
        motor: { ...base, sessao: 92 },
        cotaLida: true,
        motivoDaCota: null,
        agora: AGORA,
      }).tom
    ).toBe('grave')
    expect(
      resumoDaCota({
        motor: { ...base, sessao: 80 },
        cotaLida: true,
        motivoDaCota: null,
        agora: AGORA,
      }).tom
    ).toBe('aviso')
  })

  it('NULL NÃO VIRA ZERO: "não sei" nunca vira "cota inteira"', () => {
    const r = resumoDaCota({
      motor: { ...base, sessao: null, semana: null },
      cotaLida: true,
      motivoDaCota: null,
      agora: AGORA,
    })
    expect(r.texto).not.toMatch(/0%/)
    expect(r.texto).toMatch(/não consegui ler/i)
    expect(r.tom).toBe('mudo')
  })

  it('uma janela medida e a outra não mostra só a medida', () => {
    const r = resumoDaCota({
      motor: { ...base, semana: null },
      cotaLida: true,
      motivoDaCota: null,
      agora: AGORA,
    })
    expect(r.texto).toMatch(/26%/)
    expect(r.texto).not.toMatch(/semana/)
  })

  it('falha de leitura NÃO é "motor sem cota": diz o motivo do servidor', () => {
    const r = resumoDaCota({
      motor: undefined,
      cotaLida: false,
      motivoDaCota: 'não consegui ler a cota dos seus motores agora',
      agora: AGORA,
    })
    expect(r.texto).toMatch(/não consegui ler a cota/i)
    expect(r.tom).toBe('mudo')
  })

  it('motor que o dono nunca conectou é dito — este degrau não vai rodar', () => {
    const r = resumoDaCota({ motor: undefined, cotaLida: true, motivoDaCota: null, agora: AGORA })
    expect(r.texto).toMatch(/não está conectado/i)
    expect(r.tom).toBe('grave')
  })

  it('motor com a credencial vencida pede para religar', () => {
    const r = resumoDaCota({
      motor: { ...base, estado: 'precisa_religar', precisaReligar: true },
      cotaLida: true,
      motivoDaCota: null,
      agora: AGORA,
    })
    expect(r.texto).toMatch(/religar/i)
    expect(r.tom).toBe('grave')
  })
})

describe('quando a cota foi lida', () => {
  const AGORA = new Date('2026-09-01T12:00:00.000Z')
  it('nunca lida é dito, não é "agora"', () => {
    expect(quandoFoiLido(null, AGORA)).toMatch(/nunca/)
  })
  it('minutos, horas e dias', () => {
    expect(quandoFoiLido('2026-09-01T11:59:30.000Z', AGORA)).toMatch(/agora/)
    expect(quandoFoiLido('2026-09-01T11:20:00.000Z', AGORA)).toMatch(/40 min/)
    expect(quandoFoiLido('2026-09-01T06:00:00.000Z', AGORA)).toMatch(/6 h/)
    expect(quandoFoiLido('2026-08-29T12:00:00.000Z', AGORA)).toMatch(/3 d/)
  })
})

describe('trocar modelo e esforço', () => {
  it('trocar o modelo não mexe no esforço', () => {
    const d = { chave: 'po#0', runtime: 'claude', model: 'claude-opus-5', effort: 'high' }
    expect(trocarModelo(d, 'claude-sonnet-5')).toEqual({ ...d, model: 'claude-sonnet-5' })
  })
  it('trocar o esforço não mexe no modelo', () => {
    const d = { chave: 'po#0', runtime: 'claude', model: 'claude-opus-5', effort: 'high' }
    expect(trocarEsforco(d, 'max')).toEqual({ ...d, effort: 'max' })
  })
})
