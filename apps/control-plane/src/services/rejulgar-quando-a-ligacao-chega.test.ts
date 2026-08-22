import { describe, expect, it } from 'vitest'
import {
  ehParecerSemPoderDeMesclar,
  MARCA_DE_APROVACAO,
  MARCA_DO_PARECER,
  MARCA_SEM_PODER_DE_MESCLAR,
  AVISO_LEGADO_DE_NAO_MESCLAR,
} from './parecer-do-qa.js'

// POR QUE ESTE ARQUIVO EXISTE — o beco sem saída da janela cega.
//
// Entre a abertura do PR e a gravação da ligação issue↔sessão havia uma
// janela de seis horas e meia (medida em 20/08/2026, PR #132). Dentro dela o
// julgamento acordava, não encontrava a linha, e concluía que a entrega era
// obra de terceiro: o parecer saía como COMENTÁRIO em vez de aprovação
// formal, levando junto a frase "esta entrega não foi encomendada pelo
// produto" — escrita no pull request do CLIENTE, sobre um trabalho que o
// produto tinha encomendado.
//
// O reconhecimento agora chega em quatro segundos (PR #157), então a janela
// quase não existe mais. QUASE não é nunca, e o estrago do "quase" é
// PERMANENTE: o laço de descoberta trata "já existe review nossa neste head"
// como julgado e pula para sempre. O PR fica aberto, com CI verde, esperando
// uma aprovação formal que nunca vem, porque o produto acha que já opinou.
//
// A saída é reconhecer que aquele parecer foi emitido sob premissa errada.
// Para isso é preciso distinguir "parecer de quem não podia mesclar" de
// "parecer de quem podia" — e essa distinção tem que estar no corpo da
// review, não na memória do processo, porque quem lê é um ciclo futuro.

const corpoDeAprovacaoDelegada = `${MARCA_DO_PARECER}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met, CI green.\n\nObjetivo qualquer.`

describe('ehParecerSemPoderDeMesclar', () => {
  it('reconhece o parecer marcado como sem poder de mesclar', () => {
    const corpo = `${MARCA_DO_PARECER}\n${MARCA_SEM_PODER_DE_MESCLAR}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met.`
    expect(ehParecerSemPoderDeMesclar({ body: corpo })).toBe(true)
  })

  it('o parecer de uma entrega DELEGADA não é confundido com ele', () => {
    expect(ehParecerSemPoderDeMesclar({ body: corpoDeAprovacaoDelegada })).toBe(false)
  })

  it('LEGADO: reconhece pela frase publicada, para os PRs que já levaram parecer', () => {
    // Os pareceres emitidos ANTES desta mudança não têm marcador nenhum — só
    // a frase em português que foi publicada no pull request do cliente.
    // Ignorá-los deixaria exatamente os PRs que motivaram esta tarefa presos
    // no beco sem saída, que é o oposto do conserto. A frase é estável e
    // distintiva; some sozinha conforme esses PRs são fechados.
    const corpoAntigo =
      `${MARCA_DO_PARECER}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met, CI green.\n\n` +
      `Objetivo qualquer.\n\n${AVISO_LEGADO_DE_NAO_MESCLAR}`
    expect(ehParecerSemPoderDeMesclar({ body: corpoAntigo })).toBe(true)
  })

  it('review inexistente ou sem corpo não é parecer de nada', () => {
    expect(ehParecerSemPoderDeMesclar(undefined)).toBe(false)
    expect(ehParecerSemPoderDeMesclar({})).toBe(false)
  })

  it('comentário de humano que cite a frase por acaso não passa sem a nossa marca', () => {
    // Sem esta guarda, alguém colando o texto do parecer num comentário faria
    // o produto tratar a opinião de um terceiro como parecer seu.
    expect(ehParecerSemPoderDeMesclar({ body: AVISO_LEGADO_DE_NAO_MESCLAR })).toBe(false)
  })
})
