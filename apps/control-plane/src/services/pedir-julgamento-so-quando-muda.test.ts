import { describe, expect, it, vi } from 'vitest'
import { vigiarSessoes } from './session-watch.js'
import type { LinhaDeSessao } from './dev-session-store.js'

// POR QUE ESTE ARQUIVO EXISTE — o laço que mais machuca a esteira.
//
// MEDIDO no banco em 23/08/2026, quebrando por ORIGEM (foi essa quebra que
// mostrou que eram dois problemas, e não um):
//
//   vigia            48 acordadas | 48 vazias  → 100%
//   fila-do-sm       25           | 25         → 100%
//   aviso-do-github  34           | 26         →  76%
//
// E o motivo que as vazias devolvem: "QA: no delegated PR awaiting judgment",
// 140 vezes só pela vigília em dois dias.
//
// A CAUSA: a vigília pedia julgamento para TODA sessão viva que já tem pull
// request, a cada dez minutos, e a sessão só fecha quando a publicação é
// confirmada. Uma entrega já julgada continuava pedindo julgamento PARA
// SEMPRE — sem nunca consultar se havia o que julgar.
//
// O DESCANSO NÃO ESTAVA QUEBRADO: `descanso-apos-vazia.ts` disparou 73 vezes
// naquele mesmo dia, exatamente como desenhado. Ele segurava o que foi feito
// para segurar; o que ninguém tinha atacado era a raiz — PERGUNTAR sem saber
// se há resposta.
//
// A GUARDA CONTRA O EXCESSO: julgar de menos é pior que acordar em falso. Por
// isso o pedido não é removido, só deixa de repetir sem motivo — e continuam
// existindo TRÊS outros caminhos que acordam o julgamento quando algo de fato
// acontece: o aviso do GitHub, a fila do SM e a agenda própria do QA.

function linha(over: Partial<LinhaDeSessao> = {}): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'p',
    issueNumber: 1,
    sessionName: 'sessions/1',
    state: 'IN_PROGRESS',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
    ...over,
  } as LinhaDeSessao
}

function deps(over: Record<string, unknown> = {}) {
  return {
    consultarSessao: vi.fn(async () => ({
      estado: 'COMPLETED',
      numeroDoPr: 77,
      ultimaAtualizacao: null,
    })),
    ultimaMensagem: vi.fn(async () => ''),
    aprovarPlano: vi.fn(async () => true),
    pedirParaContinuar: vi.fn(async () => true),
    dispararMissao: vi.fn(async () => undefined),
    registrarEstado: vi.fn(async () => undefined),
    registrarResposta: vi.fn(async () => undefined),
    registrarPr: vi.fn(async () => undefined),
    fecharSessao: vi.fn(async () => undefined),
    registrarInvestigacao: vi.fn(async () => undefined),
    agora: new Date('2026-08-23T12:00:00Z'),
    ...over,
  }
}

describe('a vigília para de pedir julgamento às cegas', () => {
  it('PRIMEIRA vez que vê o pull request: PEDE julgamento', async () => {
    // A ligação nasce aqui. Não pedir seria deixar a entrega sem parecer, que
    // é o desfecho pior de todos.
    const d = deps()
    await vigiarSessoes({ sessoes: [linha({ pullRequestNumber: null })], ...d } as never)
    expect(d.registrarPr).toHaveBeenCalledOnce()
    expect(d.dispararMissao).toHaveBeenCalledWith('qa', 'p')
  })

  it('MESMO pull request, nada mudou: NÃO pede de novo', async () => {
    // Este é o conserto. Antes, esta linha pedia julgamento a cada dez minutos
    // até a publicação ser confirmada — 140 acordadas vazias em dois dias.
    const d = deps()
    await vigiarSessoes({ sessoes: [linha({ pullRequestNumber: 77 })], ...d } as never)
    expect(d.dispararMissao).not.toHaveBeenCalledWith('qa', 'p')
  })

  it('pull request NOVO na mesma sessão: pede de novo', async () => {
    // O dev abriu outra entrega. Isso é informação nova e merece julgamento.
    const d = deps()
    await vigiarSessoes({ sessoes: [linha({ pullRequestNumber: 12 })], ...d } as never)
    expect(d.dispararMissao).toHaveBeenCalledWith('qa', 'p')
  })

  it('mesmo sem pedir, a cadência AVANÇA — senão vira reexame a cada minuto', async () => {
    // A armadilha que este projeto já pisou antes: parar de agir sem carimbar
    // o exame faz a sessão ser reexaminada a cada tique do relógio, um minuto,
    // trocando um laço de dez minutos por um de um.
    const d = deps()
    await vigiarSessoes({ sessoes: [linha({ pullRequestNumber: 77 })], ...d } as never)
    expect(d.registrarEstado).toHaveBeenCalled()
  })
})
