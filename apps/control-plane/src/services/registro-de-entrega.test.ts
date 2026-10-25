import { describe, expect, it, vi } from 'vitest'
import {
  acompanharPublicacao,
  fecharPorTetoAbsoluto,
  JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS,
  TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
  TETO_DE_COMMIT_ERRADO_MS,
} from './publicacao.js'
import {
  corpoDoRegistroDeEntrega,
  jaTemRegistroDeEntrega,
  MARCADOR_DO_REGISTRO_DE_ENTREGA,
  textoDeEntregaMesclada,
  textoDePublicacaoNaoConfirmada,
  textoDoRegistroDeEntrega,
} from './registro-de-entrega.js'

describe('o texto do registro de entrega', () => {
  it('um PR: registro seco com o número e como desfazer', () => {
    expect(textoDoRegistroDeEntrega([42])).toBe(
      'Entregue pelo PR #42. Para desfazer: reabrir esta issue.'
    )
  })

  it('vários PRs: cita todos, do mais antigo ao mais novo, no plural', () => {
    expect(textoDoRegistroDeEntrega([202, 216, 218])).toBe(
      'Entregue pelos PRs #202, #216 e #218. Para desfazer: reabrir esta issue.'
    )
    expect(textoDoRegistroDeEntrega([7, 9])).toBe(
      'Entregue pelos PRs #7 e #9. Para desfazer: reabrir esta issue.'
    )
  })

  it('cita no máximo cinco, ficando com os mais novos', () => {
    expect(textoDoRegistroDeEntrega([1, 2, 3, 4, 5, 6, 7])).toBe(
      'Entregue pelos PRs #3, #4, #5, #6 e #7. Para desfazer: reabrir esta issue.'
    )
  })

  it('sem número de PR continua verdadeiro, sem citar "#null"', () => {
    const texto = textoDoRegistroDeEntrega([])
    expect(texto).toBe('Entregue por uma entrega já mesclada. Para desfazer: reabrir esta issue.')
  })

  it('não diz nada sobre quem mesclou nem pede ação a ninguém', () => {
    const texto = textoDoRegistroDeEntrega([202, 216])
    expect(texto).not.toMatch(/mesclou|produto|GitOrch|alguém|auto-merge|confira|por favor/i)
  })
})

describe('o marcador do registro', () => {
  it('o comentário leva um marcador oculto e o texto continua o mesmo', () => {
    const corpo = corpoDoRegistroDeEntrega([42])
    const [primeiraLinha, ...resto] = corpo.split('\n')
    expect(primeiraLinha).toBe(MARCADOR_DO_REGISTRO_DE_ENTREGA)
    expect(MARCADOR_DO_REGISTRO_DE_ENTREGA.startsWith('<!--')).toBe(true)
    expect(MARCADOR_DO_REGISTRO_DE_ENTREGA.endsWith('-->')).toBe(true)
    expect(MARCADOR_DO_REGISTRO_DE_ENTREGA.includes('\n')).toBe(false)
    expect(resto.join('\n')).toBe(textoDoRegistroDeEntrega([42]))
  })

  it('reconhece o registro que já existe entre os comentários', () => {
    const existente = { body: corpoDoRegistroDeEntrega([42]) }
    expect(jaTemRegistroDeEntrega([{ body: 'outra coisa' }, existente])).toBe(true)
    expect(jaTemRegistroDeEntrega([{ body: 'outra coisa' }, { body: null }, {}])).toBe(false)
  })
})

describe('o comentário de publicação não confirmada', () => {
  it('diz o fato e o motivo, sem pedir resolução manual nem ação a ninguém', () => {
    const texto = textoDePublicacaoNaoConfirmada(42, 'Nenhuma execução apareceu para o commit.')
    expect(texto).toContain('PR #42')
    expect(texto).toContain('Nenhuma execução apareceu para o commit.')
    expect(texto).toContain('não conseguiu confirmar que a publicação dela foi ao ar')
    expect(texto).not.toMatch(/continua aberta|(?<![\p{L}])(?:até|ate|será|sera)(?![\p{L}])/iu)
    expect(texto).not.toMatch(/manualmente|resolvid|confira|por favor|revis[ãa]o humana|decida/i)
  })
})

/**
 * Todo motivo que `publicacao.ts` pode devolver e que acaba no comentário da
 * issue (fechamento por teto e veredito final sem publicação). O comentário
 * publicado no GitHub só afirma fato verificável: não diz quem mesclou, não
 * promete nada e não pede ação a ninguém.
 */
async function motivosDePublicacaoPossiveis(): Promise<string[]> {
  const workflow = { tipo: 'workflow', arquivo: 'cd.yml', nome: 'CD' } as const
  const deployment = { tipo: 'deployment' as const, ambientes: ['staging', 'production'] }
  const base = {
    shaDaMescla: 'abc123',
    lerExecucoes: vi.fn(),
    lerEtapas: vi.fn(),
    lerPublicacoes: vi.fn(),
    lerEstadosDaPublicacao: vi.fn(),
  }
  const execucaoDe = (
    head_sha: string,
    status = 'completed',
    conclusion: string | null = 'success'
  ) => vi.fn().mockResolvedValue([{ id: 9, head_sha, status, conclusion }])
  const etapas = (...lista: Array<{ name: string; status: string; conclusion: string | null }>) =>
    vi.fn().mockResolvedValue(lista)
  const publicacoes = vi
    .fn()
    .mockResolvedValue([{ id: 1, sha: 'abc123', production_environment: true }])
  const estado = (state: string | null) =>
    vi.fn().mockResolvedValue(state === null ? [] : [{ state, environment_url: null }])
  const depoisDaJanela = JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS + 1

  const vereditos = await Promise.all([
    acompanharPublicacao({ ...base, mecanismo: { tipo: 'nenhum' } }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: vi.fn().mockResolvedValue([]),
      desdeAMescla: 0,
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: vi.fn().mockResolvedValue([]),
      desdeAMescla: depoisDaJanela,
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('antigo99'),
      desdeAMescla: 0,
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('antigo99'),
      desdeAMescla: TETO_DE_COMMIT_ERRADO_MS,
    }),
    acompanharPublicacao({ ...base, mecanismo: workflow, lerExecucoes: execucaoDe('antigo99') }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('abc123'),
      lerEtapas: etapas({ name: 'Deploy', status: 'completed', conclusion: 'failure' }),
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('abc123'),
      lerEtapas: etapas({ name: 'Deploy', status: 'in_progress', conclusion: null }),
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('abc123'),
      lerEtapas: etapas({ name: 'Deploy production', status: 'completed', conclusion: 'skipped' }),
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: workflow,
      lerExecucoes: execucaoDe('abc123'),
      lerEtapas: etapas({ name: 'Deploy', status: 'completed', conclusion: 'success' }),
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: deployment,
      lerPublicacoes: vi.fn().mockResolvedValue([]),
      desdeAMescla: 0,
    }),
    acompanharPublicacao({
      ...base,
      mecanismo: deployment,
      lerPublicacoes: vi.fn().mockResolvedValue([]),
      desdeAMescla: depoisDaJanela,
    }),
    ...['success', 'failure', 'error', 'in_progress', 'inactive', 'algo-novo'].map((state) =>
      acompanharPublicacao({
        ...base,
        mecanismo: deployment,
        lerPublicacoes: publicacoes,
        lerEstadosDaPublicacao: estado(state),
      })
    ),
    acompanharPublicacao({
      ...base,
      mecanismo: deployment,
      lerPublicacoes: publicacoes,
      lerEstadosDaPublicacao: estado(null),
    }),
  ])
  const motivos = vereditos.map((v) => v.motivo)
  // O fechamento por teto absoluto embrulha a última observação de qualquer um
  // deles, e a de quem publica fora do GitHub.
  for (const m of [...motivos, 'a leitura do GitHub falhou repetidamente (403).']) {
    motivos.push(
      fecharPorTetoAbsoluto({
        desdeAMescla: TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
        ultimaObservacao: m,
      }).motivo
    )
  }
  motivos.push('quem publica avisou que a publicação desta versão FALHOU.')
  return motivos
}

describe('o comentário de publicação não confirmada, para todo motivo possível', () => {
  it('nenhum motivo faz o comentário afirmar quem mesclou, prometer ou pedir ação', async () => {
    const motivos = await motivosDePublicacaoPossiveis()
    expect(motivos.length).toBeGreaterThan(20)
    for (const motivo of motivos) {
      const texto = textoDePublicacaoNaoConfirmada(42, motivo)
      expect(texto, motivo).not.toMatch(
        /mesclamos|mesclei|(?<![\p{L}])nós |confira|feche|por favor|continua aberta|(?<![\p{L}])será(?![\p{L}])/iu
      )
    }
  })

  it('o teto absoluto diz só o que o GitOrch fez: acompanhou, sem confirmação', () => {
    const { motivo } = fecharPorTetoAbsoluto({
      desdeAMescla: 24 * 60 * 60_000,
      ultimaObservacao: 'publicando — a etapa "Deploy" ainda não terminou',
    })
    expect(motivo).toBe(
      'o GitOrch acompanhou por 24h sem confirmação de que a publicação chegou ao ar. ' +
        'Última coisa que vimos: publicando — a etapa "Deploy" ainda não terminou.'
    )
  })
})

describe('o status de entrega mesclada no painel (desejo #270 / #344)', () => {
  const base = {
    wingId: 'acme/loja',
    mergeCommitSha: 'abc1234',
    motivo: 'A publicação foi confirmada.',
  }

  it('com as duas datas: o lead time vem por extenso no fim', () => {
    expect(
      textoDeEntregaMesclada({
        ...base,
        wishCreatedAt: new Date('2026-10-20T10:00:00Z'),
        mergedAt: new Date('2026-10-22T13:30:00Z'),
      })
    ).toBe(
      'GitOrch: a entrega de acme/loja (commit abc1234) foi mesclada. A publicação foi confirmada. ' +
        'Lead time, do desejo ao merge: 2 dias e 3 horas.'
    )
  })

  it('sem a data do desejo: a frase some inteira, nunca "null" nem número inventado', () => {
    const texto = textoDeEntregaMesclada({
      ...base,
      wishCreatedAt: null,
      mergedAt: new Date('2026-10-22T13:30:00Z'),
    })
    expect(texto).toBe(
      'GitOrch: a entrega de acme/loja (commit abc1234) foi mesclada. A publicação foi confirmada.'
    )
    expect(texto).not.toMatch(/lead time|null|undefined|NaN/i)
  })

  it('sem a data do merge (GitHub fora do ar no fechamento): sem lead time', () => {
    const texto = textoDeEntregaMesclada({
      ...base,
      wishCreatedAt: new Date('2026-10-20T10:00:00Z'),
      mergedAt: undefined,
    })
    expect(texto).not.toMatch(/lead time|null|undefined|NaN/i)
  })

  it('merge "antes" do desejo (relógio torto): não publica tempo negativo', () => {
    const texto = textoDeEntregaMesclada({
      ...base,
      wishCreatedAt: new Date('2026-10-22T13:30:00Z'),
      mergedAt: new Date('2026-10-20T10:00:00Z'),
    })
    expect(texto).not.toMatch(/lead time|-\d/i)
  })

  it('data que não é data: não vira "NaN dias"', () => {
    const texto = textoDeEntregaMesclada({
      ...base,
      wishCreatedAt: 'não é uma data',
      mergedAt: new Date('2026-10-22T13:30:00Z'),
    })
    expect(texto).not.toMatch(/lead time|NaN/i)
  })

  it('o motivo e o commit seguem intactos com ou sem lead time', () => {
    for (const datas of [
      { wishCreatedAt: null, mergedAt: null },
      {
        wishCreatedAt: new Date('2026-10-22T13:00:00Z'),
        mergedAt: new Date('2026-10-22T13:10:00Z'),
      },
    ]) {
      const texto = textoDeEntregaMesclada({ ...base, ...datas })
      expect(
        texto.startsWith(
          'GitOrch: a entrega de acme/loja (commit abc1234) foi mesclada. A publicação foi confirmada.'
        )
      ).toBe(true)
    }
  })
})
