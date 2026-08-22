import { describe, expect, test } from 'vitest'
import { sessoesParaVigiaPreMerge } from './scheduler.js'
import type { LinhaDeSessao } from '../services/dev-session-store.js'

// Tarefa 19 (defeito confirmado): `sessoesVivas` (dev-session-store.ts) só
// filtra por `closedAt: null` — de propósito, porque `montarOpcoesDeDelegacao`
// (o OUTRO chamador, na fila de delegação do SM) precisa contar sessão já
// mesclada como ocupada, senão o SM re-delegaria a mesma issue enquanto o
// veredito de publicação (Tarefa 17, `varrerPublicacoes`) ainda está em
// aberto. Quem tem que parar de olhar para uma sessão mesclada é só a vigia
// PRÉ-merge (`varrerSessoesDoDev`/`vigiarSessoes`) — e é esse filtro que este
// arquivo prova, isolado do banco e do Fastify (ver
// scheduler-filtro-julgamento.test.ts para o mesmo padrão de extração).

function linha(overrides: Partial<LinhaDeSessao> = {}): LinhaDeSessao {
  return {
    id: 'sessao-x',
    projectId: 'projeto-1',
    issueNumber: 24,
    sessionName: 'sessions/x',
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
    ...overrides,
  }
}

describe('sessoesParaVigiaPreMerge', () => {
  test('exclui sessão com mergeCommitSha gravado — a partir do merge ela é propriedade de varrerPublicacoes', () => {
    const mesclada = linha({ sessionName: 'sessions/mesclada', mergeCommitSha: 'deadbeef' })

    expect(sessoesParaVigiaPreMerge([mesclada])).toEqual([])
  })

  test('mantém sessão sem mergeCommitSha — o caminho normal, pré-merge, não regride', () => {
    const aberta = linha({ sessionName: 'sessions/aberta', mergeCommitSha: null })

    expect(sessoesParaVigiaPreMerge([aberta])).toEqual([aberta])
  })

  test('lista mista: só a mesclada sai, a aberta continua na frente da vigia', () => {
    const aberta = linha({ sessionName: 'sessions/aberta', mergeCommitSha: null })
    const mesclada = linha({ sessionName: 'sessions/mesclada', mergeCommitSha: 'cafefeed' })

    expect(sessoesParaVigiaPreMerge([aberta, mesclada])).toEqual([aberta])
  })

  test('lista vazia devolve lista vazia — sem sessão viva, sem trabalho', () => {
    expect(sessoesParaVigiaPreMerge([])).toEqual([])
  })
})
