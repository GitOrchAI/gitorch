import { describe, it, expect } from 'vitest'
import {
  perguntaExecutivaDeReserva,
  OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA,
} from './texto-de-escalada.js'

// D72 (02/09) — o dono flagrou o texto de reserva anterior (`textoDeEscaladaParaODono`)
// chegando com a PERGUNTA CRUA do dev, em inglês, e sem opções de verdade
// (só o botão "Outro"): "não são perguntas formuladas ... não são três
// opções ... seja executivo". A reserva agora NUNCA cita o texto do dev —
// é sempre um texto executivo determinístico, com EXATAMENTE 3 opções
// objetivas (a 4ª, "Outro", é adicionada por quem chama `ask()`).
describe('perguntaExecutivaDeReserva — nunca a pergunta crua do dev, sempre 3 opções executivas', () => {
  it('o texto NUNCA contém a pergunta original do dev, mesmo passando ela', () => {
    const pergunta = perguntaExecutivaDeReserva({ issueNumber: 46, repository: 'acme/api' })
    expect(pergunta.text).toBe(
      'O dev está travado numa dúvida técnica na tarefa #46 de acme/api e nem o RA conseguiu ' +
        'resolver. O que fazer?'
    )
  })

  it('exatamente 3 opções objetivas, na ordem pedida pelo dono', () => {
    const pergunta = perguntaExecutivaDeReserva({ issueNumber: 1, repository: 'a/b' })
    expect(pergunta.options).toHaveLength(3)
    expect(pergunta.options.map((o) => o.label)).toEqual([
      'Pausar a tarefa e revisar depois',
      'Seguir com a melhor suposição do RA mesmo assim',
      'Pedir ao dev que abra o PR com o que tem',
    ])
  })

  it('as opções são as mesmas exportadas em OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA', () => {
    const pergunta = perguntaExecutivaDeReserva({ issueNumber: 1, repository: 'a/b' })
    expect(pergunta.options).toEqual(OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA)
  })

  it('nunca em inglês — o texto inteiro é PT-BR determinístico', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 309,
      repository: 'GitOrchAI/gitorch',
    })
    expect(pergunta.text).not.toMatch(/successfully|tests are passing|the plan/i)
  })
})
