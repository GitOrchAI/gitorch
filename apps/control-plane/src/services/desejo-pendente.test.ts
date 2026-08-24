import { describe, it, expect } from 'vitest'
import {
  decidirSobrePendente,
  montarTecladoDeProjetos,
  lerCliqueDeProjeto,
  PRAZO_DO_PENDENTE_MS,
  TETO_DE_BOTOES,
  type PendenteGuardado,
} from './desejo-pendente.js'

const AGORA = new Date('2026-08-24T12:00:00Z')

function pendente(over: Partial<PendenteGuardado> = {}): PendenteGuardado {
  return {
    id: 'pnd_1',
    userId: 'u1',
    chatId: '6725599649',
    texto: 'quero que o site aceite avaliação com foto',
    usadoEm: null,
    createdAt: new Date(AGORA.getTime() - 60_000),
    ...over,
  }
}

describe('decidirSobrePendente', () => {
  it('usa o pendente recente e devolve o texto INTEIRO do pedido', () => {
    const d = decidirSobrePendente(pendente(), AGORA)
    expect(d).toEqual({ acao: 'usar', texto: 'quero que o site aceite avaliação com foto' })
  })

  it('pendente que não existe é "sumiu", não "vencido"', () => {
    // Banco limpo ou id forjado. Dizer "venceu" mandaria a pessoa esperar por
    // algo que nunca vai voltar.
    expect(decidirSobrePendente(null, AGORA)).toEqual({ acao: 'sumiu' })
    expect(decidirSobrePendente(undefined, AGORA)).toEqual({ acao: 'sumiu' })
  })

  it('o MESMO clique reentregue pelo Telegram não abre a segunda issue', () => {
    const d = decidirSobrePendente(pendente({ usadoEm: new Date(AGORA.getTime() - 1000) }), AGORA)
    expect(d).toEqual({ acao: 'ja-usado' })
  })

  it('toque em conversa velha não vira tarefa: passou do prazo, recusa', () => {
    const velho = pendente({ createdAt: new Date(AGORA.getTime() - PRAZO_DO_PENDENTE_MS - 1) })
    expect(decidirSobrePendente(velho, AGORA)).toEqual({ acao: 'vencido' })
  })

  it('exatamente no prazo ainda vale — o corte é depois, não em cima', () => {
    const noLimite = pendente({ createdAt: new Date(AGORA.getTime() - PRAZO_DO_PENDENTE_MS) })
    expect(decidirSobrePendente(noLimite, AGORA).acao).toBe('usar')
  })

  it('data ilegível NÃO é data velha: o pedido do dono não some em silêncio', () => {
    const quebrado = pendente({ createdAt: new Date('não é data') })
    expect(decidirSobrePendente(quebrado, AGORA).acao).toBe('usar')
  })
})

describe('montarTecladoDeProjetos', () => {
  const projetos = [
    { rotulo: 'gitorch (GitOrchAI/gitorch)', repo: 'GitOrchAI/gitorch' },
    {
      rotulo: 'patinhas-3d-crafts (loureng/patinhas-3d-crafts)',
      repo: 'loureng/patinhas-3d-crafts',
    },
  ]

  it('um projeto por linha, para nome comprido não ser cortado', () => {
    const t = montarTecladoDeProjetos(projetos, 'pnd_1')
    expect(t.inline_keyboard).toHaveLength(2)
    expect(t.inline_keyboard.every((linha) => linha.length === 1)).toBe(true)
    expect(t.inline_keyboard[0]?.[0]?.text).toBe('gitorch (GitOrchAI/gitorch)')
  })

  it('o botão carrega o ÍNDICE, nunca o endereço — 64 bytes é o teto do Telegram', () => {
    const comprido = [
      {
        rotulo: 'x',
        repo: 'uma-organizacao-com-nome-muito-comprido/um-repositorio-com-nome-ainda-maior',
      },
    ]
    const t = montarTecladoDeProjetos(comprido, 'cl9x0000qwertyuiopasdfghj')
    const dado = t.inline_keyboard[0]?.[0]?.callback_data ?? ''
    expect(dado).toBe('desejo:cl9x0000qwertyuiopasdfghj:0')
    expect(Buffer.byteLength(dado, 'utf8')).toBeLessThanOrEqual(64)
    expect(dado).not.toContain('uma-organizacao')
  })

  it('acima do teto o teclado para de crescer — parede de botões não é escolha', () => {
    const muitos = Array.from({ length: TETO_DE_BOTOES + 5 }, (_, i) => ({
      rotulo: `p${i}`,
      repo: `dono/p${i}`,
    }))
    expect(montarTecladoDeProjetos(muitos, 'pnd_1').inline_keyboard).toHaveLength(TETO_DE_BOTOES)
  })
})

describe('lerCliqueDeProjeto', () => {
  it('lê o clique nosso', () => {
    expect(lerCliqueDeProjeto('desejo:pnd_1:2')).toEqual({ pendenteId: 'pnd_1', indice: 2 })
  })

  it('NÃO rouba o clique da dúvida do PO, que viaja no mesmo canal', () => {
    // Se este teste cair, o dono perde resposta nos dois lados de uma vez.
    expect(lerCliqueDeProjeto('q:abc:1')).toBeNull()
    expect(lerCliqueDeProjeto('question:abc:1')).toBeNull()
  })

  it('recusa lixo, vazio e formato meio certo', () => {
    expect(lerCliqueDeProjeto(undefined)).toBeNull()
    expect(lerCliqueDeProjeto('')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1')).toBeNull()
    expect(lerCliqueDeProjeto('desejo::0')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1:0:1')).toBeNull()
  })

  it('índice tem que ser dígito puro: "1e3" viraria o projeto 1000', () => {
    expect(lerCliqueDeProjeto('desejo:pnd_1:1e3')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1: 2')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1:-1')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1:abc')).toBeNull()
  })
})
