import { describe, it, expect, vi } from 'vitest'
import { reprocessarPerguntasSemOpcoesDoProjeto } from './reprocessar-perguntas-sem-opcoes.js'

/**
 * D72 (02/09) — item 5: as 4 perguntas que o dono FLAGROU AO VIVO no
 * painel/Telegram ("Esperando você") já existem no banco, quebradas (sem
 * as 3 opções), no exato instante em que este conserto sobe. Consertar só
 * o caminho de escalada NOVA (itens 1-4) não tira o lixo que já está na
 * tela dele — por isso esta varredura idempotente: toda `agent_question`
 * aberta com dedupKey `duvida-dev:*` e menos de 4 opções (3 executivas + a
 * livre) é encerrada honestamente, sai de "Esperando você" e não soa o
 * Telegram de novo.
 */

// Fake mínimo, mas respeita o `where` — MESMO padrão do resto do projeto
// (agent-question.test.ts): sem isto o teste não prova nada sobre o filtro
// que a query real do Prisma aplica (status/dedupKey.startsWith).
function prismaFalso(linhas: Array<Record<string, unknown>>) {
  return {
    agentQuestion: {
      findMany: vi.fn(async ({ where }: { where: { dedupKey: { startsWith: string } } }) =>
        linhas.filter((l) => String(l['dedupKey'] ?? '').startsWith(where.dedupKey.startsWith))
      ),
    },
  }
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: prismaFalso([]),
    marcarAssumida: vi.fn(async () => ({ id: 'q1', status: 'assumida' })),
    onWarn: vi.fn(),
    ...overrides,
  }
}

const PERGUNTA_QUEBRADA_REAL = {
  id: 'q_309',
  dedupKey: 'duvida-dev:GitOrchAI/gitorch:309:hashreal',
  options: [{ label: '✍️ Outro (respondo por texto)', value: '__gitorch_free_text__' }],
  text: "O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão sua. Pergunta original do dev: 'I have successfully modified the code...'",
}

describe('reprocessarPerguntasSemOpcoesDoProjeto', () => {
  it('pergunta aberta duvida-dev: com 1 opção só (o defeito real, tarefa #309): marca assumida — sai de "Esperando você"', async () => {
    const prisma = prismaFalso([PERGUNTA_QUEBRADA_REAL])
    const deps = depsFalso({ prisma })

    const resumo = await reprocessarPerguntasSemOpcoesDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 1, reprocessadas: 1, falhas: 0 })
    expect(deps.marcarAssumida).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q_309', projectId: 'proj1' })
    )
  })

  it('a suposição gravada é honesta — nunca finge uma decisão que não existiu, cita a tarefa', async () => {
    const prisma = prismaFalso([PERGUNTA_QUEBRADA_REAL])
    const deps = depsFalso({ prisma })

    await reprocessarPerguntasSemOpcoesDoProjeto({ projectId: 'proj1' }, deps as never)

    const chamada = (deps.marcarAssumida as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      suposicao: string
    }
    expect(chamada.suposicao).toContain('309')
    expect(chamada.suposicao).not.toMatch(/successfully|the plan/i)
  })

  it('pergunta com as 4 opções (3 + livre) já corretas: NÃO reprocessa', async () => {
    const prisma = prismaFalso([
      {
        id: 'q_ok',
        dedupKey: 'duvida-dev:acme/api:1:h',
        options: [
          { label: 'Pausar a tarefa e revisar depois', value: 'pausar' },
          {
            label: 'Seguir com a melhor suposição do RA mesmo assim',
            value: 'seguir-suposicao-ra',
          },
          { label: 'Pedir ao dev que abra o PR com o que tem', value: 'pedir-pr' },
          { label: '✍️ Outro (respondo por texto)', value: '__gitorch_free_text__' },
        ],
      },
    ])
    const deps = depsFalso({ prisma })

    const resumo = await reprocessarPerguntasSemOpcoesDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 0, reprocessadas: 0, falhas: 0 })
    expect(deps.marcarAssumida).not.toHaveBeenCalled()
  })

  it('nenhuma pergunta quebrada: idempotente, não faz nada', async () => {
    const deps = depsFalso()

    const resumo = await reprocessarPerguntasSemOpcoesDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 0, reprocessadas: 0, falhas: 0 })
  })

  it('marcarAssumida falha para uma pergunta: conta falha, nunca derruba a varredura — segue para a próxima', async () => {
    const prisma = prismaFalso([
      PERGUNTA_QUEBRADA_REAL,
      { ...PERGUNTA_QUEBRADA_REAL, id: 'q_outra', dedupKey: 'duvida-dev:acme/api:2:h2' },
    ])
    const marcarAssumida = vi
      .fn()
      .mockRejectedValueOnce(new Error('rede caiu'))
      .mockResolvedValueOnce({ id: 'q_outra', status: 'assumida' })
    const deps = depsFalso({ prisma, marcarAssumida })

    const resumo = await reprocessarPerguntasSemOpcoesDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 2, reprocessadas: 1, falhas: 1 })
    expect(deps.onWarn).toHaveBeenCalled()
  })

  it('dedupKey de outro tipo (automacao:) mesmo com poucas opções: NUNCA reprocessa (fora do escopo do defeito)', async () => {
    const prisma = prismaFalso([
      {
        id: 'q_auto',
        dedupKey: 'automacao:acme/api:wf:1',
        options: [{ label: 'Deletar', value: 'deletar' }],
      },
    ])
    const deps = depsFalso({ prisma })

    const resumo = await reprocessarPerguntasSemOpcoesDoProjeto(
      { projectId: 'proj1' },
      deps as never
    )

    expect(resumo).toEqual({ encontradas: 0, reprocessadas: 0, falhas: 0 })
  })
})
