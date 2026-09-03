import { describe, it, expect, vi } from 'vitest'
import {
  listarPrsSemParecer,
  runSmDelegation as runSmDelegationReal,
  CAP_PADRAO_DE_JULGAMENTO,
} from './sm-delegation.js'

// C8 (fix-up L4-T5, CSO): `onWarn` virou obrigatório em `SmDelegationOptions`
// — ver o mesmo wrapper e o mesmo motivo em `sm-delegation.test.ts`.
function runSmDelegation(
  args: Omit<Parameters<typeof runSmDelegationReal>[0], 'onWarn'> & {
    onWarn?: Parameters<typeof runSmDelegationReal>[0]['onWarn']
  }
): ReturnType<typeof runSmDelegationReal> {
  return runSmDelegationReal({ onWarn: () => undefined, ...args })
}
import { MARCA_DO_PARECER } from './parecer-do-qa.js'

interface FakePr {
  number: number
  sha: string
  draft?: boolean
  /** commit do parecer nosso já postado, se houver */
  parecerNoCommit?: string
  autor?: string
  corpo?: string
}

function ghFake(prs: FakePr[]) {
  const chamadas: string[] = []
  const gh = async (method: string, path: string): Promise<unknown> => {
    chamadas.push(`${method} ${path}`)
    if (/\/pulls\?/.test(path)) {
      return prs.map((p) => ({
        number: p.number,
        draft: p.draft ?? false,
        head: { sha: p.sha },
        user: { login: p.autor ?? 'app/gitorch' },
        body: p.corpo ?? '',
      }))
    }
    const m = path.match(/\/pulls\/(\d+)\/reviews/)
    if (m) {
      const pr = prs.find((p) => p.number === Number(m[1]))
      if (!pr?.parecerNoCommit) return []
      return [{ body: `${MARCA_DO_PARECER}\nverdict: APPROVE`, commit_id: pr.parecerNoCommit }]
    }
    throw new Error(`chamada inesperada: ${method} ${path}`)
  }
  return { gh, chamadas }
}

describe('listarPrsSemParecer', () => {
  it('sem PR aberto → fila vazia, e não pergunta review de ninguém', async () => {
    const { gh, chamadas } = ghFake([])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([])
    expect(chamadas.filter((c) => c.includes('/reviews'))).toHaveLength(0)
  })

  it('PR sem parecer nosso no head atual entra na fila', async () => {
    const { gh } = ghFake([{ number: 97, sha: 'abc' }])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([97])
  })

  it('PR já julgado NESTE head fica de fora — nada de opinião duplicada', async () => {
    const { gh } = ghFake([{ number: 97, sha: 'abc', parecerNoCommit: 'abc' }])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([])
  })

  it('parecer velho + commit novo → volta para a fila', async () => {
    const { gh } = ghFake([{ number: 97, sha: 'novo', parecerNoCommit: 'velho' }])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([97])
  })

  it('rascunho não é entrega: não entra na fila', async () => {
    const { gh } = ghFake([{ number: 97, sha: 'abc', draft: true }])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([])
  })

  it('NÃO vira rajada: o cap por ciclo corta a fila', async () => {
    const { gh } = ghFake([
      { number: 10, sha: 'a' },
      { number: 11, sha: 'b' },
      { number: 12, sha: 'c' },
      { number: 13, sha: 'd' },
    ])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 2 })).toEqual([10, 11])
  })

  it('o cap padrão é o mesmo desenho do cap de delegação do SM', () => {
    expect(CAP_PADRAO_DE_JULGAMENTO).toBe(3)
  })

  it('para de perguntar review assim que enche o cap (não gasta chamada à toa)', async () => {
    const { gh, chamadas } = ghFake([
      { number: 10, sha: 'a' },
      { number: 11, sha: 'b' },
      { number: 12, sha: 'c' },
    ])
    await listarPrsSemParecer({ repository: 'o/r', gh, cap: 1 })
    expect(chamadas.filter((c) => c.includes('/reviews'))).toHaveLength(1)
  })

  it('cap 0 desliga a leitura por completo', async () => {
    const { gh, chamadas } = ghFake([{ number: 10, sha: 'a' }])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 0 })).toEqual([])
    expect(chamadas).toHaveLength(0)
  })

  // ESTEIRA-T12: com a lista de sessões, só PR delegado entra.
  const sessao = (issueNumber: number, pullRequestNumber: number) =>
    ({ issueNumber, pullRequestNumber, sessionName: `sessions/${pullRequestNumber}` }) as never

  it('sem `sessoes`, comportamento antigo: todo PR aberto sem parecer entra', async () => {
    const { gh } = ghFake([
      { number: 337, sha: 'a', autor: 'app/dependabot' },
      { number: 340, sha: 'b' },
    ])
    expect(await listarPrsSemParecer({ repository: 'o/r', gh, cap: 3 })).toEqual([337, 340])
  })

  it('com `sessoes`: PR do Dependabot (sem linha, autor não-jules) fica de fora', async () => {
    const { gh } = ghFake([
      { number: 337, sha: 'a', autor: 'app/dependabot' },
      { number: 340, sha: 'b' },
    ])
    const out = await listarPrsSemParecer({
      repository: 'o/r',
      gh,
      cap: 3,
      sessoes: [sessao(318, 340)],
    })
    expect(out).toEqual([340])
  })

  it('com `sessoes`: PR reconhecido pelo login "jules" no autor entra mesmo sem linha', async () => {
    const { gh } = ghFake([{ number: 401, sha: 'a', autor: 'jules-bot' }])
    const out = await listarPrsSemParecer({
      repository: 'o/r',
      gh,
      cap: 3,
      sessoes: [],
    })
    expect(out).toEqual([401])
  })

  it('com `sessoes`: nenhum PR aberto é delegado → fila vazia, não pergunta review', async () => {
    const { gh, chamadas } = ghFake([
      { number: 337, sha: 'a', autor: 'app/dependabot' },
      { number: 338, sha: 'b', autor: 'app/renovate' },
    ])
    const out = await listarPrsSemParecer({
      repository: 'o/r',
      gh,
      cap: 3,
      sessoes: [sessao(1, 999)],
    })
    expect(out).toEqual([])
    expect(chamadas.filter((c) => c.includes('/reviews'))).toHaveLength(0)
  })

  it('com `sessoes`: PR delegado JÁ julgado neste head continua fora', async () => {
    const { gh } = ghFake([{ number: 340, sha: 'x', parecerNoCommit: 'x' }])
    const out = await listarPrsSemParecer({
      repository: 'o/r',
      gh,
      cap: 3,
      sessoes: [sessao(318, 340)],
    })
    expect(out).toEqual([])
  })
})

/**
 * Fetch falso do ciclo inteiro do SM: sem task para delegar, mas com entregas
 * abertas esperando parecer. É exatamente o caso que ficava parado — nada a
 * delegar, ninguém para acordar o julgamento.
 */
function fetchDoCiclo(prs: FakePr[], falharNoPulls = false) {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url)
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    if (u.includes('/issues?')) return json([])
    if (u.includes('/pulls?')) {
      if (falharNoPulls) return new Response('boom', { status: 502 })
      return json(
        prs.map((p) => ({
          number: p.number,
          draft: false,
          head: { sha: p.sha },
          user: { login: p.autor ?? 'app/gitorch' },
          body: p.corpo ?? '',
        }))
      )
    }
    if (/\/pulls\/\d+\/reviews/.test(u)) {
      const n = Number(u.match(/\/pulls\/(\d+)\/reviews/)![1])
      const pr = prs.find((p) => p.number === n)
      return json(
        pr?.parecerNoCommit
          ? [{ body: `${MARCA_DO_PARECER}\nverdict: APPROVE`, commit_id: pr.parecerNoCommit }]
          : []
      )
    }
    throw new Error(`chamada inesperada: ${u}`)
  }) as unknown as typeof fetch
}

describe('runSmDelegation — o SM aciona o julgamento', () => {
  it('sem task para delegar, ainda assim manda julgar a entrega sem parecer', async () => {
    const pedirJulgamento = vi.fn()
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDoCiclo([{ number: 97, sha: 'abc' }]),
      pedirJulgamento,
    })
    expect(pedirJulgamento).toHaveBeenCalledWith([97])
    expect(r.paraJulgar).toEqual([97])
    // Acordada que destravou entrega não é acordada vazia.
    expect(r.noOp).toBe(false)
    expect(r.output).toContain('#97')
  })

  it('tudo já julgado no head atual → ninguém é acordado à toa', async () => {
    const pedirJulgamento = vi.fn()
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDoCiclo([{ number: 97, sha: 'abc', parecerNoCommit: 'abc' }]),
      pedirJulgamento,
    })
    expect(pedirJulgamento).not.toHaveBeenCalled()
    expect(r.paraJulgar).toEqual([])
    expect(r.noOp).toBe(true)
  })

  it('sem o gancho ligado, o SM se comporta exatamente como antes', async () => {
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDoCiclo([{ number: 97, sha: 'abc' }]),
    })
    expect(r.paraJulgar).toEqual([])
    expect(r.output).toBe('SM: no newly-ready task to delegate.')
  })

  it('ESTEIRA-T12: PR do Dependabot não vai para o julgamento nem para o log', async () => {
    const pedirJulgamento = vi.fn()
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDoCiclo([
        { number: 337, sha: 'a', autor: 'app/dependabot' },
        { number: 340, sha: 'b' },
      ]),
      pedirJulgamento,
      sessoesParaReconhecerPr: [{ issueNumber: 318, pullRequestNumber: 340 } as never],
    })
    expect(pedirJulgamento).toHaveBeenCalledWith([340])
    expect(r.paraJulgar).toEqual([340])
    expect(r.output).toContain('#340')
    expect(r.output).not.toContain('#337')
    expect(r.output).toContain('delegated PR(s)')
  })

  it('GitHub fora do ar na leitura das entregas: DIZ a falha, não a engole', async () => {
    const onWarn = vi.fn()
    const pedirJulgamento = vi.fn()
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchDoCiclo([{ number: 97, sha: 'abc' }], true),
      pedirJulgamento,
      onWarn,
    })
    expect(pedirJulgamento).not.toHaveBeenCalled()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('fila de julgamento'))
    expect(r.output).toContain('judgment queue FAILED')
    // Falhar em levantar a fila não pode virar "nada a fazer" silencioso.
    expect(r.noOp).toBe(false)
  })
})
