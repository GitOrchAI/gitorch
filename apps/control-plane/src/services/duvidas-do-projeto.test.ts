import { describe, it, expect } from 'vitest'
import {
  chaveDaDuvida,
  duvidaSobreComoPublica,
  duvidaSobreFaltaDeVerificacao,
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

  // Os cenários que o dono nomeou: sem CI-CD, com CI sem CD, serviço externo,
  // e VM privada — que é o caso dele.
  it('cobre os caminhos reais, incluindo VM própria e publicação manual', () => {
    const valores = d.options.map((o) => o.value)
    expect(valores).toContain('publica-por-workflow')
    expect(valores).toContain('publica-em-vm-propria')
    expect(valores).toContain('publica-em-servico-externo')
    expect(valores).toContain('publica-manualmente')
  })

  it('explica a consequência de não responder, sem jargão', () => {
    expect(d.context).toMatch(/mescladas mas sem fechar/i)
    expect(d.text).not.toMatch(/deployment|environment|webhook/i)
  })

  it('a chave carrega o repositório', () => {
    expect(d.dedupKey).toContain('loureng/patinhas-3d-crafts')
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
