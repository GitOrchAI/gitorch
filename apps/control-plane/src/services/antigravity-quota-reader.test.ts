import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseAntigravityUsageWindows,
  antigravityUsageScreenToQuotaReading,
  makeAntigravityQuotaReaderPty,
} from './antigravity-quota-reader.js'

// Fixture reconstruída FIELMENTE a partir do texto colado pelo dono (não é
// bytes capturados do agy real — mesmo status das telas sintéticas de
// onboarding em assisted-login.test.ts, describe E3). Formato provado ao
// vivo 21/07 (docs/operations/engine-collection-real-steps.md): por grupo de
// modelo, "Weekly Limit"/"Five Hour Limit ... NN.NN%" + legenda na linha de
// baixo.
const USAGE_SCREEN_FIXTURE = readFileSync(
  fileURLToPath(new URL('./__fixtures__/agy-usage-screen.stdout.txt', import.meta.url)),
  'utf8'
)

const FIXED_NOW = 1_700_000_000_000
const now = () => FIXED_NOW

function fakeAgyHandle() {
  const emitter = new EventEmitter()
  let resolveExited: (v: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((r) => {
    resolveExited = r
  })
  const handle = {
    onStdout: (cb: (chunk: string) => void) => emitter.on('stdout', cb),
    writeStdin: vi.fn(),
    exited,
    kill: vi.fn(),
  }
  return {
    handle,
    emitStdout: (chunk: string) => emitter.emit('stdout', chunk),
    emitExit: (code: number | null) => resolveExited({ code }),
  }
}

afterEach(() => {
  delete process.env['GITORCH_ANTIGRAVITY_QUOTA_REMAINING']
  delete process.env['GITORCH_ANTIGRAVITY_QUOTA_TOTAL']
  delete process.env['GITORCH_AGY_BIN']
})

describe('parseAntigravityUsageWindows', () => {
  it('extrai as 4 janelas da fixture real (2 grupos x 2 janelas), ignorando o cabeçalho do grupo', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    expect(windows).toHaveLength(4)

    const weekly = windows.filter((w) => w.kind === 'weekly')
    const fiveHour = windows.filter((w) => w.kind === 'five_hour')
    expect(weekly).toHaveLength(2)
    expect(fiveHour).toHaveLength(2)
  })

  // Fixture = tela REAL capturada ao vivo do dono (21/07): o rótulo, a barra e
  // o caption em LINHAS SEPARADAS (o formato antigo, tudo numa linha, era
  // inventado e nunca casava o produto — causa da quota nula no reteste).
  it('SEMÂNTICA (o ponto fácil de errar): barra 80.82% + "81% remaining" -> percentUsed ≈ 19.18 (100 - barra)', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    const geminiWeekly = windows.find((w) => w.kind === 'weekly' && w.percentRemaining === 80.82)
    expect(geminiWeekly).toBeDefined()
    expect(geminiWeekly?.percentUsed).toBeCloseTo(19.18, 2)
  })

  it('barra 92.91% (five hour) -> percentUsed ≈ 7.09', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    const geminiFiveHour = windows.find(
      (w) => w.kind === 'five_hour' && w.percentRemaining === 92.91
    )
    expect(geminiFiveHour?.percentUsed).toBeCloseTo(7.09, 2)
  })

  it('"Quota available" (barra 100.00%) -> percentUsed = 0, resetsAt null (nada a esperar)', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    const full = windows.filter((w) => w.percentRemaining === 100)
    expect(full).toHaveLength(2) // Claude/GPT: weekly + five_hour
    for (const w of full) {
      expect(w.percentUsed).toBe(0)
      expect(w.resetsAt).toBeNull()
    }
  })

  it('"Refreshes in 21h 25m" vira resetsAt = now + 21h25m em ISO', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    const geminiWeekly = windows.find((w) => w.kind === 'weekly' && w.percentRemaining === 80.82)
    const expected = new Date(FIXED_NOW + (21 * 3600 + 25 * 60) * 1000).toISOString()
    expect(geminiWeekly?.resetsAt).toBe(expected)
  })

  it('"Refreshes in 4h 20m" vira resetsAt = now + 4h20m em ISO', () => {
    const windows = parseAntigravityUsageWindows(USAGE_SCREEN_FIXTURE, now)
    const geminiFiveHour = windows.find(
      (w) => w.kind === 'five_hour' && w.percentRemaining === 92.91
    )
    const expected = new Date(FIXED_NOW + (4 * 3600 + 20 * 60) * 1000).toISOString()
    expect(geminiFiveHour?.resetsAt).toBe(expected)
  })

  it('texto sem nenhuma janela reconhecível -> lista vazia (nunca lança)', () => {
    expect(parseAntigravityUsageWindows('nada aqui parece com uma tela de quota', now)).toEqual([])
    expect(parseAntigravityUsageWindows('', now)).toEqual([])
  })

  it('aceita "34h" ou "59m" isolados na legenda (janela só com horas ou só com minutos)', () => {
    // Formato REAL: rótulo numa linha, barra+% na seguinte, caption na terceira.
    const onlyHours = '  Weekly Limit\n    [████] 50.00%\n    50% remaining · Refreshes in 10h\n'
    const onlyMinutes =
      '  Five Hour Limit\n    [████] 50.00%\n    50% remaining · Refreshes in 45m\n'
    const w1 = parseAntigravityUsageWindows(onlyHours, now)
    expect(w1[0]?.resetsAt).toBe(new Date(FIXED_NOW + 10 * 3600 * 1000).toISOString())
    const w2 = parseAntigravityUsageWindows(onlyMinutes, now)
    expect(w2[0]?.resetsAt).toBe(new Date(FIXED_NOW + 45 * 60 * 1000).toISOString())
  })
})

describe('antigravityUsageScreenToQuotaReading (pior caso entre grupos)', () => {
  it('escolhe o PIOR CASO por janela, independente entre grupos (weekly do Gemini, five_hour também do Gemini aqui, mas cada um calculado à parte)', () => {
    const reading = antigravityUsageScreenToQuotaReading(USAGE_SCREEN_FIXTURE, now)
    expect(reading.remaining).toBeNull()
    expect(reading.total).toBeNull()
    expect(reading.weekPercentUsed).toBeCloseTo(19.18, 2) // Gemini pior que Claude/GPT (0)
    expect(reading.sessionPercentUsed).toBeCloseTo(7.09, 2) // Gemini pior que Claude/GPT (0)
    expect(reading.weekResetsAt).toBe(
      new Date(FIXED_NOW + (21 * 3600 + 25 * 60) * 1000).toISOString()
    )
    expect(reading.sessionResetsAt).toBe(
      new Date(FIXED_NOW + (4 * 3600 + 20 * 60) * 1000).toISOString()
    )
  })

  it('pior caso vem de grupos DIFERENTES por janela quando aplicável', () => {
    // Grupo A: semana gasta (90% used), sessão zerada. Grupo B: semana zerada,
    // sessão gasta (70% used). O pior caso de CADA janela deve vir do grupo
    // certo, não sempre do mesmo grupo.
    const text =
      'GROUP A\n' +
      '  Weekly Limit\n    [████] 10.00%\n    10% remaining · Refreshes in 1h 0m\n' +
      '  Five Hour Limit\n    [████] 100.00%\n    Quota available\n' +
      'GROUP B\n' +
      '  Weekly Limit\n    [████] 100.00%\n    Quota available\n' +
      '  Five Hour Limit\n    [████] 30.00%\n    30% remaining · Refreshes in 2h 0m\n'
    const reading = antigravityUsageScreenToQuotaReading(text, now)
    expect(reading.weekPercentUsed).toBeCloseTo(90, 2) // Group A
    expect(reading.sessionPercentUsed).toBeCloseTo(70, 2) // Group B
  })

  it('nenhuma janela reconhecida -> tudo null (nunca lança)', () => {
    const reading = antigravityUsageScreenToQuotaReading('texto qualquer', now)
    expect(reading).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })
})

describe('makeAntigravityQuotaReaderPty (reader com PTY fake — nunca sobe o agy real)', () => {
  it('override por ambiente vence tudo — nunca sobe o agy', async () => {
    process.env['GITORCH_ANTIGRAVITY_QUOTA_REMAINING'] = '5'
    process.env['GITORCH_ANTIGRAVITY_QUOTA_TOTAL'] = '10'
    const runImpl = vi.fn()
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl })
    expect(await reader('/home/x')).toEqual({ remaining: 5, total: 10 })
    expect(runImpl).not.toHaveBeenCalled()
  })

  it('sobe o agy com o homeDir recebido e o agyBin default', () => {
    const { handle } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl })
    void reader('/home/cliente-x')
    expect(runImpl).toHaveBeenCalledWith({ homeDir: '/home/cliente-x', agyBin: 'agy' })
  })

  it('agyBin explícito é repassado', () => {
    const { handle } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({
      runAgyChatCommandImpl: runImpl,
      agyBin: '/opt/custom/agy',
    })
    void reader('/home/x')
    expect(runImpl).toHaveBeenCalledWith({ homeDir: '/home/x', agyBin: '/opt/custom/agy' })
  })

  it('GITORCH_AGY_BIN do ambiente é usado quando agyBin não é passado', () => {
    process.env['GITORCH_AGY_BIN'] = '/env/agy'
    const { handle } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl })
    void reader('/home/x')
    expect(runImpl).toHaveBeenCalledWith({ homeDir: '/home/x', agyBin: '/env/agy' })
  })

  it('detecta o chat pronto ("? for shortcuts"), manda /usage + Enter, parseia a tela e resolve', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({
      runAgyChatCommandImpl: runImpl,
      now,
      quietMs: 5,
    })
    const promise = reader('/home/x')

    emitStdout('Bem-vindo ao Antigravity\n? for shortcuts\n')
    await vi.waitFor(() => {
      expect(handle.writeStdin).toHaveBeenCalledWith('/usage')
    })
    await vi.waitFor(() => {
      expect(handle.writeStdin).toHaveBeenCalledWith('\r')
    })

    emitStdout(USAGE_SCREEN_FIXTURE)

    const reading = await promise
    expect(reading.weekPercentUsed).toBeCloseTo(19.18, 2)
    expect(reading.sessionPercentUsed).toBeCloseTo(7.09, 2)
    // Sai limpo: Esc antes do kill.
    expect(handle.writeStdin).toHaveBeenLastCalledWith('\x1b')
    expect(handle.kill).toHaveBeenCalledTimes(1)
  })

  it('não confunde telas de onboarding (que também começam com ">") com o chat pronto', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl, now })
    void reader('/home/x')

    emitStdout(
      '\n Do you trust the contents of this project?\n > Yes, I trust this folder\n   No, exit\n'
    )
    // A tela de trust-folder É confirmada (onboarding), mas isso NÃO deve
    // disparar o envio de /usage — só "? for shortcuts" dispara.
    expect(handle.writeStdin.mock.calls.some((c) => c[0] === '/usage')).toBe(false)
  })

  it('trata onboarding (color-scheme → ToS → trust-folder) ANTES de mandar /usage', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({
      runAgyChatCommandImpl: runImpl,
      now,
      quietMs: 5,
    })
    const promise = reader('/home/x')

    emitStdout('Choose your color scheme\n [Next]\n')
    expect(handle.writeStdin).toHaveBeenCalledWith('\r')
    expect(handle.writeStdin.mock.calls.some((c) => c[0] === '/usage')).toBe(false)

    emitStdout(
      '\n Terms of Service & Data Use\n [x] I agree to the Terms of Service and Privacy Policy\n [Previous]  [Done]\n'
    )
    await vi.waitFor(() => {
      expect(
        handle.writeStdin.mock.calls.filter((c) => c[0] === '\r').length
      ).toBeGreaterThanOrEqual(2)
    })
    expect(handle.writeStdin.mock.calls.some((c) => c[0] === '/usage')).toBe(false)

    emitStdout(
      '\n Do you trust the contents of this project?\n > Yes, I trust this folder\n   No, exit\n'
    )
    expect(handle.writeStdin.mock.calls.some((c) => c[0] === '/usage')).toBe(false)

    // SÓ agora o chat está pronto de verdade.
    emitStdout('Bem-vindo\n? for shortcuts\n')
    await vi.waitFor(() => {
      expect(handle.writeStdin.mock.calls.some((c) => c[0] === '/usage')).toBe(true)
    })

    emitStdout(USAGE_SCREEN_FIXTURE)
    const reading = await promise
    expect(reading.weekPercentUsed).toBeCloseTo(19.18, 2)
  })

  it('onboarding em loop (teto estourado) -> tudo null, mata o processo (nunca trava)', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl, now })
    const promise = reader('/home/x')

    for (let i = 1; i <= 9; i++) {
      emitStdout(`Tela desconhecida número ${i}:\n [Next]\n`)
    }

    const reading = await promise
    expect(reading).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
    expect(handle.kill).toHaveBeenCalledTimes(1)
  })

  it('processo sai sem nunca mostrar a tela do /usage -> tudo null (best-effort)', async () => {
    const { handle, emitExit } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl })
    const promise = reader('/home/x')

    emitExit(1)

    const reading = await promise
    expect(reading.weekPercentUsed).toBeNull()
    expect(reading.sessionPercentUsed).toBeNull()
  })

  it('timeout duro: nada acontece -> tudo null, nunca lança nem trava', async () => {
    const { handle } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl, timeoutMs: 20 })

    const reading = await reader('/home/x')
    expect(reading).toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
    expect(handle.kill).toHaveBeenCalledTimes(1)
  })

  it('subir o agy sob PTY lança (binário ausente etc.) -> tudo null, nunca lança', async () => {
    const runImpl = vi.fn(() => {
      throw new Error('spawn agy ENOENT')
    })
    const reader = makeAntigravityQuotaReaderPty({ runAgyChatCommandImpl: runImpl })
    await expect(reader('/home/x')).resolves.toEqual({
      remaining: null,
      total: null,
      sessionPercentUsed: null,
      sessionResetsAt: null,
      weekPercentUsed: null,
      weekResetsAt: null,
    })
  })

  it('erro inesperado processando stdout (ex.: `now` lança) -> tudo null, nunca deixa a exceção escapar', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const throwingNow = () => {
      throw new Error('boom')
    }
    const reader = makeAntigravityQuotaReaderPty({
      runAgyChatCommandImpl: runImpl,
      now: throwingNow,
    })
    const promise = reader('/home/x')

    expect(() => emitStdout(USAGE_SCREEN_FIXTURE)).not.toThrow()

    const reading = await promise
    expect(reading.weekPercentUsed).toBeNull()
  })

  it('espera um pequeno silêncio de stdout antes de fechar (protege o pior-caso de um grupo que ainda não terminou de chegar)', async () => {
    const { handle, emitStdout } = fakeAgyHandle()
    const runImpl = vi.fn().mockReturnValue(handle)
    const reader = makeAntigravityQuotaReaderPty({
      runAgyChatCommandImpl: runImpl,
      now,
      quietMs: 50,
    })
    const promise = reader('/home/x')

    // Chega em duas partes: primeiro só o grupo com a pior janela (10%
    // restante), depois — ainda DENTRO do silêncio — um segundo grupo com
    // janela pior ainda (5% restante). O resultado final tem que refletir o
    // PIOR entre os dois, não só o primeiro a chegar.
    emitStdout(
      'GROUP A\n  Weekly Limit\n    [████] 10.00%\n    10% remaining · Refreshes in 1h 0m\n'
    )
    await new Promise((r) => setTimeout(r, 20)) // < quietMs — ainda não fechou
    emitStdout('GROUP B\n  Weekly Limit\n    [████] 5.00%\n    5% remaining · Refreshes in 2h 0m\n')

    const reading = await promise
    expect(reading.weekPercentUsed).toBeCloseTo(95, 2) // 100 - 5 (pior entre 90 e 95)
  })
})
