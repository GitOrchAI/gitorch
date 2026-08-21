import { describe, expect, test } from 'vitest'
import { filtroDeSessoesParaJulgamento } from './scheduler.js'

// Achado 2 da revisão da Task 6: o `where` que decide quais linhas de
// `dev_sessions` chegam ao julgamento do QA vivia inline dentro do fechamento
// não exportado do dispatch (mesma limitação da Task 5). Extraído para
// `filtroDeSessoesParaJulgamento` — ver o comentário da função em
// scheduler.ts para o porquê da regra em si. Este arquivo é dedicado (em vez
// de entrar em scheduler-teto-delegacao.test.ts) porque aquele arquivo cobre
// um achado diferente — o teto de concorrência/diário da delegação do SM
// (Task 5) — e este é sobre o critério de seleção do julgamento do QA
// (Task 6): assuntos vizinhos no mesmo arquivo-fonte, mas achados distintos.

/**
 * Interpreta, contra uma linha em memória, só o subconjunto de operadores
 * Prisma que este filtro usa (igualdade, `not`, `OR` de cláusulas). Não é um
 * interpretador Prisma genérico — existe só para provar, com dados de
 * verdade (sem banco), o que o `where` devolvido por
 * `filtroDeSessoesParaJulgamento` de fato inclui ou exclui.
 */
function bate(sessao: Record<string, unknown>, clausula: Record<string, unknown>): boolean {
  return Object.entries(clausula).every(([campo, condicao]) => {
    if (campo === 'OR') {
      return (condicao as Record<string, unknown>[]).some((c) => bate(sessao, c))
    }
    if (condicao !== null && typeof condicao === 'object' && 'not' in condicao) {
      return sessao[campo] !== (condicao as { not: unknown }).not
    }
    return sessao[campo] === condicao
  })
}

const projectId = 'projeto-1'

function linha(overrides: {
  closedAt?: Date | null
  closedReason?: string | null
  pullRequestNumber?: number | null
}) {
  return {
    id: 'sessao-x',
    projectId,
    closedAt: null,
    closedReason: null,
    pullRequestNumber: null,
    ...overrides,
  }
}

describe('filtroDeSessoesParaJulgamento', () => {
  const where = filtroDeSessoesParaJulgamento(projectId)

  test('forma exata do where: projectId + OR(viva, fechada-não-mesclada-com-PR) — sem take', () => {
    expect(where).toEqual({
      projectId,
      OR: [
        { closedAt: null },
        { closedReason: { not: 'merged' }, pullRequestNumber: { not: null } },
      ],
    })
    expect(where).not.toHaveProperty('take')
  })

  test('inclui sessão viva (closedAt: null)', () => {
    const viva = linha({ closedAt: null })
    expect(bate(viva, where)).toBe(true)
  })

  test('inclui sessão abandonada COM PR ainda aberto — o caso que motivou a correção', () => {
    const abandonadaComPr = linha({
      closedAt: new Date('2026-08-01'),
      closedReason: 'abandoned',
      pullRequestNumber: 63,
    })
    expect(bate(abandonadaComPr, where)).toBe(true)
  })

  test('exclui sessão fechada como abandoned SEM PR — nada a julgar, e closedAt não é null', () => {
    const abandonadaSemPr = linha({
      closedAt: new Date('2026-08-01'),
      closedReason: 'abandoned',
      pullRequestNumber: null,
    })
    expect(bate(abandonadaSemPr, where)).toBe(false)
  })

  test('exclui sessão mescladas — são as que terminaram de vez e se acumulariam sem limite', () => {
    const mesclada = linha({
      closedAt: new Date('2026-08-01'),
      closedReason: 'merged',
      pullRequestNumber: 40,
    })
    expect(bate(mesclada, where)).toBe(false)
  })

  test('não tem teto (take) — dev_sessions nunca é apagada, um teto por contagem esconderia a sessão certa', () => {
    expect(where).not.toHaveProperty('take')
  })
})
