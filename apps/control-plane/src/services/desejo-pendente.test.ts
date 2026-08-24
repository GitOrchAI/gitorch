import { describe, it, expect } from 'vitest'
import {
  decidirSobrePendente,
  montarTecladoDeProjetos,
  lerCliqueDeProjeto,
  PRAZO_DO_PENDENTE_MS,
  TETO_DE_BOTOES,
  TETO_DO_CALLBACK_DATA_BYTES,
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
    { rotulo: 'GitOrchAI/gitorch (gitorch)', id: 'proj_gitorch' },
    { rotulo: 'loureng/patinhas-3d-crafts', id: 'proj_patinhas' },
  ]

  it('um projeto por linha, para nome comprido não ser cortado', () => {
    const t = montarTecladoDeProjetos(projetos, 'pnd_1')
    expect(t?.inline_keyboard).toHaveLength(2)
    expect(t?.inline_keyboard.every((linha) => linha.length === 1)).toBe(true)
    expect(t?.inline_keyboard[0]?.[0]?.text).toBe('GitOrchAI/gitorch (gitorch)')
  })

  // A POSIÇÃO parece bastar e não basta: um projeto desativado entre a
  // pergunta e o toque encurta a lista, e o terceiro botão passaria a apontar
  // para outro repositório sem estourar limite nenhum.
  it('o botão carrega a IDENTIDADE do projeto, não a posição dele na lista', () => {
    const t = montarTecladoDeProjetos(projetos, 'pnd_1')
    expect(t?.inline_keyboard[1]?.[0]?.callback_data).toBe('desejo:pnd_1:proj_patinhas')
  })

  it('cabe no teto de 64 bytes do Telegram', () => {
    const t = montarTecladoDeProjetos(projetos, 'cl9x0000qwertyuiopasdfghj')
    for (const linha of t?.inline_keyboard ?? []) {
      expect(Buffer.byteLength(linha[0]?.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(
        TETO_DO_CALLBACK_DATA_BYTES
      )
    }
  })

  // Botão que o Telegram recusaria seria um botão morto. Devolver nulo manda o
  // chamador para o texto de sempre, que dá mais trabalho e nunca erra.
  it('identidade que não cabe no teto não vira botão calado: devolve nulo', () => {
    const gigante = [{ rotulo: 'x', id: 'i'.repeat(80) }]
    expect(montarTecladoDeProjetos(gigante, 'pnd_1')).toBeNull()
  })

  it('sem projeto nenhum não há teclado', () => {
    expect(montarTecladoDeProjetos([], 'pnd_1')).toBeNull()
  })

  it('acima do teto o teclado para de crescer — parede de botões não é escolha', () => {
    const muitos = Array.from({ length: TETO_DE_BOTOES + 5 }, (_, i) => ({
      rotulo: `p${i}`,
      id: `proj_${i}`,
    }))
    expect(montarTecladoDeProjetos(muitos, 'pnd_1')?.inline_keyboard).toHaveLength(TETO_DE_BOTOES)
  })
})

describe('lerCliqueDeProjeto', () => {
  it('lê o clique nosso', () => {
    expect(lerCliqueDeProjeto('desejo:pnd_1:proj_a')).toEqual({
      pendenteId: 'pnd_1',
      projetoId: 'proj_a',
    })
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
    expect(lerCliqueDeProjeto('desejo::proj_a')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1:')).toBeNull()
    expect(lerCliqueDeProjeto('desejo:pnd_1:proj_a:extra')).toBeNull()
  })

  // Ler o id não é o mesmo que confiar nele: quem decide se aquele projeto é
  // do dono é `tratarCliqueDeProjeto`, contra a lista recalculada no clique.
  it('id desconhecido é lido, e recusado depois pela lista de projetos', () => {
    expect(lerCliqueDeProjeto('desejo:pnd_1:proj_de_outra_pessoa')).toEqual({
      pendenteId: 'pnd_1',
      projetoId: 'proj_de_outra_pessoa',
    })
  })
})
