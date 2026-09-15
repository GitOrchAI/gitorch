import { describe, it, expect } from 'vitest'
import {
  montarMensagemDeStakeholder,
  type DesejoParaMensagemDeStakeholder,
  type OpcaoDeMensagemDeStakeholder,
} from './mensagem-de-stakeholder.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'

// D76b (T10) — o dono ditou o modelo EXATO da mensagem que quer receber
// quando a equipe topa com um desejo de prioridade baixa enquanto o pedido
// P0 dele ainda tem uma fila grande pela frente:
//
//   "Fulano, a equipe está com o desejo X onde você deixou prioridade 3;
//    é 1 épico com 1 feature, pouco esforço; o seu pedido Y (P0) tem
//    10 fases, 15 épicos, ~200 tarefas, 10 sprints; posso colocar X na
//    próxima sprint?"
//
// "Regra da amostra": 1 exemplo dele é amostra de uma regra geral, não uma
// lista completa — os testes abaixo cobrem a generalização (N desejos,
// prioridade/sprints ausentes), não uma cópia literal da frase dele.
//
// Achado de QA (2ª rejeição, T10) — `opcoes` é parâmetro OBRIGATÓRIO desde a
// correção: esta função não tem mais um rodapé fixo próprio (era a causa do
// defeito — texto com opções que não batiam com os botões reais do
// chamador). Os testes abaixo usam uma lista de exemplo (`OPCOES_DE_TESTE`)
// só para provar o comportamento de MONTAGEM do rodapé a partir do que foi
// passado — o teste de alinhamento com os botões REAIS de produção mora em
// `aviso-de-custo-da-ordem.test.ts` (o único chamador real).

const OPCOES_DE_TESTE: OpcaoDeMensagemDeStakeholder[] = [
  { label: 'Sim, priorizar o desejo agora', value: 'sim-priorizar' },
  { label: 'Não, manter a prioridade atual', value: 'manter-prioridade-atual' },
  { label: 'Quero ver mais detalhes antes', value: 'quero-mais-detalhes' },
  { label: 'Vou escrever', value: FREE_TEXT_OPTION_VALUE },
]

const X: DesejoParaMensagemDeStakeholder = {
  titulo: 'lembrete de pagamento por e-mail',
  prioridade: 3,
  fases: 0,
  epicos: 1,
  features: 1,
  tarefas: 0,
  sprintsEstimadas: null,
}

const Y: DesejoParaMensagemDeStakeholder = {
  titulo: 'motor de recomendação',
  prioridade: 0,
  fases: 10,
  epicos: 15,
  features: 40,
  tarefas: 200,
  sprintsEstimadas: 10,
}

const PROPOSTA = 'Posso colocar "lembrete de pagamento por e-mail" na próxima sprint?'

describe('montarMensagemDeStakeholder — o texto exato que o dono ditou (D76b)', () => {
  it('cita o dono, os dois desejos PELO NOME, a prioridade e o tamanho real de cada um', () => {
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X, Y],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })

    expect(texto).toContain('Guilherme,')
    expect(texto).toContain('lembrete de pagamento por e-mail')
    expect(texto).toContain('motor de recomendação')
    expect(texto).toContain('prioridade 3')
    expect(texto).toContain('prioridade 0')
    expect(texto).toContain('1 épico')
    expect(texto).toContain('1 feature')
    expect(texto).toContain('10 fases')
    expect(texto).toContain('15 épicos')
    expect(texto).toContain('200 tarefas')
    expect(texto).toContain('10 sprints')
    expect(texto).toContain(PROPOSTA)
  })

  it('nunca fala em "pontos de peso" — a mensagem de stakeholder é em tamanho real, não em jargão', () => {
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X, Y],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto.toLowerCase()).not.toContain('ponto de peso')
    expect(texto.toLowerCase()).not.toContain('pontos de peso')
  })

  it('termina com as opções passadas por quem chama, numeradas nesta ordem — nunca um rodapé fixo próprio', () => {
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    const linhas = texto.trim().split('\n')
    expect(linhas.slice(-4)).toEqual([
      '1. Sim, priorizar o desejo agora',
      '2. Não, manter a prioridade atual',
      '3. Quero ver mais detalhes antes',
      '4. Vou escrever',
    ])
  })

  it('opções DIFERENTES do chamador viram um rodapé DIFERENTE — prova que não há valor fixo aqui dentro', () => {
    const outrasOpcoes: OpcaoDeMensagemDeStakeholder[] = [
      { label: 'Aplicar a troca sugerida', value: 'aplicar' },
      { label: 'Manter minha ordem', value: 'manter' },
    ]
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X],
      proposta: PROPOSTA,
      opcoes: outrasOpcoes,
    })
    const linhas = texto.trim().split('\n')
    expect(linhas.slice(-2)).toEqual(['1. Aplicar a troca sugerida', '2. Manter minha ordem'])
    expect(texto).not.toContain('Sim, priorizar o desejo agora')
  })

  it('lista vazia de opções: lança, nunca monta um rodapé vazio', () => {
    expect(() =>
      montarMensagemDeStakeholder({
        dono: 'Guilherme',
        desejos: [X],
        proposta: PROPOSTA,
        opcoes: [],
      })
    ).toThrow(/opção/i)
  })
})

describe('montarMensagemDeStakeholder — prioridade ausente: nunca inventa número', () => {
  it('desejo sem prioridade registrada diz isso em português, nunca um número', () => {
    const semPrioridade: DesejoParaMensagemDeStakeholder = { ...X, prioridade: null }
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [semPrioridade],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto).toContain('prioridade não registrada')
    expect(texto).not.toMatch(/prioridade \d/)
  })
})

describe('montarMensagemDeStakeholder — sprints ausentes: nunca inventa número', () => {
  it('desejo sem sprints estimadas diz isso em português, nunca um número', () => {
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto).toContain('sprints não estimadas')
  })

  it('desejo COM sprints estimadas cita o número, no singular quando é 1', () => {
    const umaSprint: DesejoParaMensagemDeStakeholder = { ...Y, sprintsEstimadas: 1 }
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [umaSprint],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto).toContain('1 sprint estimada')
    expect(texto).not.toContain('1 sprints')
  })
})

describe('montarMensagemDeStakeholder — múltiplos desejos', () => {
  it('3 desejos: o primeiro abre a frase, os demais entram como "o seu pedido ..."', () => {
    const Z: DesejoParaMensagemDeStakeholder = {
      titulo: 'exportar relatório em PDF',
      prioridade: 2,
      fases: 1,
      epicos: 2,
      features: 3,
      tarefas: 9,
      sprintsEstimadas: 2,
    }
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X, Y, Z],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto).toContain('lembrete de pagamento por e-mail')
    expect(texto).toContain('motor de recomendação')
    expect(texto).toContain('exportar relatório em PDF')
    // Cada pedido além do primeiro é citado como "o seu pedido <nome>".
    expect(texto).toContain('o seu pedido motor de recomendação')
    expect(texto).toContain('o seu pedido exportar relatório em PDF')
  })

  it('1 desejo só: nenhuma frase de "o seu pedido" aparece', () => {
    const texto = montarMensagemDeStakeholder({
      dono: 'Guilherme',
      desejos: [X],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto).not.toContain('o seu pedido')
  })

  it('lista vazia de desejos: lança, nunca monta uma mensagem vazia', () => {
    expect(() =>
      montarMensagemDeStakeholder({
        dono: 'Guilherme',
        desejos: [],
        proposta: PROPOSTA,
        opcoes: OPCOES_DE_TESTE,
      })
    ).toThrow(/desejo/i)
  })
})

describe('montarMensagemDeStakeholder — sem nome do dono', () => {
  it('dono vazio: abre sem vírgula solta nem nome inventado', () => {
    const texto = montarMensagemDeStakeholder({
      dono: '',
      desejos: [X],
      proposta: PROPOSTA,
      opcoes: OPCOES_DE_TESTE,
    })
    expect(texto.startsWith('A equipe está com o desejo')).toBe(true)
  })
})
