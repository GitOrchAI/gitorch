import { describe, it, expect } from 'vitest'
import {
  perguntaExecutivaDeReserva,
  OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA,
} from './texto-de-escalada.js'
import {
  contextoExecutivoVazio,
  LACUNA_SEM_SPRINT_CONFIGURADA,
  LACUNA_SEM_OBJETIVO_LEGIVEL,
  LACUNA_SEM_DECISAO_REGISTRADA,
  type ContextoExecutivoDaPergunta,
} from './contexto-executivo-da-pergunta.js'

/**
 * D72 (02/09) — o dono flagrou o texto de reserva anterior chegando com a
 * PERGUNTA CRUA do dev, em inglês, e sem opções de verdade: "não são
 * perguntas formuladas ... não são três opções ... seja executivo".
 *
 * D73/L4-T23 (04/09) — o dono recusou a PRÓPRIA reserva executiva que D72
 * criou ("O dev está travado numa dúvida técnica na tarefa #3716 de
 * loureng/patinhas-3d-crafts e nem o RA conseguiu resolver. O que fazer?"):
 * não quer saber que existe uma dúvida técnica nem quem é o RA — quer a
 * LÓGICA de negócio. A pergunta agora CONTA A HISTÓRIA (ciclo → entrega →
 * o que o time já resolveu → a decisão que resta), a partir do
 * `ContextoExecutivoDaPergunta` (contexto-executivo-da-pergunta.ts), e
 * NUNCA usa as palavras "dev"/"desenvolvedor"/"técnica", nome de arquivo, de
 * função ou de motor.
 */

const CONTEXTO_COMPLETO: ContextoExecutivoDaPergunta = {
  ciclo: 'Sprint 4 (01/09 a 04/09)',
  entrega: 'O cliente sobe uma foto do produto e vê a prévia antes de publicar.',
  decisoes: ['Usar o mesmo serviço de imagens que já processa as fotos do catálogo.'],
  lacunas: [],
}

describe('perguntaExecutivaDeReserva — conta a história (D73): ciclo, entrega, decisões, decisão que resta', () => {
  it('com o contexto completo: as 4 partes na ordem certa, em português, sem jargão', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 3716,
      repository: 'loureng/patinhas-3d-crafts',
      contexto: CONTEXTO_COMPLETO,
    })

    expect(pergunta.text).toBe(
      'O time está no ciclo "Sprint 4 (01/09 a 04/09)".\n\n' +
        'Esta tarefa entrega: O cliente sobe uma foto do produto e vê a prévia antes de publicar.\n\n' +
        'A equipe já resolveu sozinha: Usar o mesmo serviço de imagens que já processa as fotos do catálogo.\n\n' +
        'Falta uma decisão de negócio: como você quer seguir com a tarefa #3716 de ' +
        'loureng/patinhas-3d-crafts?'
    )
  })

  it('NUNCA contém "dev"/"desenvolvedor"/"técnica" — nem no contexto completo nem no vazio', () => {
    const cheio = perguntaExecutivaDeReserva({
      issueNumber: 3716,
      repository: 'loureng/patinhas-3d-crafts',
      contexto: CONTEXTO_COMPLETO,
    })
    const vazio = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto: contextoExecutivoVazio(),
    })

    for (const texto of [cheio.text, vazio.text]) {
      expect(texto).not.toMatch(/\bdev\b/i)
      expect(texto).not.toMatch(/desenvolvedor/i)
      expect(texto).not.toMatch(/técnic/i)
    }
  })

  it('NUNCA cita nome de arquivo, de função ou de motor', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 3716,
      repository: 'loureng/patinhas-3d-crafts',
      contexto: CONTEXTO_COMPLETO,
    })

    // nome de arquivo (extensão de código-fonte)
    expect(pergunta.text).not.toMatch(/\.(ts|tsx|js|jsx|py)\b/i)
    // nomes de função do próprio produto que apareceriam num texto técnico
    expect(pergunta.text).not.toMatch(/escalarDuvidaAoDono|perguntaExecutivaDeReserva/i)
    // nomes de motor/agente do produto
    expect(pergunta.text).not.toMatch(/\b(jules|codex|antigravity|claude)\b/i)
  })

  it('nunca em inglês — o texto inteiro é PT-BR determinístico', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 309,
      repository: 'GitOrchAI/gitorch',
      contexto: CONTEXTO_COMPLETO,
    })
    expect(pergunta.text).not.toMatch(/successfully|tests are passing|the plan/i)
  })

  it('nunca cita a pergunta original do dev, mesmo que o contexto exista', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto: CONTEXTO_COMPLETO,
    })
    expect(pergunta.text).not.toContain('Should I use bcrypt or argon2?')
  })

  it('exatamente 3 opções objetivas, na ordem pedida pelo dono', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 1,
      repository: 'a/b',
      contexto: contextoExecutivoVazio(),
    })
    expect(pergunta.options).toHaveLength(3)
    expect(pergunta.options).toEqual(OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA)
  })
})

describe('OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA — D73: opções de negócio, não de processo', () => {
  it('os LABELS são escolhas que um CEO reconhece, nunca vocabulário de processo técnico', () => {
    const labels = OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA.map((o) => o.label)
    expect(labels).toEqual([
      'Pausar esta tarefa até eu decidir com calma',
      'Seguir com a melhor decisão da equipe por agora',
      'Entregar o que já está pronto para revisão',
    ])
    for (const label of labels) {
      expect(label).not.toMatch(/\bdev\b/i)
      expect(label).not.toMatch(/desenvolvedor|técnic|\bPR\b|pull request/i)
    }
  })

  it('os VALUES internos continuam os mesmos (pausar/seguir-suposicao-ra/pedir-pr) — quem já os trata não quebra', () => {
    expect(OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA.map((o) => o.value)).toEqual([
      'pausar',
      'seguir-suposicao-ra',
      'pedir-pr',
    ])
  })
})

describe('perguntaExecutivaDeReserva — lacuna declarada, nunca inventada (D73, item 4)', () => {
  it('sem sprint configurada: o texto diz isso com naturalidade, no lugar do ciclo', () => {
    const contexto: ContextoExecutivoDaPergunta = {
      ciclo: null,
      entrega: CONTEXTO_COMPLETO.entrega,
      decisoes: CONTEXTO_COMPLETO.decisoes,
      lacunas: [LACUNA_SEM_SPRINT_CONFIGURADA],
    }
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto,
    })

    expect(pergunta.text).toContain('Este projeto ainda não tem uma sprint configurada.')
    // nunca inventa um ciclo que não existe
    expect(pergunta.text).not.toMatch(/O time está no ciclo/)
  })

  it('sem objetivo de tarefa legível: o texto diz isso, no lugar da entrega', () => {
    const contexto: ContextoExecutivoDaPergunta = {
      ciclo: CONTEXTO_COMPLETO.ciclo,
      entrega: null,
      decisoes: CONTEXTO_COMPLETO.decisoes,
      lacunas: [LACUNA_SEM_OBJETIVO_LEGIVEL],
    }
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto,
    })

    expect(pergunta.text).toContain('Não foi possível ler o objetivo desta tarefa.')
    expect(pergunta.text).not.toMatch(/Esta tarefa entrega:/)
  })

  it('sem decisão registrada: o texto diz isso, no lugar do que o time já resolveu', () => {
    const contexto: ContextoExecutivoDaPergunta = {
      ciclo: CONTEXTO_COMPLETO.ciclo,
      entrega: CONTEXTO_COMPLETO.entrega,
      decisoes: [],
      lacunas: [LACUNA_SEM_DECISAO_REGISTRADA],
    }
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto,
    })

    expect(pergunta.text).toContain(
      'A equipe ainda não tinha registrado nenhuma decisão sobre esta tarefa.'
    )
    expect(pergunta.text).not.toMatch(/A equipe já resolveu sozinha:/)
  })

  it('contexto totalmente vazio: as 3 lacunas aparecem, e a decisão que resta continua presente', () => {
    const pergunta = perguntaExecutivaDeReserva({
      issueNumber: 46,
      repository: 'acme/api',
      contexto: contextoExecutivoVazio(),
    })

    expect(pergunta.text).toContain('Este projeto ainda não tem uma sprint configurada.')
    expect(pergunta.text).toContain('Não foi possível ler o objetivo desta tarefa.')
    expect(pergunta.text).toContain(
      'A equipe ainda não tinha registrado nenhuma decisão sobre esta tarefa.'
    )
    expect(pergunta.text).toContain('tarefa #46 de acme/api')
  })
})
