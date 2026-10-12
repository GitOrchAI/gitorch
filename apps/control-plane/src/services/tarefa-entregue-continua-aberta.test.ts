import { describe, expect, it, vi } from 'vitest'
import { ErroDoGitHub } from './erro-do-github.js'
import {
  CARENCIA_ANTES_DE_VARRER_MS,
  ESPERA_APOS_FALHA_MS,
  TETO_DE_TAREFAS_POR_PASSADA,
  chaveDaTarefa,
  entregasQueMerecemConferencia,
  recadoDeTarefaJaEntregue,
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
  projectId = 'proj-a'
) => ({ projectId, issueNumber, mergeCommitSha, pullRequestNumber, updatedAt, closedReason })

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

describe('o recado do fechamento', () => {
  it('NÃO afirma que o produto mesclou — porque não foi ele', () => {
    const texto = recadoDeTarefaJaEntregue({ pullRequestNumber: 42, mergeCommitSha: 'abcdef1234' })
    expect(texto).not.toMatch(/O GitOrch mesclou/)
    expect(texto).toContain('#42')
    expect(texto).toContain('abcdef12')
  })

  it('sem número de PR o texto continua verdadeiro, sem citar "#null"', () => {
    const texto = recadoDeTarefaJaEntregue({
      pullRequestNumber: null,
      mergeCommitSha: 'abcdef1234',
    })
    expect(texto).not.toContain('#null')
    expect(texto).not.toContain('PR #')
    expect(texto).toContain('abcdef12')
  })

  it('com mergeCommitSha nulo exibe "(commit registrado via merge de PR)" sem quebrar', () => {
    const texto = recadoDeTarefaJaEntregue({
      pullRequestNumber: 42,
      mergeCommitSha: null,
    })
    expect(texto).toContain('(commit registrado via merge de PR)')
    expect(texto).toContain('#42')
  })

  it('é só registro: diz como desfazer e não pede nada a ninguém', () => {
    const texto = recadoDeTarefaJaEntregue({ pullRequestNumber: 1, mergeCommitSha: '1234567890' })
    expect(texto).toContain('Para desfazer: reabrir esta issue.')
    expect(texto).not.toMatch(/\b(confira|por favor|decida|precisa de ação)\b/i)
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
  comentadas: string[]
  fechadas: string[]
  avisos: string[]
  painel: Array<{ projectId: string; chave: string; texto: string }>
  marcadas: string[]
  falhasAte: Map<string, number>
}

function cenario(args: {
  linhas: ReturnType<typeof linha>[]
  estadoDasIssues?: Record<string, 'open' | 'closed' | Error>
  fichas?: Record<string, FichaDaTarefa>
  teto?: number
  falhasAte?: Map<string, number>
}): Cenario {
  const lidas: string[] = []
  const comentadas: string[] = []
  const fechadas: string[] = []
  const avisos: string[] = []
  const painel: Cenario['painel'] = []
  const marcadas: string[] = []
  const falhasAte = args.falhasAte ?? new Map<string, number>()
  const repos: Record<string, string> = { 'proj-a': 'org-a/repo-a', 'proj-b': 'org-b/repo-b' }
  const deps: DepsDaVarredura = {
    linhas: args.linhas,
    agora: AGORA,
    ...(args.teto === undefined ? {} : { teto: args.teto }),
    fichas: new Map(Object.entries(args.fichas ?? {})),
    falhasAte,
    abrirProjeto: async (projectId) => {
      const wingId = repos[projectId]!
      const ctx: ContextoDoProjeto = {
        wingId,
        lerIssue: async (n) => {
          lidas.push(`${wingId}#${n}`)
          const e = args.estadoDasIssues?.[`${wingId}#${n}`] ?? 'closed'
          if (e instanceof Error) throw e
          return { state: e }
        },
        comentar: async (n, corpo) => {
          comentadas.push(`${wingId}#${n}:${corpo.slice(0, 20)}`)
        },
        fechar: async (n) => {
          fechadas.push(`${wingId}#${n}`)
        },
      }
      return ctx
    },
    marcarFicha: async (projectId, n, o) => {
      marcadas.push(`${projectId}#${n}:${o.fechadaPelaEntrega ? 'nossa' : 'ja-fechada'}`)
    },
    registrarNoPainel: async (projectId, chave, texto) => {
      painel.push({ projectId, chave, texto })
    },
    aposFalha: () => false,
    naoAutorizado: () => false,
    aviso: (m) => avisos.push(m),
    info: () => undefined,
  }
  return { deps, lidas, comentadas, fechadas, avisos, painel, marcadas, falhasAte }
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

  it('tarefa aberta com entrega mesclada: comenta como registro, fecha, marca a ficha e registra no painel com o PR e como desfazer', async () => {
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
        comentar: async () => {
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
