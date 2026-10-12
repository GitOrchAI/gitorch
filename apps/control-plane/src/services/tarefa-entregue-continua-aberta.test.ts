import { describe, expect, it, vi } from 'vitest'
import { ErroDoGitHub } from './erro-do-github.js'
import { MARCADOR_DO_REGISTRO_DE_ENTREGA } from './registro-de-entrega.js'
import {
  CARENCIA_ANTES_DE_VARRER_MS,
  ESPERA_APOS_FALHA_MS,
  TETO_DE_TAREFAS_POR_PASSADA,
  chaveDaTarefa,
  entregasQueMerecemConferencia,
  varrerTarefasEntregues,
  type ContextoDoProjeto,
  type DepsDaVarredura,
  type FichaDaTarefa,
} from './tarefa-entregue-continua-aberta.js'

const AGORA = new Date('2026-08-27T18:00:00Z')
const VELHA = new Date(AGORA.getTime() - CARENCIA_ANTES_DE_VARRER_MS - 1_000)

const linha = (
  issueNumber: number,
  mergeCommitSha: string | null,
  pullRequestNumber: number | null = null,
  updatedAt: Date = VELHA,
  closedReason?: string | null,
  projectId = 'proj-a',
  closedAt: Date | null = null
) => ({
  projectId,
  issueNumber,
  mergeCommitSha,
  pullRequestNumber,
  updatedAt,
  closedReason,
  closedAt,
})

describe('quais entregas merecem conferência', () => {
  it('sem commit de merge nem closedReason merged não entra — não há o que fechar', () => {
    expect(entregasQueMerecemConferencia([linha(10, null)], AGORA)).toEqual([])
  })

  it('com closedReason "merged" e mergeCommitSha nulo entra na conferência', () => {
    expect(
      entregasQueMerecemConferencia([linha(10, null, null, VELHA, 'merged')], AGORA)
    ).toHaveLength(1)
  })

  it('a MESMA tarefa aparece uma vez só, por mais entregas que tenha', () => {
    // A tarefa #128 chegou a ter CINCO entregas por causa da redelegação.
    // Perguntar cinco vezes pelo estado dela repetiria o desperdício.
    const escolhidas = entregasQueMerecemConferencia(
      [linha(128, 'aaa'), linha(128, 'bbb'), linha(128, 'ccc'), linha(110, 'ddd')],
      AGORA
    )
    expect(escolhidas.map((e) => e.issueNumber)).toEqual([128, 110])
  })

  it('o MESMO número em projetos diferentes são tarefas diferentes — as duas entram', () => {
    // Defeito medido: a chave era só o número da issue; a linha mais antiga
    // vencia e a tarefa homônima de outro projeto nunca era conferida.
    const escolhidas = entregasQueMerecemConferencia(
      [linha(190, 'aaa', 11, VELHA, null, 'proj-a'), linha(190, 'bbb', 22, VELHA, null, 'proj-b')],
      AGORA
    )
    expect(escolhidas.map((e) => [e.projectId, e.pullRequestNumber])).toEqual([
      ['proj-a', 11],
      ['proj-b', 22],
    ])
  })

  it('número de tarefa inválido não vira consulta', () => {
    expect(entregasQueMerecemConferencia([linha(0, 'aaa'), linha(-3, 'bbb')], AGORA)).toEqual([])
  })

  it('mantém a ordem recebida — a mais antiga é conferida primeiro', () => {
    const escolhidas = entregasQueMerecemConferencia([linha(5, 'a'), linha(9, 'b')], AGORA)
    expect(escolhidas.map((e) => e.issueNumber)).toEqual([5, 9])
  })

  it('entrega recem-mesclada NAO entra — aquela ainda e do caminho normal', () => {
    // Um teste de costura real pegou isto: a varredura e a missao de QA
    // comentavam e fechavam a MESMA tarefa no mesmo tique, deixando dois
    // comentarios identicos no repositorio do cliente.
    const agoraMesmo = new Date(AGORA.getTime() - 1_000)
    expect(entregasQueMerecemConferencia([linha(7, 'aaa', null, agoraMesmo)], AGORA)).toEqual([])
  })

  it('passada a carencia, entra — ninguem mais vai fechar', () => {
    expect(entregasQueMerecemConferencia([linha(7, 'aaa')], AGORA)).toHaveLength(1)
  })
})

const ERRO = (status: number, mensagem: string) =>
  new ErroDoGitHub(mensagem, {
    status,
    retryAfterSegundos: null,
    limiteRestante: null,
    limiteResetaEmSegundos: null,
  })

interface Cenario {
  deps: DepsDaVarredura
  lidas: string[]
  /** Ordem das escritas no GitHub: `comentar:` e `fechar:`. */
  escritas: string[]
  comentadas: string[]
  fechadas: string[]
  perguntas: Array<{ projectId: string; text: string; dedupKey: string }>
  memorias: string[]
  avisos: string[]
  painel: Array<{ projectId: string; chave: string; texto: string }>
  marcadas: string[]
  falhasAte: Map<string, number>
  abertas: Set<string>
}

function cenario(args: {
  linhas: ReturnType<typeof linha>[]
  estadoDasIssues?: Record<string, 'open' | 'closed' | Error>
  fichas?: Record<string, FichaDaTarefa>
  teto?: number
  falhasAte?: Map<string, number>
  autonomia?: string | null
  projetosPulados?: string[]
  jaComentada?: boolean
  falharAoFechar?: () => boolean
}): Cenario {
  const lidas: string[] = []
  const escritas: string[] = []
  const comentadas: string[] = []
  const fechadas: string[] = []
  const perguntas: Cenario['perguntas'] = []
  const memorias: string[] = []
  const avisos: string[] = []
  const painel: Cenario['painel'] = []
  const marcadas: string[] = []
  const abertas = new Set<string>()
  const falhasAte = args.falhasAte ?? new Map<string, number>()
  const repos: Record<string, string> = { 'proj-a': 'org-a/repo-a', 'proj-b': 'org-b/repo-b' }
  const deps: DepsDaVarredura = {
    linhas: args.linhas,
    agora: AGORA,
    ...(args.teto === undefined ? {} : { teto: args.teto }),
    fichas: new Map(Object.entries(args.fichas ?? {})),
    falhasAte,
    abrirProjeto: async (projectId) => {
      if (args.projetosPulados?.includes(projectId)) return null
      const wingId = repos[projectId] ?? `org/${projectId}`
      const ctx: ContextoDoProjeto = {
        wingId,
        autonomia: args.autonomia === undefined ? 'cuidar' : args.autonomia,
        lerIssue: async (n) => {
          lidas.push(`${wingId}#${n}`)
          const e = args.estadoDasIssues?.[`${wingId}#${n}`] ?? 'closed'
          if (e instanceof Error) throw e
          return { state: e, title: `Tarefa ${n}`, updated_at: '2026-08-20T10:00:00Z' }
        },
        jaTemRegistro: async () => args.jaComentada === true || abertas.has('registro'),
        comentar: async (n, corpo) => {
          escritas.push(`comentar:${wingId}#${n}`)
          comentadas.push(corpo)
          abertas.add('registro')
        },
        fechar: async (n) => {
          if (args.falharAoFechar?.()) throw new Error('GitHub PATCH falhou (502)')
          escritas.push(`fechar:${wingId}#${n}`)
          fechadas.push(`${wingId}#${n}`)
        },
        perguntar: async (p) => {
          perguntas.push({ projectId, text: p.text, dedupKey: p.dedupKey })
        },
        perguntaAberta: async (dedupKey) => perguntas.some((p) => p.dedupKey === dedupKey),
      }
      return ctx
    },
    marcarFicha: async (projectId, n, o) => {
      marcadas.push(`${projectId}#${n}:${o.fechadaPelaEntrega ? 'nossa' : 'ja-fechada'}`)
    },
    gravarMemoria: async (projectId, n, m) => {
      memorias.push(`${projectId}#${n}:${m.veredito}`)
    },
    registrarNoPainel: async (projectId, chave, texto) => {
      painel.push({ projectId, chave, texto })
    },
    aposFalha: () => false,
    naoAutorizado: () => false,
    aviso: (m) => avisos.push(m),
    info: () => undefined,
  }
  return {
    deps,
    lidas,
    escritas,
    comentadas,
    fechadas,
    perguntas,
    memorias,
    avisos,
    painel,
    marcadas,
    falhasAte,
    abertas,
  }
}

describe('a varredura confere por projeto e tarefa', () => {
  it('duas tarefas com o mesmo número em projetos diferentes: cada uma lida no SEU repositório', async () => {
    const c = cenario({
      linhas: [
        linha(190, 'aaa', 11, VELHA, null, 'proj-a'),
        linha(190, 'bbb', 22, VELHA, null, 'proj-b'),
      ],
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas.sort()).toEqual(['org-a/repo-a#190', 'org-b/repo-b#190'])
  })

  it('tarefa aberta com entrega mesclada: fecha, comenta o registro, marca a ficha e registra no painel com o PR e como desfazer', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: { 'org-a/repo-a#7': 'open' },
    })
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.comentadas).toHaveLength(1)
    expect(c.fechadas).toEqual(['org-a/repo-a#7'])
    expect(c.marcadas).toEqual(['proj-a#7:nossa'])
    expect(c.painel).toHaveLength(1)
    expect(c.painel[0]!.texto).toContain('PR #42')
    expect(c.painel[0]!.texto).toContain('reabrir')
    expect(r.fechadas).toBe(1)
  })

  it('tarefa já fechada: marca a ficha para nunca mais ser consultada e não escreve nada', async () => {
    const c = cenario({ linhas: [linha(7, 'abc')] })
    await varrerTarefasEntregues(c.deps)
    expect(c.marcadas).toEqual(['proj-a#7:ja-fechada'])
    expect(c.comentadas).toEqual([])
    expect(c.fechadas).toEqual([])
    expect(c.painel).toEqual([])
  })

  it('tarefa que a ficha já diz FECHADA não é reconsultada no GitHub', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc'), linha(8, 'def')],
      fichas: { [chaveDaTarefa('proj-a', 7)]: { status: 'closed', fechadaPelaEntrega: false } },
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#8'])
  })

  it('tarefa que NÓS fechamos e alguém reabriu não é fechada de novo — reabrir é decisão de gente', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc')],
      fichas: { [chaveDaTarefa('proj-a', 7)]: { status: 'open', fechadaPelaEntrega: true } },
      estadoDasIssues: { 'org-a/repo-a#7': 'open' },
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual([])
    expect(c.fechadas).toEqual([])
  })

  it('o teto limita as consultas da passada e a próxima começa por quem ficou de fora (rodízio)', async () => {
    const linhas = [1, 2, 3, 4, 5].map((n) => linha(n, `sha${n}`))
    const c = cenario({ linhas, teto: 2 })
    const fichas = new Map<string, FichaDaTarefa>()
    c.deps.marcarFicha = async (projectId, n) => {
      fichas.set(chaveDaTarefa(projectId, n), { status: 'closed', fechadaPelaEntrega: false })
    }
    c.deps.fichas = fichas
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#1', 'org-a/repo-a#2'])
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas.slice(2)).toEqual(['org-a/repo-a#3', 'org-a/repo-a#4'])
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas.slice(4)).toEqual(['org-a/repo-a#5'])
  })

  it('o teto padrão cabe com folga em 30 s (cerca de 0,3 s por consulta)', () => {
    expect(TETO_DE_TAREFAS_POR_PASSADA * 0.3).toBeLessThan(30)
  })

  it('falha de leitura: o aviso leva o motivo real, não repete na mesma passada nem na seguinte', async () => {
    const falhasAte = new Map<string, number>()
    const c = cenario({
      linhas: [linha(7, 'abc'), linha(8, 'def')],
      estadoDasIssues: {
        'org-a/repo-a#7': ERRO(
          403,
          'GitHub GET /repos/org-a/repo-a/issues/7 falhou (403): Resource not accessible by integration'
        ),
      },
      falhasAte,
    })
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.avisos).toHaveLength(1)
    expect(c.avisos[0]).toContain('#7')
    expect(c.avisos[0]).toContain('Resource not accessible by integration')
    expect(r.falhas).toBe(1)
    expect(falhasAte.get(chaveDaTarefa('proj-a', 7))).toBe(AGORA.getTime() + ESPERA_APOS_FALHA_MS)

    await varrerTarefasEntregues(c.deps)
    expect(c.lidas.filter((l) => l === 'org-a/repo-a#7')).toHaveLength(1)
    expect(c.avisos).toHaveLength(1)
  })

  it('depois da espera, a tarefa que falhou volta — mas depois das que nunca falharam', async () => {
    const falhasAte = new Map<string, number>([[chaveDaTarefa('proj-a', 7), AGORA.getTime() - 1]])
    const c = cenario({ linhas: [linha(7, 'abc'), linha(8, 'def')], falhasAte, teto: 1 })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#8'])
  })

  it('freio de cota depois de uma falha interrompe o projeto', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc'), linha(8, 'def')],
      estadoDasIssues: { 'org-a/repo-a#7': ERRO(429, 'rate limit') },
    })
    c.deps.aposFalha = () => true
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#7'])
  })

  it('escrita recusada pela guarda de autonomia encerra o projeto sem aviso de falha', async () => {
    const recusa = new Error('nao autorizado')
    const c = cenario({
      linhas: [linha(7, 'abc'), linha(8, 'def')],
      estadoDasIssues: { 'org-a/repo-a#7': 'open', 'org-a/repo-a#8': 'open' },
    })
    const abrir = c.deps.abrirProjeto
    c.deps.abrirProjeto = async (id) => {
      const ctx = (await abrir(id))!
      return {
        ...ctx,
        fechar: async () => {
          throw recusa
        },
      }
    }
    c.deps.naoAutorizado = (e) => e === recusa
    await varrerTarefasEntregues(c.deps)
    expect(c.avisos).toEqual([])
    expect(c.fechadas).toEqual([])
    expect(c.lidas).toEqual(['org-a/repo-a#7'])
    expect(c.marcadas).toEqual([])
  })

  it('projeto sem contexto (inativo, sem credencial, em freio) é pulado sem consultar nada', async () => {
    const c = cenario({ linhas: [linha(7, 'abc')] })
    c.deps.abrirProjeto = vi.fn(async () => null)
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual([])
  })
})

const ABERTA_A = { 'org-a/repo-a#7': 'open' as const }

describe('o fechamento respeita a autonomia do projeto', () => {
  it('cuidar: fecha com registro', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      autonomia: 'cuidar',
    })
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.escritas).toEqual(['fechar:org-a/repo-a#7', 'comentar:org-a/repo-a#7'])
    expect(c.perguntas).toEqual([])
    expect(r.fechadas).toBe(1)
  })

  it('sugerir: NÃO escreve no GitHub e pergunta uma vez, por painel e Telegram', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      autonomia: 'sugerir',
    })
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.escritas).toEqual([])
    expect(c.marcadas).toEqual([])
    expect(c.perguntas).toHaveLength(1)
    expect(c.perguntas[0]!.text).toContain('#7')
    expect(c.perguntas[0]!.text).toContain('PR #42')
    expect(c.perguntas[0]!.dedupKey.startsWith('suspeita-resolvida:org-a/repo-a:7:')).toBe(true)
    expect(c.memorias).toEqual(['proj-a#7:perguntada'])
    expect(r.fechadas).toBe(0)
  })

  it('sugerir: pergunta que já está aberta não é repetida', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      autonomia: 'sugerir',
    })
    await varrerTarefasEntregues(c.deps)
    // Passada seguinte (a ficha em memória não foi atualizada pelo fake): a
    // pergunta continua aberta, então não nasce outra.
    await varrerTarefasEntregues(c.deps)
    expect(c.perguntas).toHaveLength(1)
  })

  it('so_olhar: só registra no painel, sem pergunta e sem escrita', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      autonomia: 'so_olhar',
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.escritas).toEqual([])
    expect(c.perguntas).toEqual([])
    expect(c.painel).toHaveLength(1)
    expect(c.painel[0]!.texto).toContain('PR #42')
    expect(c.painel[0]!.texto).toContain('só olhar')
    expect(c.memorias).toEqual(['proj-a#7:registrada'])
  })

  it('autonomia nula ou desconhecida cai no mais restrito (só olhar)', async () => {
    for (const autonomia of [null, 'qualquer-coisa']) {
      const c = cenario({
        linhas: [linha(7, 'abc12345', 42)],
        estadoDasIssues: ABERTA_A,
        autonomia,
      })
      await varrerTarefasEntregues(c.deps)
      expect(c.escritas).toEqual([])
      expect(c.perguntas).toEqual([])
      expect(c.painel).toHaveLength(1)
    }
  })

  it('tarefa perguntada há pouco, ou que o dono mandou seguir, não ocupa vaga do teto', async () => {
    const recente = new Date(AGORA.getTime() - 60 * 60_000).toISOString()
    const c = cenario({
      linhas: [linha(7, 'a', 1), linha(8, 'b', 2), linha(9, 'c', 3)],
      fichas: {
        [chaveDaTarefa('proj-a', 7)]: {
          status: 'open',
          fechadaPelaEntrega: false,
          memoria: { veredito: 'perguntada', avaliadaEm: recente },
        },
        [chaveDaTarefa('proj-a', 8)]: {
          status: 'open',
          fechadaPelaEntrega: false,
          memoria: { veredito: 'descartada', origem: 'dono' },
        },
      },
      autonomia: 'sugerir',
      teto: 1,
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#9'])
  })

  it('pergunta antiga sem resposta (mais de um dia) volta a ser avaliada', async () => {
    const antiga = new Date(AGORA.getTime() - 25 * 60 * 60_000).toISOString()
    const c = cenario({
      linhas: [linha(7, 'a', 1)],
      fichas: {
        [chaveDaTarefa('proj-a', 7)]: {
          status: 'open',
          fechadaPelaEntrega: false,
          memoria: { veredito: 'perguntada', avaliadaEm: antiga },
        },
      },
      autonomia: 'sugerir',
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual(['org-a/repo-a#7'])
  })
})

describe('o registro publicado ao fechar', () => {
  it('um PR: texto seco, sem frase sobre quem mesclou, com o marcador oculto', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas).toHaveLength(1)
    expect(c.comentadas[0]).toBe(
      `${MARCADOR_DO_REGISTRO_DE_ENTREGA}\nEntregue pelo PR #42. Para desfazer: reabrir esta issue.`
    )
    expect(c.comentadas[0]).not.toMatch(/mãos do produto|auto-merge|alguém clicando/)
  })

  it('vários PRs da mesma tarefa: cita todos em ordem de merge, do mais antigo ao mais novo', async () => {
    const dia = (d: number) => new Date(Date.UTC(2026, 7, d, 12))
    const c = cenario({
      linhas: [
        // chegam na ordem do banco (mais recente primeiro), fora da ordem de merge
        linha(7, 'c', 218, VELHA, 'merged', 'proj-a', dia(18)),
        linha(7, 'a', 202, VELHA, 'merged', 'proj-a', dia(2)),
        linha(7, 'b', 216, VELHA, 'merged', 'proj-a', dia(16)),
      ],
      estadoDasIssues: ABERTA_A,
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas[0]).toContain(
      'Entregue pelos PRs #202, #216 e #218. Para desfazer: reabrir esta issue.'
    )
    expect(c.painel[0]!.texto).toContain(
      'Entregue pelos PRs #202, #216 e #218. Para desfazer: reabrir esta issue.'
    )
  })

  it('PR de outra tarefa (ou de outro projeto) com número parecido não entra na lista', async () => {
    const c = cenario({
      linhas: [
        linha(7, 'a', 42, VELHA, 'merged', 'proj-a'),
        linha(8, 'b', 99, VELHA, 'merged', 'proj-a'),
        linha(7, 'c', 77, VELHA, 'merged', 'proj-b'),
      ],
      estadoDasIssues: { 'org-a/repo-a#7': 'open' },
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas[0]).toContain('Entregue pelo PR #42.')
    expect(c.comentadas[0]).not.toContain('#99')
    expect(c.comentadas[0]).not.toContain('#77')
  })
})

describe('rodízio justo e idempotência do registro', () => {
  it('45 candidatas de projeto pulado + 5 de projeto ativo: as 5 são conferidas na primeira passada', async () => {
    const puladas = Array.from({ length: 45 }, (_, i) =>
      linha(100 + i, `sha${i}`, 500 + i, VELHA, null, 'proj-b')
    )
    const ativas = [1, 2, 3, 4, 5].map((n) => linha(n, `sha${n}`, n, VELHA, null, 'proj-a'))
    const c = cenario({ linhas: [...puladas, ...ativas], projetosPulados: ['proj-b'] })
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.lidas).toEqual([1, 2, 3, 4, 5].map((n) => `org-a/repo-a#${n}`))
    expect(r.consultadas).toBe(5)
  })

  it('o teto vale só para o que foi de fato consultado, entre projetos', async () => {
    const b = [1, 2, 3].map((n) => linha(n, `b${n}`, n, VELHA, null, 'proj-b'))
    const a = [11, 12, 13].map((n) => linha(n, `a${n}`, n, VELHA, null, 'proj-a'))
    const c = cenario({ linhas: [...b, ...a], teto: 4 })
    const r = await varrerTarefasEntregues(c.deps)
    expect(r.consultadas).toBe(4)
  })

  it('o PATCH de fechamento falha: nada é comentado e, na passada seguinte, nasce um comentário só', async () => {
    let falhar = true
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      falharAoFechar: () => falhar,
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas).toEqual([])
    expect(c.fechadas).toEqual([])
    // a falha descansa por seis horas; passada depois do descanso
    falhar = false
    c.deps.agora = new Date(AGORA.getTime() + ESPERA_APOS_FALHA_MS + 1_000)
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas).toHaveLength(1)
    expect(c.fechadas).toEqual(['org-a/repo-a#7'])
  })

  it('se o registro já está na issue, não publica outro', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
      jaComentada: true,
    })
    await varrerTarefasEntregues(c.deps)
    expect(c.comentadas).toEqual([])
    expect(c.fechadas).toEqual(['org-a/repo-a#7'])
    expect(c.marcadas).toEqual(['proj-a#7:nossa'])
  })

  it('o fechamento já feito e o comentário que falhou depois: segue, marca a ficha e avisa', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
    })
    const abrir = c.deps.abrirProjeto
    c.deps.abrirProjeto = async (id) => {
      const ctx = (await abrir(id))!
      return {
        ...ctx,
        comentar: async () => {
          throw new Error('GitHub POST falhou (502)')
        },
      }
    }
    const r = await varrerTarefasEntregues(c.deps)
    expect(c.fechadas).toEqual(['org-a/repo-a#7'])
    expect(c.marcadas).toEqual(['proj-a#7:nossa'])
    expect(c.avisos.join(' ')).toContain('registro')
    expect(r.fechadas).toBe(1)
  })
})

describe('entregue é entregue, mesmo com dependência aberta', () => {
  it('tarefa com "Blocked by #N" aberto e PR mesclado ligado: fecha — a checagem de bloqueio é da delegação, não do fechamento', async () => {
    const c = cenario({
      linhas: [linha(7, 'abc12345', 42)],
      estadoDasIssues: ABERTA_A,
    })
    const abrir = c.deps.abrirProjeto
    c.deps.abrirProjeto = async (id) => {
      const ctx = (await abrir(id))!
      return {
        ...ctx,
        lerIssue: async (n) => ({
          ...(await ctx.lerIssue(n)),
          state: 'open',
          body: 'Corpo da tarefa.\n\nBlocked by #5',
        }),
      }
    }
    await varrerTarefasEntregues(c.deps)
    expect(c.fechadas).toEqual(['org-a/repo-a#7'])
  })
})
