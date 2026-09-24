import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { BuildAgentMissionInput, RuntimeExecutionResult } from '@gitorch/agents'

// INCIDENTE DE 21/08/2026, e por que este arquivo existe.
//
// A decisão do dono (D25) tirou o julgamento de ser BLOQUEADO pelo teto do dia,
// mas deixou a missão de julgamento CONTANDO no total — de propósito, com o
// argumento de que "ela existe e gasta recurso". O argumento vale para trabalho.
// Não valia para acordada em falso.
//
// O que aconteceu: 220 missões no dia, 143 delas devolvendo "não havia nada para
// julgar" — retorno que acontece ANTES de qualquer chamada ao motor (12,1s de
// média contra 25,4s de um julgamento real). O contador enxergou 220 contra um
// teto de 24 e passou a barrar ra, po e sm: "Failsafe da instância atingido
// (220/24); pulando sm". O ciclo inteiro parou, com um desejo recém registrado
// esperando o analista acordar.
//
// O conserto reusa o mecanismo que já existia para as falhas de credencial:
// duas contagens e uma subtração. Este teste prende esse comportamento pelo
// caminho REAL (`app.triggerAgentMission` → `runTrigger`), não por
// reimplementação — foi reimplementação de laço que deixou um bloco inteiro ser
// apagado sem quebrar teste nenhum neste mesmo arquivo de produção.
const resultadoDoMotor = vi.hoisted(() => ({
  atual: null as RuntimeExecutionResult | null,
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    AgentOrchestrator: class {
      constructor(_options: unknown) {}
      async runMission(_input: BuildAgentMissionInput): Promise<RuntimeExecutionResult> {
        return (
          resultadoDoMotor.atual ?? {
            missionId: 'irrelevante',
            runtime: 'antigravity',
            exitCode: 0,
            durationMs: 1,
            output: 'saída qualquer',
            stderr: '',
          }
        )
      }
    },
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  devPlan: null,
  accessSuspendedAt: null,
  accessSuspendedReason: null,
  isActive: true,
  user: null,
} as const

/**
 * Banco de mentira que responde à contagem CONFORME O FILTRO — é isso que
 * separa "total do dia" de "quantas foram acordada em falso". Um `count` que
 * devolve sempre o mesmo número não distinguiria o conserto do defeito.
 */
function buildFakePrisma(opcoes: {
  total: number
  vazias: number
  credencial?: number
  /** Quantas sobram quando as missões do papel isento são excluídas na origem. */
  semOIsento?: number
  /**
   * Quantas acordadas em falso existem CONTANDO as do papel isento. Existe para
   * pegar o furo real de 21/08: se a subtração não usar o mesmo filtro de tipo
   * do total, ela desconta o que o total nunca somou e o teto vira número
   * negativo — some sem avisar.
   */
  vaziasContandoOIsento?: number
}) {
  let missionCounter = 0
  const count = vi.fn(
    async (args?: {
      where?: { result?: { path?: string[] }; status?: unknown; type?: unknown }
    }) => {
      // A pergunta "quantas estão rodando AGORA" (teto de concorrência) filtra
      // por `status` e nada tem a ver com o total do dia. Responder o total aqui
      // faria toda tentativa morrer como 'busy' antes de o teto diário ser
      // sequer consultado — e o teste passaria a medir a coisa errada.
      if (args?.where?.status !== undefined) return 0
      // A contagem do dia agora EXCLUI na origem o tipo de missão do papel
      // isento — quem o teto não pode barrar não gasta o teto dos outros.
      // A ORDEM importa: depois do conserto as contagens de subtração TAMBÉM
      // levam filtro de tipo, então perguntar por `type` primeiro responderia
      // o total para uma pergunta que era sobre `noOp`. Desempata pelo campo
      // mais específico.
      const caminho = args?.where?.result?.path?.[0]
      if (caminho === 'noOp') {
        // O banco de verdade responde MAIS quando o filtro de tipo não está
        // presente. Reproduzir isso é o que separa a conta certa da errada.
        const temFiltroDeTipo = (args?.where as { type?: unknown } | undefined)?.type !== undefined
        if (!temFiltroDeTipo && opcoes.vaziasContandoOIsento !== undefined) {
          return opcoes.vaziasContandoOIsento
        }
        return opcoes.vazias
      }
      if (caminho === 'falhaDeCredencial') return opcoes.credencial ?? 0
      // Só depois de descartar as perguntas sobre `result` é que sobra a
      // pergunta pelo total do dia — que é a única com filtro de tipo e sem
      // caminho de JSON.
      if (args?.where?.type !== undefined) return opcoes.semOIsento ?? opcoes.total
      return opcoes.total
    }
  )
  return {
    prisma: {
      mission: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        count,
        create: vi.fn(async () => {
          missionCounter += 1
          return { id: `mission_${missionCounter}` }
        }),
      },
      project: { findFirst: vi.fn(async () => PROJETO) },
      telegramLink: { findUnique: vi.fn(async () => ({ status: 'unlinked', chatId: null })) },
    },
    count,
  }
}

async function tentarDisparar(fake: ReturnType<typeof buildFakePrisma>) {
  const app = Fastify({ logger: false })
  app.decorate('prisma', fake.prisma as never)
  await app.register(schedulerPlugin)
  return app.triggerAgentMission('ra', 'proj_1')
}

const ENV_KEYS = [
  'GITORCH_MAX_MISSIONS_PER_DAY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

describe('teto do dia × acordada em falso (incidente de 21/08/2026)', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env['GITORCH_MAX_MISSIONS_PER_DAY'] = '24'
    resultadoDoMotor.atual = null
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    vi.restoreAllMocks()
  })

  test('o número exato do incidente: 220 no dia, 143 em falso — o analista VOLTA a ser disparado', async () => {
    const fake = buildFakePrisma({ total: 220, vazias: 143 })

    const resultado = await tentarDisparar(fake)

    // 220 - 143 = 77. Ainda acima de 24, então continua barrado — e ESTÁ CERTO:
    // as 77 restantes foram trabalho de verdade. O conserto não é passar a
    // deixar tudo entrar; é parar de cobrar pelo que não aconteceu.
    expect(resultado.triggered).toBe(false)
    expect(resultado.reason).toBe('instance-failsafe')

    // O que importa provar aqui é que a subtração ACONTECE: o filtro por `noOp`
    // foi consultado. Sem esta consulta, o número seria 220 e a causa do
    // incidente continuaria de pé.
    const filtros = fake.count.mock.calls.map(
      (c) => (c[0] as { where?: { result?: { path?: string[] } } })?.where?.result?.path?.[0]
    )
    expect(filtros).toContain('noOp')
    expect(filtros).toContain('falhaDeCredencial')
  })

  test('o dia real do incidente: julgamento isento não gasta o teto de quem inicia trabalho', async () => {
    // Números medidos em 21/08: 225 missões no dia, 220 delas de julgamento
    // (65 de trabalho real, o resto acordada em falso). Descontar só as vazias
    // deixava 68 — ainda acima de 24, e ra/po/sm seguiam calados. Excluindo o
    // papel isento na origem sobram 5: as missões de quem de fato inicia
    // trabalho. É a diferença entre "o teto me protege" e "o teto me cala".
    const fake = buildFakePrisma({ total: 225, vazias: 157, semOIsento: 5 })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(true)

    // A exclusão tem que acontecer na CONSULTA, não por subtração: `type` é
    // coluna, e filtrar na origem evita o problema de NULL que obriga as duas
    // contagens do caso JSON.
    const filtrouPorTipo = fake.count.mock.calls.some(
      (c) => (c[0] as { where?: { type?: unknown } })?.where?.type !== undefined
    )
    expect(filtrouPorTipo).toBe(true)
  })

  test('rajada de acordadas em falso NÃO cala os outros papéis', async () => {
    // 30 missões no dia, 28 delas acordadas em falso: sobram 2 de trabalho real,
    // bem abaixo do teto de 24. Antes do conserto o contador via 30 e barrava.
    const fake = buildFakePrisma({ total: 30, vazias: 28 })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(true)
  })

  test('o teto do PLANO segue a mesma regra — a vaga paga não é cobrada por quem é isento', async () => {
    // Plano Pro do dono: 90 missões por dia. Em 21/08 houve 225 missões, 220
    // de julgamento. Contando tudo, o plano estourava e o analista morria em
    // 'plan-budget' mesmo depois de o failsafe da instância ter sido consertado
    // — o mesmo erro, uma camada abaixo, e nesta doeria mais: a vaga é paga.
    const fake = buildFakePrisma({ total: 225, vazias: 157, semOIsento: 5 })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(true)
    expect(resultado.reason).not.toBe('plan-budget')
  })

  test('a subtração usa o MESMO filtro do total — senão o teto vira número negativo', async () => {
    // O furo real de 21/08, com a forma exata: o total passou a excluir o papel
    // isento, mas as subtrações continuaram contando TUDO. Medido em produção
    // uma hora depois: 17 - 0 - 174 = -157, e o teto do dia simplesmente
    // deixou de existir, em silêncio.
    //
    // Números escolhidos para que a conta CERTA barre e a ERRADA deixe passar:
    // certo  = 30 - 2   = 28  -> acima do teto de 24, barra
    // errado = 30 - 100 = -70 -> abaixo de tudo, passa
    const fake = buildFakePrisma({
      total: 30,
      vazias: 2,
      vaziasContandoOIsento: 100,
      semOIsento: 30,
    })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(false)
    expect(resultado.reason).toBe('instance-failsafe')
  })

  test('trabalho de verdade continua barrando, como sempre barrou', async () => {
    // Mesmas 30 missões, nenhuma em falso: o teto tem que segurar. É a guarda
    // contra "consertar" o incidente afrouxando a proteção.
    const fake = buildFakePrisma({ total: 30, vazias: 0 })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(false)
    expect(resultado.reason).toBe('instance-failsafe')
  })

  test('falha de credencial e acordada em falso somam na subtração, sem dupla contagem', async () => {
    // 30 no dia: 10 morreram pedindo login, 18 acordaram em falso. Sobram 2.
    const fake = buildFakePrisma({ total: 30, vazias: 18, credencial: 10 })

    const resultado = await tentarDisparar(fake)

    expect(resultado.triggered).toBe(true)
  })
})
