import { describe, it, expect, vi } from 'vitest'
import {
  avaliarViabilidadeDaLogicaAlternativa,
  resolverLogicaAlternativaDoJules,
  respostaMantendoLogicaOriginal,
  dedupKeyDeLogicaAlternativa,
  montarPerguntaSobreLogicaAlternativa,
  perguntarAoDonoSobreLogicaAlternativa,
  perguntarAoDonoSeLogicaAlternativaViavel,
  textoDaPerguntaSobreLogicaAlternativa,
  decidirDestinoAposLogicaAlternativa,
  OPCOES_DE_LOGICA_ALTERNATIVA,
  type ResultadoDaLogicaAlternativa,
} from './viabilidade-da-logica-alternativa.js'
import { textoDaRespostaAoDev, type DestinoDaDuvida } from './duvida-do-dev.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'
import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import type { DuvidaRailsMissionResult } from './duvida-rails-mission.js'

const BASE = {
  resumoDaProposta:
    'Em vez de hash local, usar o login social que o cliente já tem no Google Workspace.',
  pergunta: 'Devo usar bcrypt ou argon2 para o hash de senha?',
  repository: 'acme/api',
  issueNumber: 7,
  contextBlocks: ['codegraph aqui'],
}

const RESPOSTA_ORA_RA = {
  impactoTecnico: 'Troca o fluxo de login inteiro.',
  riscoOuGanho: 'Ganho: menos senha para gerenciar. Risco: depende do Workspace do cliente.',
}

/** Um `execute` que devolve, em sequência, a saída do RA e depois do PO. */
function executeSequencial(respostas: unknown[]) {
  let chamada = 0
  return vi.fn(async () => {
    const r = respostas[chamada]
    chamada += 1
    return JSON.stringify(r)
  })
}

describe('avaliarViabilidadeDaLogicaAlternativa — RA analisa, PO decide (DJ-T9, D76)', () => {
  it('PO decide VIÁVEL: o resultado carrega viavel=true e o motivo do PO', async () => {
    const execute = executeSequencial([
      RESPOSTA_ORA_RA,
      { decisao: 'viavel', motivo: 'O ganho de UX supera o risco de dependência externa.' },
    ])

    const r = await avaliarViabilidadeDaLogicaAlternativa({ ...BASE, execute })

    expect(r.viavel).toBe(true)
    expect(r.motivo).toBe('O ganho de UX supera o risco de dependência externa.')
    expect(r.analiseDoRa).toEqual(RESPOSTA_ORA_RA)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('PO decide INVIÁVEL: o resultado carrega viavel=false e o motivo do PO', async () => {
    const execute = executeSequencial([
      RESPOSTA_ORA_RA,
      { decisao: 'inviavel', motivo: 'A lógica original já resolve e é mais simples de manter.' },
    ])

    const r = await avaliarViabilidadeDaLogicaAlternativa({ ...BASE, execute })

    expect(r.viavel).toBe(false)
    expect(r.motivo).toBe('A lógica original já resolve e é mais simples de manter.')
  })

  it('a pergunta original e o resumo da proposta vão no prompt do RA e do PO', async () => {
    const prompts: string[] = []
    const execute = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      if (prompts.length === 1) return JSON.stringify(RESPOSTA_ORA_RA)
      return JSON.stringify({ decisao: 'viavel', motivo: 'motivo qualquer com substância' })
    })

    await avaliarViabilidadeDaLogicaAlternativa({ ...BASE, execute })

    expect(prompts[0]).toContain(BASE.pergunta)
    expect(prompts[0]).toContain(BASE.resumoDaProposta)
    // O passo do PO recebe a análise do RA como contexto.
    expect(prompts[1]).toContain(RESPOSTA_ORA_RA.impactoTecnico)
    expect(prompts[1]).toContain(RESPOSTA_ORA_RA.riscoOuGanho)
  })

  // DJ-T9, item 4 — DJ-T4/D75: "sem cota? aguarda, nunca escala." Este
  // módulo reaproveita o MESMO mecanismo (executeMissionWithFailover,
  // scheduler.ts): não captura erro nenhum de `execute`/`runFormStep`, então
  // uma falha de motor sobe intacta para quem despachou a missão decidir —
  // NUNCA vira uma decisão viável/inviável nem uma pergunta ao dono.
  describe('sem cota disponível: a exceção sobe intacta (nunca decide, nunca escala)', () => {
    it('motor sem cota no passo do RA: propaga o erro, nunca chama o passo do PO', async () => {
      const erroDeCota = new Error(
        "You've hit your usage limit. Upgrade to Plus to continue, or try again at Sep 21st, 2026."
      )
      const execute = vi.fn(async () => {
        throw erroDeCota
      })

      await expect(avaliarViabilidadeDaLogicaAlternativa({ ...BASE, execute })).rejects.toThrow(
        erroDeCota
      )
      // Só UMA chamada — o passo do RA que estourou; o passo do PO nunca roda.
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it('motor sem cota no passo do PO: propaga o erro do PO, RA já tinha respondido', async () => {
      const erroDeCota = new Error('usage limit reached')
      let chamada = 0
      const execute = vi.fn(async () => {
        chamada += 1
        if (chamada === 1) return JSON.stringify(RESPOSTA_ORA_RA)
        throw erroDeCota
      })

      await expect(avaliarViabilidadeDaLogicaAlternativa({ ...BASE, execute })).rejects.toThrow(
        erroDeCota
      )
      expect(execute).toHaveBeenCalledTimes(2)
    })

    it('resolverLogicaAlternativaDoJules também propaga — nunca cai em "mantida" nem "pronta-para-o-dono"', async () => {
      const erroDeCota = new Error('usage limit reached')
      const execute = vi.fn(async () => {
        throw erroDeCota
      })

      await expect(
        resolverLogicaAlternativaDoJules({
          ...BASE,
          respostaOriginal: 'Use argon2id por enquanto.',
          execute,
        })
      ).rejects.toThrow(erroDeCota)
    })
  })
})

describe('resolverLogicaAlternativaDoJules — os dois desfechos (DJ-T9, D76)', () => {
  it('inviável: mantém a lógica original, reaproveitando textoDaRespostaAoDev — nunca chega ao dono', async () => {
    const execute = executeSequencial([
      RESPOSTA_ORA_RA,
      { decisao: 'inviavel', motivo: 'Risco maior que o ganho — mantém como está.' },
    ])

    const r = await resolverLogicaAlternativaDoJules({
      ...BASE,
      respostaOriginal: 'Use argon2id, já está em src/lib/hash.ts.',
      execute,
    })

    expect(r.tipo).toBe('mantida-logica-original')
    if (r.tipo === 'mantida-logica-original') {
      // MESMO texto que duvida-rails-mission.ts já manda para o dev.
      expect(r.mensagemParaODev).toBe(
        textoDaRespostaAoDev('Use argon2id, já está em src/lib/hash.ts.')
      )
      expect(r.comentario).toContain('Risco maior que o ganho')
      // Nunca menciona dono/pergunta — o comentário é só log/registro.
      expect(r.comentario).not.toContain('dono')
    }
  })

  it('viável: sinaliza "pronta-para-o-dono" com o motivo e a proposta — sem montar nem enviar nada ainda', async () => {
    const execute = executeSequencial([
      RESPOSTA_ORA_RA,
      { decisao: 'viavel', motivo: 'Vale consultar: muda o cadastro inteiro.' },
    ])

    const r = await resolverLogicaAlternativaDoJules({
      ...BASE,
      respostaOriginal: 'Use argon2id por enquanto.',
      execute,
    })

    expect(r.tipo).toBe('pronta-para-o-dono')
    if (r.tipo === 'pronta-para-o-dono') {
      expect(r.motivoDaViabilidade).toBe('Vale consultar: muda o cadastro inteiro.')
      expect(r.resumoDaProposta).toBe(BASE.resumoDaProposta)
    }
  })
})

describe('respostaMantendoLogicaOriginal — caminho inviável isolado', () => {
  it('a mensagem ao dev é a MESMA de textoDaRespostaAoDev, o comentário registra o motivo', () => {
    const r = respostaMantendoLogicaOriginal({
      respostaOriginal: 'Use argon2id.',
      motivoDaInviabilidade: 'o ganho não compensa o risco',
    })
    expect(r.mensagemParaODev).toBe(textoDaRespostaAoDev('Use argon2id.'))
    expect(r.comentario).toContain('o ganho não compensa o risco')
    expect(r.comentario).toContain('inviável')
  })
})

describe('dedupKeyDeLogicaAlternativa', () => {
  it('monta "logica-alternativa:<repo>:<issue>"', () => {
    expect(dedupKeyDeLogicaAlternativa('acme/api', 7)).toBe('logica-alternativa:acme/api:7')
  })
})

const CONTEXTO_COMPLETO: ContextoExecutivoDaPergunta = {
  ciclo: 'Sprint 4 (01/09 a 08/09)',
  entrega: 'o cliente consegue redefinir a senha sozinho',
  decisoes: ['usar argon2id para o hash'],
  lacunas: [],
}

describe('textoDaPerguntaSobreLogicaAlternativa / montarPerguntaSobreLogicaAlternativa (formato D73 + D71/D72)', () => {
  it('o texto usa ciclo, entrega e decisões do contexto executivo, mais a proposta e o motivo', () => {
    const texto = textoDaPerguntaSobreLogicaAlternativa({
      issueNumber: 7,
      repository: 'acme/api',
      contexto: CONTEXTO_COMPLETO,
      resumoDaProposta: BASE.resumoDaProposta,
      motivoDaViabilidade: 'o ganho de UX é grande',
    })
    expect(texto).toContain('Sprint 4')
    expect(texto).toContain('redefinir a senha sozinho')
    expect(texto).toContain('argon2id')
    expect(texto).toContain(BASE.resumoDaProposta)
    expect(texto).toContain('o ganho de UX é grande')
    expect(texto).toContain('#7')
    expect(texto).toContain('acme/api')
  })

  it('monta EXATAMENTE as 3 opções objetivas (D71/D72) + dedupKey — o botão de escrever entra à parte', () => {
    const r = montarPerguntaSobreLogicaAlternativa({
      issueNumber: 7,
      repository: 'acme/api',
      contexto: CONTEXTO_COMPLETO,
      resumoDaProposta: BASE.resumoDaProposta,
      motivoDaViabilidade: 'vale a pena',
    })
    expect(r.options).toEqual(OPCOES_DE_LOGICA_ALTERNATIVA)
    expect(r.options).toHaveLength(3)
    expect(r.dedupKey).toBe('logica-alternativa:acme/api:7')
    expect(r.text).toContain(BASE.resumoDaProposta)
  })
})

// DJ-T9, item 3 (viável) — "apenas construa a função/fluxo, com teste
// cobrindo que a função de montagem é chamada corretamente; não dispare
// Telegram real neste dispatch." `ask` abaixo é um FAKE (vi.fn), nunca o
// serviço real de Telegram/agentQuestion — mesmo padrão de
// `aviso-de-custo-da-ordem.test.ts` (perguntarSobreCustoDaOrdem).
describe('perguntarAoDonoSobreLogicaAlternativa — função/fluxo pronta, SEM disparo real (PORTÃO 5B)', () => {
  it('monta o contexto executivo, monta a pergunta e chama ask() com dedupKey + 3 opções + escrever', async () => {
    const montarContextoExecutivo = vi.fn().mockResolvedValue(CONTEXTO_COMPLETO)
    const ask = vi.fn().mockResolvedValue({ deduped: false, question: {} })

    await perguntarAoDonoSobreLogicaAlternativa(
      {
        userId: 'user-1',
        projectId: 'proj-1',
        issueNumber: 7,
        repository: 'acme/api',
        resumoDaProposta: BASE.resumoDaProposta,
        motivoDaViabilidade: 'vale a pena consultar',
        contextoArgs: { projectId: 'proj-1', repository: 'acme/api', issueNumber: 7 },
      },
      {
        agentQuestion: { ask },
        montarContextoExecutivo,
        depsDoContexto: {
          buscarCorpoDaIssue: async () => null,
          prisma: { agentQuestion: { findMany: async () => [] } },
        },
      }
    )

    // A função de montagem do contexto executivo (D73) foi chamada com os
    // args corretos — é o que este teste precisa provar sem tocar em rede.
    expect(montarContextoExecutivo).toHaveBeenCalledOnce()
    expect(montarContextoExecutivo.mock.calls[0]![0]).toEqual({
      projectId: 'proj-1',
      repository: 'acme/api',
      issueNumber: 7,
    })

    expect(ask).toHaveBeenCalledOnce()
    const [userId, projectId, input] = ask.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(userId).toBe('user-1')
    expect(projectId).toBe('proj-1')
    expect(input['dedupKey']).toBe('logica-alternativa:acme/api:7')
    expect(input['text']).toBe(
      textoDaPerguntaSobreLogicaAlternativa({
        issueNumber: 7,
        repository: 'acme/api',
        contexto: CONTEXTO_COMPLETO,
        resumoDaProposta: BASE.resumoDaProposta,
        motivoDaViabilidade: 'vale a pena consultar',
      })
    )
    expect(input['options']).toEqual([
      ...OPCOES_DE_LOGICA_ALTERNATIVA,
      expect.objectContaining({ value: FREE_TEXT_OPTION_VALUE }),
    ])
  })
})

// DJ-T9 (continuação) — GAP fechado: o critério de aceite exige que "em
// produção nenhuma dúvida do dev chega ao dono sem passar por PO+RA com
// viabilidade registrada", mas `resolverLogicaAlternativaDoJules` não era
// chamado de lugar nenhum. `decidirDestinoAposLogicaAlternativa` é o degrau
// que `scheduler.ts` chama logo após `runDuvidaMissionViaRails`, ANTES de
// decidir o destino final — este describe prova os dois ramos exigidos:
// `mudaCenarioDeNegocio=false` idêntico a antes (zero chamada extra) e
// `mudaCenarioDeNegocio=true` com o desfecho do PO+RA decidindo o caminho.
describe('decidirDestinoAposLogicaAlternativa — liga mudaCenarioDeNegocio à viabilidade PO+RA (DJ-T9)', () => {
  const ARGS_COMUNS = {
    pergunta: BASE.pergunta,
    repository: BASE.repository,
    issueNumber: BASE.issueNumber,
    contextBlocks: BASE.contextBlocks,
  }

  function resultadoBase(
    overrides: Partial<DuvidaRailsMissionResult> = {}
  ): DuvidaRailsMissionResult {
    return {
      destino: { tipo: 'responder-o-dev', resposta: 'Use argon2id, já está em src/lib/hash.ts.' },
      mensagemParaODev: textoDaRespostaAoDev('Use argon2id, já está em src/lib/hash.ts.'),
      mudaCenarioDeNegocio: false,
      resumoDaProposta: null,
      ...overrides,
    }
  }

  it('mudaCenarioDeNegocio=false: fluxo IDÊNTICO ao de antes desta tarefa — nenhuma chamada extra ao resolver', async () => {
    const resultadoDaDuvida = resultadoBase()
    const resolver = vi.fn()
    const execute = vi.fn()

    const r = await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute,
      resolver,
    })

    expect(r).toEqual({
      destino: resultadoDaDuvida.destino,
      mensagemParaODev: resultadoDaDuvida.mensagemParaODev,
    })
    expect(resolver).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('mudaCenarioDeNegocio=false (default, campo ausente): mesmo comportamento — idêntico ao caso explícito', async () => {
    const resultadoDaDuvida = resultadoBase({
      destino: { tipo: 'escalar-ao-ra', motivo: 'o QA não conseguiu responder' },
      mensagemParaODev: null,
    })
    const resolver = vi.fn()

    const r = await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute: vi.fn(),
      resolver,
    })

    expect(r).toEqual({ destino: resultadoDaDuvida.destino, mensagemParaODev: null })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('mudaCenarioDeNegocio=true, INVIÁVEL: o resolver é chamado com a resposta original do destino, e o destino final NUNCA vira perguntar-ao-dono', async () => {
    const resultadoDaDuvida = resultadoBase({
      mudaCenarioDeNegocio: true,
      resumoDaProposta: BASE.resumoDaProposta,
    })
    const desfechoInviavel: ResultadoDaLogicaAlternativa = {
      tipo: 'mantida-logica-original',
      mensagemParaODev: 'GitOrch: mantida a lógica original (inviável).',
      comentario: 'GitOrch: lógica alternativa avaliada e considerada inviável.',
    }
    const resolver = vi.fn().mockResolvedValue(desfechoInviavel)
    const execute = vi.fn()

    const r = await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute,
      resolver,
    })

    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver.mock.calls[0]![0]).toEqual({
      resumoDaProposta: BASE.resumoDaProposta,
      pergunta: BASE.pergunta,
      repository: BASE.repository,
      issueNumber: BASE.issueNumber,
      execute,
      contextBlocks: BASE.contextBlocks,
      respostaOriginal: 'Use argon2id, já está em src/lib/hash.ts.',
    })

    // Nunca chega em perguntar-ao-dono — o destino segue 'responder-o-dev',
    // e a mensagem final é a que o resolver decidiu (mantendo a lógica
    // original), nunca a antiga sem passar pela viabilidade.
    expect(r.destino).toEqual(resultadoDaDuvida.destino)
    expect(r.mensagemParaODev).toBe('GitOrch: mantida a lógica original (inviável).')
  })

  it('mudaCenarioDeNegocio=true, VIÁVEL: o destino final vira logica-alternativa-viavel — NUNCA perguntar-ao-dono (D75 amarra aquele tipo a escalarDuvidaAoDono, que nunca pergunta de verdade) — mensagemParaODev nulo', async () => {
    const resultadoDaDuvida = resultadoBase({
      mudaCenarioDeNegocio: true,
      resumoDaProposta: BASE.resumoDaProposta,
    })
    const desfechoViavel: ResultadoDaLogicaAlternativa = {
      tipo: 'pronta-para-o-dono',
      motivoDaViabilidade: 'Vale consultar: muda o cadastro inteiro.',
      resumoDaProposta: BASE.resumoDaProposta,
    }
    const resolver = vi.fn().mockResolvedValue(desfechoViavel)

    const r = await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute: vi.fn(),
      resolver,
    })

    // DJ-T9, achado do QA: NUNCA 'perguntar-ao-dono' — esse tipo está
    // amarrado, em scheduler.ts, a escalarDuvidaAoDono (D75, nunca pergunta
    // de verdade). O tipo distinto é o único roteado para
    // perguntarAoDonoSobreLogicaAlternativa (agentQuestion.ask real).
    expect(r.destino.tipo).toBe('logica-alternativa-viavel')
    expect(r.destino.tipo).not.toBe('perguntar-ao-dono')
    if (r.destino.tipo === 'logica-alternativa-viavel') {
      expect(r.destino.motivo).toContain('Vale consultar: muda o cadastro inteiro.')
      // resumoDaProposta e motivoDaViabilidade viajam SEPARADOS (não só
      // dentro de `motivo`) — textoDaPerguntaSobreLogicaAlternativa precisa
      // dos dois em frases distintas.
      expect(r.destino.resumoDaProposta).toBe(BASE.resumoDaProposta)
      expect(r.destino.motivoDaViabilidade).toBe('Vale consultar: muda o cadastro inteiro.')
    }
    expect(r.mensagemParaODev).toBeNull()
  })

  it('mudaCenarioDeNegocio=true mas destino original NÃO é responder-o-dev: respostaOriginal vai vazia (nunca inventa texto)', async () => {
    const resultadoDaDuvida = resultadoBase({
      destino: { tipo: 'perguntar-ao-dono', motivo: 'é decisão de negócio' },
      mensagemParaODev: null,
      mudaCenarioDeNegocio: true,
      resumoDaProposta: BASE.resumoDaProposta,
    })
    const resolver = vi.fn().mockResolvedValue({
      tipo: 'mantida-logica-original',
      mensagemParaODev: 'irrelevante para este teste',
      comentario: 'irrelevante',
    } satisfies ResultadoDaLogicaAlternativa)

    await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute: vi.fn(),
      resolver,
    })

    expect(resolver.mock.calls[0]![0]).toMatchObject({ respostaOriginal: '' })
  })

  it('resolver não passado: usa o resolverLogicaAlternativaDoJules real por padrão (produção nunca precisa injetar)', async () => {
    const resultadoDaDuvida = resultadoBase({
      mudaCenarioDeNegocio: true,
      resumoDaProposta: BASE.resumoDaProposta,
    })
    const execute = executeSequencial([
      RESPOSTA_ORA_RA,
      { decisao: 'inviavel', motivo: 'mantém como está' },
    ])

    const r = await decidirDestinoAposLogicaAlternativa({
      ...ARGS_COMUNS,
      resultadoDaDuvida,
      execute,
    })

    // Sem resolver injetado, o caminho real rodou (RA + PO = 2 chamadas de
    // execute) e chegou ao mesmo desfecho inviável.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(r.destino).toEqual(resultadoDaDuvida.destino)
  })

  // DJ-T4/D75, mesmo raciocínio de avaliarViabilidadeDaLogicaAlternativa:
  // sem cota disponível, a exceção sobe intacta — nunca vira um desfecho
  // decidido, para o MESMO failover de scheduler.ts assumir.
  it('sem cota disponível: a exceção do resolver sobe intacta, nunca vira destino decidido', async () => {
    const resultadoDaDuvida = resultadoBase({
      mudaCenarioDeNegocio: true,
      resumoDaProposta: BASE.resumoDaProposta,
    })
    const erroDeCota = new Error('usage limit reached')
    const resolver = vi.fn().mockRejectedValue(erroDeCota)

    await expect(
      decidirDestinoAposLogicaAlternativa({
        ...ARGS_COMUNS,
        resultadoDaDuvida,
        execute: vi.fn(),
        resolver,
      })
    ).rejects.toThrow(erroDeCota)
  })
})

// DJ-T9, achado do QA (14/09): `decidirDestinoAposLogicaAlternativa` já
// devolvia o destino certo, mas NADA em produção decidia, a partir dele,
// entre o caminho NOVO (agentQuestion.ask real, via
// perguntarAoDonoSobreLogicaAlternativa) e o caminho ANTIGO
// (escalarDuvidaAoDono, D75 — nunca pergunta de verdade). Sem essa peça,
// scheduler.ts continuava mandando TUDO para escalarDuvidaAoDono, e a
// pergunta em formato executivo nunca era enviada — o próprio defeito
// confirmado pelo QA.
//
// `perguntarAoDonoSeLogicaAlternativaViavel` é essa peça, extraída (MESMO
// padrão de `escalar-duvida-ao-dono.ts`/`suporDuvidaPendenteService`) para
// ser testável sem a máquina de missão/motor: `scheduler.ts` só faz o
// wiring real (agentQuestionService, prisma, GitHub) e chama esta função
// ANTES do roteamento antigo — devolve `true` quando ela tratou o destino
// (chamou o caminho novo, ou avisou/registrou por não ter como enviar),
// `false` quando o destino NÃO é 'logica-alternativa-viavel' — sinal para
// quem chama seguir para o caminho antigo (escalarDuvidaAoDono), inalterado.
describe('perguntarAoDonoSeLogicaAlternativaViavel — o ÚNICO ponto que decide entre agentQuestion.ask real e o caminho antigo (DJ-T9, achado do QA)', () => {
  const DESTINO_VIAVEL: DestinoDaDuvida = {
    tipo: 'logica-alternativa-viavel',
    motivo: 'o time encontrou uma lógica alternativa avaliada como viável pelo PO+RA: vale a pena',
    resumoDaProposta: BASE.resumoDaProposta,
    motivoDaViabilidade: 'vale a pena consultar',
  }

  function depsBase() {
    return {
      agentQuestion: { ask: vi.fn().mockResolvedValue({ deduped: false, question: {} }) },
      montarContextoExecutivo: vi.fn().mockResolvedValue(CONTEXTO_COMPLETO),
      depsDoContexto: {
        buscarCorpoDaIssue: async () => null,
        prisma: { agentQuestion: { findMany: async () => [] } },
      },
      onWarn: vi.fn(),
    }
  }

  // Regressão explícita, item 5 da tarefa: qualquer destino que NÃO seja
  // 'logica-alternativa-viavel' — inclusive o antigo 'perguntar-ao-dono' de
  // dúvida técnica comum (D75, sem lógica alternativa) — devolve `false` SEM
  // tocar em agentQuestion.ask nenhuma vez. Quem chama (scheduler.ts) segue,
  // sem mudança nenhuma, para escalarDuvidaAoDono — exatamente como antes
  // desta tarefa.
  it('destino é o antigo perguntar-ao-dono (dúvida técnica comum, sem lógica alternativa): devolve false, NUNCA chama agentQuestion.ask (regressão)', async () => {
    const deps = depsBase()
    const destinoAntigo: DestinoDaDuvida = {
      tipo: 'perguntar-ao-dono',
      motivo: 'é decisão de negócio, e decisão de negócio é do dono',
    }

    const tratado = await perguntarAoDonoSeLogicaAlternativaViavel(
      {
        destino: destinoAntigo,
        projectId: 'proj-1',
        repository: 'acme/api',
        issueNumber: 7,
        userId: 'user-1',
      },
      deps
    )

    expect(tratado).toBe(false)
    expect(deps.agentQuestion.ask).not.toHaveBeenCalled()
    expect(deps.montarContextoExecutivo).not.toHaveBeenCalled()
    expect(deps.onWarn).not.toHaveBeenCalled()
  })

  it('destino escalar-ao-ra ou responder-o-dev: devolve false sem tocar em nada', async () => {
    const deps = depsBase()
    const destinos: DestinoDaDuvida[] = [
      { tipo: 'escalar-ao-ra', motivo: 'o QA não conseguiu responder' },
      { tipo: 'responder-o-dev', resposta: 'Use argon2id, já está em src/lib/hash.ts.' },
    ]

    for (const destino of destinos) {
      const tratado = await perguntarAoDonoSeLogicaAlternativaViavel(
        { destino, projectId: 'proj-1', repository: 'acme/api', issueNumber: 7, userId: 'user-1' },
        deps
      )
      expect(tratado).toBe(false)
    }
    expect(deps.agentQuestion.ask).not.toHaveBeenCalled()
  })

  it('destino VIÁVEL, com agentQuestionService e userId: chama perguntarAoDonoSobreLogicaAlternativa/agentQuestion.ask com o contexto certo (userId, projectId, dedupKey, texto) e devolve true', async () => {
    const deps = depsBase()

    const tratado = await perguntarAoDonoSeLogicaAlternativaViavel(
      {
        destino: DESTINO_VIAVEL,
        projectId: 'proj-1',
        repository: 'acme/api',
        issueNumber: 7,
        userId: 'user-1',
      },
      deps
    )

    expect(tratado).toBe(true)
    expect(deps.montarContextoExecutivo).toHaveBeenCalledWith(
      { projectId: 'proj-1', repository: 'acme/api', issueNumber: 7 },
      deps.depsDoContexto
    )
    expect(deps.agentQuestion.ask).toHaveBeenCalledOnce()
    const [userId, projectId, input] = deps.agentQuestion.ask.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(userId).toBe('user-1')
    expect(projectId).toBe('proj-1')
    expect(input['dedupKey']).toBe('logica-alternativa:acme/api:7')
    expect(input['text']).toContain(BASE.resumoDaProposta)
    expect(input['text']).toContain('vale a pena consultar')
    expect(deps.onWarn).not.toHaveBeenCalled()
  })

  it('destino VIÁVEL, SEM agentQuestionService (bot desligado/teste): não lança, avisa e devolve true — nunca cai em escalarDuvidaAoDono (contrato incompatível, D75)', async () => {
    const deps = depsBase()

    const tratado = await perguntarAoDonoSeLogicaAlternativaViavel(
      {
        destino: DESTINO_VIAVEL,
        projectId: 'proj-1',
        repository: 'acme/api',
        issueNumber: 7,
        userId: 'user-1',
      },
      { ...deps, agentQuestion: undefined }
    )

    expect(tratado).toBe(true)
    expect(deps.onWarn).toHaveBeenCalledOnce()
    expect(deps.montarContextoExecutivo).not.toHaveBeenCalled()
  })

  it('destino VIÁVEL, SEM userId no projeto: não lança, avisa e devolve true', async () => {
    const deps = depsBase()

    const tratado = await perguntarAoDonoSeLogicaAlternativaViavel(
      {
        destino: DESTINO_VIAVEL,
        projectId: 'proj-1',
        repository: 'acme/api',
        issueNumber: 7,
        userId: null,
      },
      deps
    )

    expect(tratado).toBe(true)
    expect(deps.onWarn).toHaveBeenCalledOnce()
    expect(deps.agentQuestion.ask).not.toHaveBeenCalled()
  })
})
