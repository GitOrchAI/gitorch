import { describe, expect, it } from 'vitest'
import { runSmDelegation } from './sm-delegation.js'

// POR QUE ESTE ARQUIVO EXISTE — o sintoma mudo, medido em 21/08/2026.
//
// Quando a criação da sessão falhava (FAILED_PRECONDITION, por causa das
// vagas esgotadas), o produto JÁ tinha pendurado a etiqueta de delegada na
// issue e seguia em frente. Quem abrisse o quadro veria uma tarefa "em
// andamento" que nunca começou, e nada — nem log, nem recado — dizia que a
// entrega tinha morrido antes de nascer. Onze recusas num dia, todas assim.
//
// A inversão da ordem é o conserto: primeiro acionar o dev, depois marcar a
// issue. Marcar antes é prometer em nome de alguém que ainda não respondeu.
//
// A distinção entre DESLIGADO e FALHOU é a outra metade. Sem chave configurada
// o recurso está desligado de propósito e a etiqueta continua valendo como
// plano B — era assim antes e tem que continuar sendo. Só a FALHA reverte.

interface IssueFalsa {
  number: number
  labels: string[]
  body: string
  title?: string
}

function fakeFetch(issues: IssueFalsa[]) {
  const rotulados: Array<{ number: number; labels: string[] }> = []
  const comentarios: Array<{ number: number; texto: string }> = []
  const porNumero = new Map(issues.map((i) => [i.number, i]))

  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

    if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
      return json(
        issues.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((n) => ({ name: n })),
          body: i.body,
        }))
      )
    }
    const cm = u.match(/\/issues\/(\d+)\/comments$/)
    if (cm && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      comentarios.push({ number: Number(cm[1]), texto: String(body.body ?? '') })
      return json({})
    }
    const dm = u.match(/\/issues\/(\d+)\/labels\/([^/]+)$/)
    if (dm && method === 'DELETE') {
      const n = Number(dm[1])
      const label = decodeURIComponent(dm[2]!)
      const issue = porNumero.get(n)
      if (issue) issue.labels = issue.labels.filter((l) => l !== label)
      return json({})
    }
    const lm = u.match(/\/issues\/(\d+)\/labels$/)
    if (lm && method === 'POST') {
      const n = Number(lm[1])
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      rotulados.push({ number: n, labels: body.labels })
      porNumero.get(n)?.labels.push(...body.labels)
      return json([])
    }
    const im = u.match(/\/issues\/(\d+)$/)
    if (im && method === 'GET') return json({ number: Number(im[1]), state: 'open' })
    return json({})
  }) as typeof fetch

  return Object.assign(impl, { rotulados, comentarios })
}

const UMA_TASK: IssueFalsa[] = [
  { number: 42, labels: ['gitorch:task'], body: 'sem bloqueio', title: 'Consertar o funil' },
]

describe('delegação que FALHA não deixa a issue parecendo delegada', () => {
  it('não aplica a etiqueta, não conta como delegada e escreve o motivo real na issue', async () => {
    const f = fakeFetch([...UMA_TASK])
    const avisosAoDono: string[] = []

    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({
        situacao: 'falhou',
        motivo: 'HTTP 400: FAILED_PRECONDITION — limite de sessões simultâneas atingido',
      }),
      avisarDono: async (m) => {
        avisosAoDono.push(m)
      },
    })

    // Nada de etiqueta: a issue tem que continuar parecendo o que é — por fazer.
    expect(f.rotulados).toEqual([])
    // E não pode entrar na contagem de delegadas, senão o teto do dia é
    // consumido por trabalho que nunca começou.
    expect(r.delegated).toEqual([])

    // O motivo fica escrito onde quem olha o quadro vai olhar — traduzido,
    // não cru: o texto do fornecedor pode carregar host interno ou payload, e
    // o repositório do cliente costuma ser público (ver `motivoPublicavel`).
    expect(f.comentarios).toHaveLength(1)
    expect(f.comentarios[0]?.number).toBe(42)
    expect(f.comentarios[0]?.texto).toContain('sessões de trabalho ocupadas')
    expect(f.comentarios[0]?.texto).not.toContain('FAILED_PRECONDITION')

    // E o dono é avisado, em português, com o número da issue dentro.
    expect(avisosAoDono).toHaveLength(1)
    expect(avisosAoDono[0]).toContain('#42')
  })

  it('a saída da missão DIZ que a delegação falhou — nunca "nada a delegar"', async () => {
    // Relatar como acordada vazia seria a mentira mais cara aqui: o descanso
    // pós-acordada-vazia calaria justamente o ciclo que precisa tentar de novo.
    const f = fakeFetch([...UMA_TASK])
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({ situacao: 'falhou', motivo: 'serviço fora do ar' }),
    })

    expect(r.output).toContain('#42')
    expect(r.noOp).toBe(false)
  })

  it('uma falha não derruba a próxima task do ciclo', async () => {
    const f = fakeFetch([
      { number: 1, labels: ['gitorch:task'], body: '', title: 'primeira' },
      { number: 2, labels: ['gitorch:task'], body: '', title: 'segunda' },
    ])
    let chamada = 0
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => {
        chamada += 1
        return chamada === 1
          ? { situacao: 'falhou' as const, motivo: 'primeira falhou' }
          : { situacao: 'criada' as const, sessionName: 'sessions/999' }
      },
    })

    expect(r.delegated).toEqual([2])
    expect(f.rotulados.map((l) => l.number)).toContain(2)
    expect(f.rotulados.map((l) => l.number)).not.toContain(1)
  })

  it('avisar o dono é BEST-EFFORT: notificador que lança não derruba o ciclo', async () => {
    const f = fakeFetch([...UMA_TASK])
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({ situacao: 'falhou', motivo: 'x' }),
      avisarDono: async () => {
        throw new Error('telegram fora do ar')
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.delegated).toEqual([])
  })
})

describe('o plano B continua de pé quando o recurso está DESLIGADO', () => {
  it('sem chave configurada, a etiqueta é aplicada como sempre foi', async () => {
    // Esta é a guarda contra "consertar" o sintoma mudo quebrando a
    // instalação que nunca teve dev assíncrono ligado.
    const f = fakeFetch([...UMA_TASK])
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({ situacao: 'desligado' }),
    })

    expect(r.delegated).toEqual([42])
    expect(f.rotulados.map((l) => l.number)).toContain(42)
    expect(f.comentarios).toEqual([])
  })

  it('sem `criarSessaoDev` nenhum, o comportamento antigo é preservado', async () => {
    const f = fakeFetch([...UMA_TASK])
    const r = await runSmDelegation({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(r.delegated).toEqual([42])
    expect(f.rotulados.map((l) => l.number)).toContain(42)
  })
})

describe('a sessão criada segue etiquetando e guardando a ligação', () => {
  it('etiqueta DEPOIS de o dev responder, e guarda a ligação issue↔sessão', async () => {
    const f = fakeFetch([...UMA_TASK])
    const ordem: string[] = []
    const ligacoes: Array<{ issueNumber: number; sessionName: string }> = []

    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url).match(/\/issues\/\d+\/labels$/) && (init?.method ?? 'GET') === 'POST') {
          ordem.push('etiquetou')
        }
        return f(url, init)
      }) as typeof fetch,
      criarSessaoDev: async () => {
        ordem.push('acionou o dev')
        return { situacao: 'criada', sessionName: 'sessions/777' }
      },
      aoCriarSessao: async (d) => {
        ligacoes.push(d)
      },
    })

    expect(r.delegated).toEqual([42])
    // A ordem é o conserto inteiro: acionar primeiro, prometer depois.
    expect(ordem[0]).toBe('acionou o dev')
    expect(ordem).toContain('etiquetou')
    expect(ligacoes).toEqual([{ issueNumber: 42, sessionName: 'sessions/777' }])
  })
})

// ── Achados das lentes (/code-review, 22/08/2026) ──────────────────────────
//
// Sete defeitos, todos introduzidos ou agravados por esta própria mudança.
// Os quatro que sobrevivem como teste estão aqui; os outros três moram nos
// arquivos que consertaram (listagem e varredura).

describe('a sessão que nasce mas não pode ser registrada', () => {
  it('é DESFEITA na hora, e a issue não fica parecendo delegada', async () => {
    // O pior cenário da mudança inteira, e não é hipotético: com a etiqueta
    // vindo antes, uma recusa do GitHub derrubava a função com a sessão viva
    // lá fora e nenhuma linha aqui — e a reconciliação de vagas, dez minutos
    // depois, encontrava exatamente isso e arquivava trabalho recém-começado.
    // Uma frente estava armando a outra.
    const f = fakeFetch([...UMA_TASK])
    const desfeitas: string[] = []

    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/orfa' }),
      aoCriarSessao: async () => {
        throw new Error('banco fora do ar')
      },
      desfazerSessao: async (nome) => {
        desfeitas.push(nome)
      },
    })

    expect(desfeitas).toEqual(['sessions/orfa'])
    expect(r.delegated).toEqual([])
    expect(f.rotulados).toEqual([])
  })

  it('a ligação é gravada ANTES da etiqueta — a ordem é o conserto', async () => {
    const f = fakeFetch([...UMA_TASK])
    const ordem: string[] = []

    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url).match(/\/issues\/\d+\/labels$/) && (init?.method ?? 'GET') === 'POST') {
          ordem.push('etiquetou')
        }
        return f(url, init)
      }) as typeof fetch,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/1' }),
      aoCriarSessao: async () => {
        ordem.push('gravou a ligação')
      },
    })

    expect(ordem.indexOf('gravou a ligação')).toBeLessThan(ordem.indexOf('etiquetou'))
  })

  it('desfazer que também falha não derruba o ciclo, só avisa', async () => {
    const f = fakeFetch([...UMA_TASK])
    const avisos: string[] = []
    const r = await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({ situacao: 'criada', sessionName: 'sessions/teimosa' }),
      aoCriarSessao: async () => {
        throw new Error('banco fora')
      },
      desfazerSessao: async () => {
        throw new Error('fornecedor fora')
      },
      onWarn: (m) => avisos.push(m),
    })
    expect(r.exitCode).toBe(0)
    expect(avisos.some((m) => m.includes('sessions/teimosa'))).toBe(true)
  })
})

describe('o comentário de recusa não vira spam', () => {
  it('só comenta UMA vez por issue, por mais ciclos que passem', async () => {
    // A issue recusada volta para a fila a cada acordada do SM — a fila lê
    // linhas de sessão, não etiquetas. Sem esta guarda, dois dias de
    // indisponibilidade empilhariam dezenas de comentários iguais no
    // repositório do cliente.
    const issues = [...UMA_TASK]
    const comentariosNoRepo: string[] = []

    const comFetch = () =>
      (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
        if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
          return json(issues.map((i) => ({ ...i, labels: i.labels.map((n) => ({ name: n })) })))
        }
        if (u.includes('/comments') && method === 'GET') {
          return json(comentariosNoRepo.map((body) => ({ body })))
        }
        if (u.includes('/comments') && method === 'POST') {
          comentariosNoRepo.push(String(JSON.parse(String(init?.body)).body))
          return json({})
        }
        return json({})
      }) as typeof fetch

    const avisos: string[] = []
    for (let ciclo = 0; ciclo < 3; ciclo += 1) {
      await runSmDelegation({
        repository: 'o/r',
        githubToken: 't',
        fetchImpl: comFetch(),
        criarSessaoDev: async () => ({ situacao: 'falhou', motivo: 'FAILED_PRECONDITION' }),
        avisarDono: async (m) => {
          avisos.push(m)
        },
      })
    }

    expect(comentariosNoRepo).toHaveLength(1)
    // O dono também é avisado uma vez só — ruído no Telegram é como o aviso
    // importante seguinte passa despercebido.
    expect(avisos).toHaveLength(1)
  })
})

describe('o motivo cru nunca chega ao repositório do cliente', () => {
  it('traduz a recusa e não publica host, IP nem corpo de erro', async () => {
    const f = fakeFetch([...UMA_TASK])
    await runSmDelegation({
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: f,
      criarSessaoDev: async () => ({
        situacao: 'falhou',
        motivo: 'HTTP 400: {"error":{"status":"FAILED_PRECONDITION"}} at 10.0.3.14:8443 interno',
      }),
    })

    const texto = f.comentarios[0]?.texto ?? ''
    expect(texto).not.toContain('10.0.3.14')
    expect(texto).not.toContain('FAILED_PRECONDITION')
    expect(texto).toContain('sessões de trabalho ocupadas')
  })
})
