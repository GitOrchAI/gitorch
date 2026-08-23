import { describe, expect, it } from 'vitest'
import { montarPedidoAoDev } from './pedido-ao-dev.js'

// POR QUE ESTE ARQUIVO EXISTE — o caso medido do PR #157.
//
// A issue #151 listava QUATRO passos no Implementation Guide. O dev entregou
// TRÊS: criou a função e o decorador, e não fez a integração no fluxo de
// execução — justamente o passo que fazia a entrega servir para alguma coisa.
// O QA pegou em cinco minutos. Depois disso a sessão ficou 44 HORAS parada,
// sem responder e sem dizer que estava travada.
//
// O pedido que o produto mandava era o corpo bruto da issue mais duas frases
// genéricas. Não repetia os passos, não pedia conferência item a item antes de
// abrir a entrega, e não dizia o que fazer ao travar. Nos números: 68% das
// sessões precisaram de pelo menos um empurrão e 36% das que fecharam foram
// abandonadas.
//
// Este módulo é PURO: recebe a issue e devolve o texto. Sem rede, sem banco.

const ISSUE_REAL = {
  numero: 151,
  repositorio: 'GitOrchAI/gitorch',
  titulo: 'Mapear metadados de erro na pipeline',
  corpo: `## Goal

Estruturar o metadado de erro.

## Implementation Guide

1. Em pipeline-check.ts, crie uma interface para o metadado estruturado.
2. Crie uma função que receba o erro bruto e devolva o metadado preenchido.
3. Em telemetry.ts, modifique a assinatura de registro de falhas.
4. Certifique-se de que eventos de erro despacham essa informação no barramento.

## Verification Criteria

1. Forçar uma falha em um pipeline de teste localmente.
2. Conferir que o evento carrega o metadado.

## Related Files

apps/control-plane/src/config/pipeline-check.ts`,
}

describe('montarPedidoAoDev', () => {
  it('mantém o corpo inteiro da issue — nada do que o PO escreveu se perde', () => {
    const p = montarPedidoAoDev(ISSUE_REAL)
    expect(p).toContain('Em pipeline-check.ts, crie uma interface')
    expect(p).toContain('Forçar uma falha em um pipeline de teste')
  })

  it('REPETE os passos do Implementation Guide como lista de conferência', () => {
    // O conserto do #157: o dev tem que ver os quatro passos de novo, no fim,
    // como coisas a marcar — não só uma vez, no meio do texto.
    const p = montarPedidoAoDev(ISSUE_REAL)
    const depoisDoCorpo = p.slice(p.indexOf('Verification Criteria') + 30)
    expect(depoisDoCorpo).toContain('1.')
    expect(depoisDoCorpo).toContain('4.')
    expect(depoisDoCorpo.toLowerCase()).toMatch(/checklist|confer|verify|check each/i)
  })

  it('pede conferência item a item ANTES de abrir a entrega', () => {
    const p = montarPedidoAoDev(ISSUE_REAL)
    expect(p.toLowerCase()).toMatch(/before opening|antes de abrir/i)
  })

  it('diz o que fazer ao TRAVAR — o silêncio de 44 horas é o defeito', () => {
    // A sessão do #157 ficou parada quase dois dias sem dizer nada. Um agente
    // que não sabe o que fazer quando trava simplesmente para, e ninguém
    // descobre até alguém olhar.
    const p = montarPedidoAoDev(ISSUE_REAL)
    expect(p.toLowerCase()).toMatch(/stuck|blocked|travad/i)
    expect(p.toLowerCase()).toMatch(/say so|do not stop silently|não pare em silêncio/i)
  })

  it('issue SEM Implementation Guide não ganha lista vazia', () => {
    // Uma lista de conferência com zero itens é pior que nenhuma: ensina o
    // agente a ignorar a seção.
    const p = montarPedidoAoDev({
      numero: 9,
      repositorio: 'o/r',
      titulo: 'Sem guia',
      corpo: '## Goal\n\nFazer algo.',
    })
    expect(p).toContain('Fazer algo')
    expect(p.toLowerCase()).not.toMatch(/checklist of the numbered steps/i)
  })

  it('corpo vazio não quebra e ainda diz o essencial', () => {
    const p = montarPedidoAoDev({ numero: 9, repositorio: 'o/r', titulo: 't', corpo: '' })
    expect(p).toContain('#9')
    expect(p).toContain('o/r')
    expect(p.toLowerCase()).toMatch(/stuck|blocked/i)
  })

  it('não muda nada fora do escopo — a regra que já existia continua', () => {
    const p = montarPedidoAoDev(ISSUE_REAL)
    expect(p.toLowerCase()).toMatch(/do not change anything outside/i)
  })

  it('passo escrito com hífen também vira item da conferência', () => {
    // O PO nem sempre numera. Ignorar a forma de lista deixaria metade das
    // issues sem conferência nenhuma.
    const p = montarPedidoAoDev({
      numero: 1,
      repositorio: 'o/r',
      titulo: 't',
      corpo: '## Implementation Guide\n\n- Primeiro passo\n- Segundo passo\n',
    })
    expect(p).toContain('Primeiro passo')
    expect(p.toLowerCase()).toMatch(/checklist/i)
  })
})
