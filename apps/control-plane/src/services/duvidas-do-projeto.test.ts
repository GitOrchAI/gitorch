import { describe, it, expect } from 'vitest'
import {
  chaveDaDuvida,
  duvidaSobreComoPublica,
  duvidaSobreFaltaDeVerificacao,
  duvidaDetalheDeComoPublica,
  duvidaDeSeguimentoComoPublica,
  VALOR_PUBLICA_OUTRO,
  respostaConhecida,
} from './duvidas-do-projeto.js'

describe('chaveDaDuvida', () => {
  // O mesmo dono pode ter dois projetos que publicam de jeitos diferentes. Uma
  // chave só por assunto faria a resposta de um valer para o outro.
  it('separa por repositório, não só por assunto', () => {
    expect(chaveDaDuvida('como-publica', 'dono/a')).not.toBe(
      chaveDaDuvida('como-publica', 'dono/b')
    )
  })

  it('a mesma dúvida no mesmo repositório dá a mesma chave', () => {
    expect(chaveDaDuvida('como-publica', 'dono/a')).toBe(chaveDaDuvida('como-publica', 'dono/a'))
  })

  it('assuntos diferentes no mesmo repositório não se misturam', () => {
    expect(chaveDaDuvida('como-publica', 'dono/a')).not.toBe(
      chaveDaDuvida('sem-verificacao', 'dono/a')
    )
  })
})

describe('duvidaSobreComoPublica', () => {
  const d = duvidaSobreComoPublica('loureng/patinhas-3d-crafts')

  it('nomeia o repositório, para o dono saber de qual projeto se fala', () => {
    expect(d.text).toContain('loureng/patinhas-3d-crafts')
  })

  // L4-T18 fix-up (itens 5/6, revisão de portão): `sendTelegramQuestion`
  // (telegram-bot.ts) passou a RECUSAR (lança) pergunta com mais de 3 opções
  // fixas — e esta pergunta tinha 4, um crash real em produção (nenhuma
  // outra pergunta da base tem mais de 3). O conserto reduz para 3, com a
  // terceira abrangente o bastante para os dois casos menos comuns (serviço
  // externo / manual) — ver `duvidaDetalheDeComoPublica` logo abaixo para
  // como os 4 valores continuam TODOS alcançáveis, sem perder informação.
  it('no máximo 3 opções fixas — nunca estoura o teto de sendTelegramQuestion (D71)', () => {
    expect(d.options.length).toBeLessThanOrEqual(3)
  })

  it('cobre workflow e VM própria diretamente, e o resto pela opção abrangente', () => {
    const valores = d.options.map((o) => o.value)
    expect(valores).toContain('publica-por-workflow')
    expect(valores).toContain('publica-em-vm-propria')
    expect(valores).toContain(VALOR_PUBLICA_OUTRO)
  })

  it('explica a consequência de não responder, sem jargão', () => {
    expect(d.context).toMatch(/mescladas mas sem fechar/i)
    expect(d.text).not.toMatch(/deployment|environment|webhook/i)
  })

  it('a chave carrega o repositório', () => {
    expect(d.dedupKey).toContain('loureng/patinhas-3d-crafts')
  })
})

describe('duvidaDetalheDeComoPublica — o 2º passo, só para quem respondeu "outro"', () => {
  const d = duvidaDetalheDeComoPublica('loureng/patinhas-3d-crafts')

  it('no máximo 3 opções fixas (na prática, as 2 que sobraram)', () => {
    expect(d.options.length).toBeLessThanOrEqual(3)
  })

  // As duas respostas que `duvidaSobreComoPublica` não perguntou direto —
  // `como-o-projeto-publica.ts` continua entendendo os MESMOS 4 valores,
  // sem nenhum 5º inventado.
  it('oferece exatamente serviço externo e publicação manual — os valores que como-o-projeto-publica.ts já entende', () => {
    const valores = d.options.map((o) => o.value)
    expect(valores).toEqual(['publica-em-servico-externo', 'publica-manualmente'])
  })

  // MESMA dedupKey da pergunta original: é a MESMA decisão de "como publica",
  // só entregue em duas perguntas curtas — nunca uma decisão nova/paralela.
  it('usa a MESMA dedupKey de "como-publica" — é a mesma decisão, entregue em duas perguntas', () => {
    expect(d.dedupKey).toBe(chaveDaDuvida('como-publica', 'loureng/patinhas-3d-crafts'))
  })
})

describe('duvidaDeSeguimentoComoPublica — dispara o 2º passo quando "outro" foi escolhido', () => {
  it('resposta "outro" na dedupKey de como-publica: devolve a pergunta de detalhe do MESMO repositório', () => {
    const dedupKey = chaveDaDuvida('como-publica', 'acme/api')
    const seguimento = duvidaDeSeguimentoComoPublica(dedupKey, VALOR_PUBLICA_OUTRO)
    expect(seguimento).toEqual(duvidaDetalheDeComoPublica('acme/api'))
  })

  it('qualquer outra resposta (workflow, vm-propria, texto livre): não dispara segunda pergunta', () => {
    const dedupKey = chaveDaDuvida('como-publica', 'acme/api')
    expect(duvidaDeSeguimentoComoPublica(dedupKey, 'publica-por-workflow')).toBeNull()
    expect(duvidaDeSeguimentoComoPublica(dedupKey, 'publica-em-vm-propria')).toBeNull()
    expect(duvidaDeSeguimentoComoPublica(dedupKey, 'prefiro não automatizar nada')).toBeNull()
  })

  it('"outro" numa dedupKey de OUTRO assunto: não dispara nada (nunca confunde perguntas)', () => {
    expect(
      duvidaDeSeguimentoComoPublica(
        chaveDaDuvida('sem-verificacao', 'acme/api'),
        VALOR_PUBLICA_OUTRO
      )
    ).toBeNull()
  })
})

describe('duvidaSobreFaltaDeVerificacao', () => {
  it('oferece o GitOrch montar, o dono montar, ou seguir sem', () => {
    const valores = duvidaSobreFaltaDeVerificacao('dono/r').options.map((o) => o.value)
    expect(valores).toEqual([
      'montar-verificacao',
      'dono-monta-verificacao',
      'seguir-sem-verificacao',
    ])
  })
})

describe('respostaConhecida', () => {
  // A segunda metade da ordem do dono: "para que nunca mais questione o
  // usuario". Perguntar é barato; acordar o dono não é.
  it('acha a resposta já dada e evita perguntar de novo', () => {
    const memoria = new Map([['como-publica:dono/a', 'publica-em-vm-propria']])
    expect(respostaConhecida(memoria, 'como-publica', 'dono/a')).toBe('publica-em-vm-propria')
  })

  it('resposta de OUTRO projeto não serve para este', () => {
    const memoria = new Map([['como-publica:dono/a', 'publica-por-workflow']])
    expect(respostaConhecida(memoria, 'como-publica', 'dono/b')).toBeNull()
  })

  it('sem memória nenhuma, não inventa resposta', () => {
    expect(respostaConhecida(undefined, 'como-publica', 'dono/a')).toBeNull()
    expect(respostaConhecida(new Map(), 'como-publica', 'dono/a')).toBeNull()
  })
})
