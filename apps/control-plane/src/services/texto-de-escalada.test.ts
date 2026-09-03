import { describe, it, expect } from 'vitest'
import { textoDeEscaladaParaODono } from './texto-de-escalada.js'

// L4-T3: quando o modelo (QA ou RA, depois de tentar e não saber) NÃO deixou
// uma tradução executiva pronta (`perguntaExecutivaPtBr`) — o que
// `destinoAposRa` (services/duvida-do-dev.ts) SEMPRE devolve, por desenho, e
// o que o próprio QA pode deixar vazio de propósito (o prompt de
// duvida-rails-mission.ts autoriza "leave both empty rather than forcing a
// bad one") — o produto NÃO pode cair para um aviso de texto solto
// (D71: toda pergunta ao dono é agent_question com botões, nunca texto
// solto). Este helper é o texto de RESERVA em PT-BR, determinístico, usado
// como `text` do `agentQuestionService.ask(...)` nesse caso.
describe('textoDeEscaladaParaODono', () => {
  it('sem pergunta do dev disponível: só o aviso genérico em PT-BR', () => {
    const texto = textoDeEscaladaParaODono({ issueNumber: 46, repository: 'acme/api' })
    expect(texto).toBe(
      'O dev assíncrono está parado na tarefa #46 de acme/api esperando uma decisão sua.'
    )
  })

  it('null/vazio se comporta como "sem pergunta"', () => {
    expect(
      textoDeEscaladaParaODono({ issueNumber: 46, repository: 'acme/api', pergunta: null })
    ).toBe('O dev assíncrono está parado na tarefa #46 de acme/api esperando uma decisão sua.')
    expect(
      textoDeEscaladaParaODono({ issueNumber: 46, repository: 'acme/api', pergunta: '   ' })
    ).toBe('O dev assíncrono está parado na tarefa #46 de acme/api esperando uma decisão sua.')
  })

  it('com a pergunta do dev: aviso genérico + a pergunta original, entre aspas', () => {
    const texto = textoDeEscaladaParaODono({
      issueNumber: 46,
      repository: 'acme/api',
      pergunta: 'Should I use bcrypt or argon2 for password hashing?',
    })
    expect(texto).toBe(
      'O dev assíncrono está parado na tarefa #46 de acme/api esperando uma decisão sua.\n\n' +
        'Pergunta original do dev: "Should I use bcrypt or argon2 for password hashing?"'
    )
  })

  it('pergunta gigante é cortada — nunca despeja um texto sem fim no Telegram', () => {
    const enorme = 'x'.repeat(1000)
    const texto = textoDeEscaladaParaODono({ issueNumber: 1, repository: 'a/b', pergunta: enorme })
    expect(texto.length).toBeLessThan(600)
  })
})
