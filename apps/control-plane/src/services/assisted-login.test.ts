import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { AssistedLoginService } from './assisted-login.js'

function fakeHandle() {
  const emitter = new EventEmitter()
  let resolveExited: (v: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((r) => {
    resolveExited = r
  })
  const handle = {
    hostHome: '/tmp/gitorch-assisted-login-test',
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

function fakeEngineConnections() {
  return { captureFromHome: vi.fn().mockResolvedValue({ runtime: 'x', status: 'connected' }) }
}

beforeEach(async () => {
  await fs.rm('/tmp/gitorch-assisted-login-test', { recursive: true, force: true })
})

describe('AssistedLoginService', () => {
  it('codex: url_ready assim que o stdout tem link+código, connected quando o processo sai 0', async () => {
    const { handle, emitStdout, emitExit } = fakeHandle()
    const engineConnections = fakeEngineConnections()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex')
    service.subscribe(id, 'user-1', (s) => states.push(s))

    emitStdout(
      'Open this link\nhttps://auth.openai.com/codex/device\nEnter this one-time code\nABCD-EFGH\n'
    )
    expect(states.at(-1)).toEqual({
      phase: 'url_ready',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
    })

    emitExit(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(engineConnections.captureFromHome).toHaveBeenCalledWith(
      'user-1',
      'codex',
      handle.hostHome
    )
    expect(states.at(-1)).toEqual({ phase: 'connected' })
  })

  it('claude: captura o token final do stdout (não do exit code) e mata o container', async () => {
    const { handle, emitStdout } = fakeHandle()
    const engineConnections = fakeEngineConnections()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'claude')
    service.subscribe(id, 'user-1', (s) => states.push(s))
    emitStdout('https://claude.com/cai/oauth/authorize?code=true&state=abc\n')
    service.submitCode(id, 'user-1', '  the-pasted-code  ')
    expect(handle.writeStdin).toHaveBeenCalledWith('the-pasted-code\n')

    emitStdout('Success! Your token:\nsk-ant-oat01-abc123XYZ\n')
    // captureClaudeToken grava em disco de verdade (mkdir+writeFile) antes de
    // chamar captureFromHome — mais de um tick de microtask, então um único
    // `setTimeout(r, 0)` (suficiente nos outros testes, que só aguardam um
    // mock já resolvido) não garante que a escrita real tenha terminado;
    // vi.waitFor faz polling até o mock ser chamado ou estourar o timeout.
    await vi.waitFor(() => {
      expect(engineConnections.captureFromHome).toHaveBeenCalledWith(
        'user-1',
        'claude',
        handle.hostHome,
        expect.objectContaining({ credentialKind: 'env', envVarName: 'CLAUDE_CODE_OAUTH_TOKEN' })
      )
    })
    expect(handle.kill).toHaveBeenCalled()
    expect(states.at(-1)).toEqual({ phase: 'connected' })
  })

  it('claude: stdout extra após o token já capturado não dispara nova captura nem novo kill', async () => {
    const { handle, emitStdout } = fakeHandle()
    const engineConnections = fakeEngineConnections()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    service.start('user-1', 'claude')
    emitStdout('Success! Your token:\nsk-ant-oat01-abc123XYZ\n')
    await vi.waitFor(() => {
      expect(engineConnections.captureFromHome).toHaveBeenCalledTimes(1)
    })
    // kill() já é chamado 2x por uma captura bem-sucedida (finally de
    // captureClaudeToken + cleanup() disparado pelo setState para
    // 'connected') — isto é comportamento pré-existente, não o que este teste
    // verifica. O que importa é que nenhuma chamada A MAIS aconteça a partir
    // daqui, ou seja: captureFromHome nunca de novo, kill nunca além do que já
    // ocorreu para esta única captura.
    const captureCallsAfterFirstToken = engineConnections.captureFromHome.mock.calls.length
    const killCallsAfterFirstToken = handle.kill.mock.calls.length

    // Chunk extra chega depois (linha em branco, prompt final do CLI etc.) —
    // o buffer acumulado ainda casa a regex do token, mas `capturing` já é
    // true, então não deve haver segunda captura nem kill adicional.
    emitStdout('sk-ant-oat01-abc123XYZ\n')
    await new Promise((r) => setTimeout(r, 0))
    expect(engineConnections.captureFromHome).toHaveBeenCalledTimes(captureCallsAfterFirstToken)
    expect(handle.kill).toHaveBeenCalledTimes(killCallsAfterFirstToken)
  })

  it('codex: URL e código chegando em chunks de stdout separados ainda resultam nos dois no estado final', () => {
    const { handle, emitStdout } = fakeHandle()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(fakeEngineConnections() as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex')
    service.subscribe(id, 'user-1', (s) => states.push(s))

    // URL chega primeiro, sozinha — sem o código ainda.
    emitStdout('Open this link\nhttps://auth.openai.com/codex/device\n')
    expect(states.at(-1)).toEqual({
      phase: 'url_ready',
      url: 'https://auth.openai.com/codex/device',
    })

    // Código chega depois, num chunk separado. Contra o código antigo (gate
    // `phase === 'starting'` apenas), isto nunca seria reparseado — a fase já
    // tinha virado 'url_ready' sem código, e o gate não reabria o reparse.
    emitStdout('Enter this one-time code\nABCD-EFGH\n')
    expect(states.at(-1)).toEqual({
      phase: 'url_ready',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
    })
  })

  it('antigravity: NÃO envia Enter no spawn; envia CR só depois do menu do TUI aparecer', () => {
    const { handle, emitStdout } = fakeHandle()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(fakeEngineConnections() as never, {
      image: 'img',
      runDeviceLoginImpl,
    })
    service.start('user-1', 'antigravity')

    // Regressão do bug real (08/07): mandar o Enter no spawn é uma corrida — o
    // container ainda nem desenhou o menu, o Enter se perde no vazio e a URL
    // nunca aparece ("fica girando"). Nada pode ser escrito no stdin antes do
    // menu.
    expect(handle.writeStdin).not.toHaveBeenCalled()

    // Quando o menu do TUI é desenhado, o serviço confirma "Google OAuth" (a
    // opção default) com CR ('\r', não '\n' — TUI em modo raw) — só então o
    // `agy` emite a URL do Google OAuth.
    emitStdout(
      ' Welcome to the Antigravity CLI. You are currently not signed in.\n' +
        ' Signing in... Select login method:\n > 1. Google OAuth\n'
    )
    expect(handle.writeStdin).toHaveBeenCalledWith('\r')
    expect(handle.writeStdin).toHaveBeenCalledTimes(1)

    // Chunks de stdout subsequentes (o menu redesenha, a URL chega etc.) não
    // podem reenviar o Enter — senão bagunçam o prompt de colar o código.
    emitStdout('...menu redraws... Select login method: ...\n')
    expect(handle.writeStdin).toHaveBeenCalledTimes(1)
  })

  it('subscribe emite o estado atual imediatamente (sem perder eventos de quem conecta depois)', () => {
    const { handle } = fakeHandle()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(fakeEngineConnections() as never, {
      image: 'img',
      runDeviceLoginImpl,
    })
    const id = service.start('user-1', 'codex')
    const cb = vi.fn()
    service.subscribe(id, 'user-1', cb)
    expect(cb).toHaveBeenCalledWith({ phase: 'starting' })
  })

  it('claude: timeout disparando com captura em andamento NÃO derruba a sessão; connected quando a captura resolve', async () => {
    const { handle, emitStdout } = fakeHandle()
    // Deferred controlável: simula captureFromHome ainda em voo quando o
    // timeout de 5min dispara (mesma corrida do finding, reproduzida
    // deterministicamente controlando quando a promise resolve).
    let resolveCaptureFromHome: (v: { runtime: string; status: string }) => void = () => undefined
    const captureFromHomePromise = new Promise<{ runtime: string; status: string }>((r) => {
      resolveCaptureFromHome = r
    })
    const engineConnections = { captureFromHome: vi.fn().mockReturnValue(captureFromHomePromise) }
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    // timeoutMs bem curto pra disparar de verdade dentro do teste (real-timer
    // based, sem fake timers — mais simples e o suficiente pra provar a
    // corrida) em vez de esperar 5 minutos reais.
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
      timeoutMs: 10,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'claude')
    service.subscribe(id, 'user-1', (s) => states.push(s))
    emitStdout('https://claude.com/cai/oauth/authorize?code=true&state=abc\n')
    service.submitCode(id, 'user-1', 'the-pasted-code')

    // Emite o token final: dispara captureClaudeToken, que grava em disco
    // (mkdir/writeFile reais) e então chama captureFromHome — que fica
    // pendurada na promise controlada acima (nunca resolvida ainda).
    emitStdout('Success! Your token:\nsk-ant-oat01-abc123XYZ\n')
    await vi.waitFor(() => {
      expect(engineConnections.captureFromHome).toHaveBeenCalled()
    })

    // Espera o timeout (10ms) disparar de verdade enquanto a captura ainda
    // está pendente. Pré-fix, isso chamaria fail() incondicionalmente aqui —
    // apagando a sessão e deixando o eventual setState({phase:'connected'})
    // de captureClaudeToken virar um no-op silencioso.
    await new Promise((r) => setTimeout(r, 50))
    expect(states.at(-1)).not.toEqual(
      expect.objectContaining({ phase: 'error', message: 'tempo esgotado; tente novamente' })
    )
    expect(states.at(-1)).not.toEqual({ phase: 'error' })

    // Agora resolve a captura — se a sessão sobreviveu ao timeout (fix
    // aplicado), isto deve levar o estado a 'connected'. Se a sessão foi
    // apagada pelo timeout (bug), setState vira no-op e o estado nunca
    // avança (ficaria travado em 'starting'/'url_ready' pra sempre, já que o
    // 'error' do timeout também não aconteceria neste teste específico — o
    // sintoma real do bug é reportado no finding: usuário vê "tempo esgotado"
    // quando o timeout NÃO tem o guard, o que este teste cobre acima).
    resolveCaptureFromHome({ runtime: 'claude', status: 'connected' })
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ phase: 'connected' })
    })
  })

  it('não-claude (codex/antigravity): timeout disparando com captureFromHome em andamento NÃO derruba a sessão', async () => {
    const { handle, emitExit } = fakeHandle()
    let resolveCaptureFromHome: (v: { runtime: string; status: string }) => void = () => undefined
    const captureFromHomePromise = new Promise<{ runtime: string; status: string }>((r) => {
      resolveCaptureFromHome = r
    })
    const engineConnections = { captureFromHome: vi.fn().mockReturnValue(captureFromHomePromise) }
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
      timeoutMs: 10,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex')
    service.subscribe(id, 'user-1', (s) => states.push(s))

    // Processo sai com sucesso: onExit marca `capturing = true` de forma
    // síncrona (fix) antes de aguardar captureFromHome, que fica pendurada.
    emitExit(0)
    await vi.waitFor(() => {
      expect(engineConnections.captureFromHome).toHaveBeenCalled()
    })

    // Timeout (10ms) dispara enquanto captureFromHome ainda está pendente.
    await new Promise((r) => setTimeout(r, 50))
    expect(states.at(-1)).not.toEqual(
      expect.objectContaining({ phase: 'error', message: 'tempo esgotado; tente novamente' })
    )

    resolveCaptureFromHome({ runtime: 'codex', status: 'connected' })
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ phase: 'connected' })
    })
  })

  it('timeout absoluto derruba a sessão mesmo com a captura travada pra sempre (nunca resolve nem rejeita)', async () => {
    const { handle, emitExit } = fakeHandle()
    // Promise deliberadamente nunca resolvida/rejeitada: simula
    // captureFromHome travado de verdade (ex.: chamada de DB que nunca
    // retorna) — não uma captura lenta-mas-viva como nos testes acima.
    const neverSettles = new Promise<{ runtime: string; status: string }>(() => undefined)
    const engineConnections = { captureFromHome: vi.fn().mockReturnValue(neverSettles) }
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    // timeoutMs: 10 -> timeout principal em 10ms (deferido por `capturing`),
    // timeout absoluto em 200ms (10 * 20) — suficiente pro teste não esperar
    // minutos reais.
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
      timeoutMs: 10,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex')
    service.subscribe(id, 'user-1', (s) => states.push(s))

    // Processo sai com sucesso: onExit marca `capturing = true` e chama
    // captureFromHome, que fica pendurada pra sempre.
    emitExit(0)
    await vi.waitFor(() => {
      expect(engineConnections.captureFromHome).toHaveBeenCalled()
    })

    // Aguarda bem além do timeout absoluto (200ms) sem nunca resolver a
    // captura. Pré-fix, o timeout principal deferiria pra sempre por
    // `capturing` continuar true, e a sessão (container + hostHome com
    // credencial em texto puro) nunca seria limpa.
    await vi.waitFor(
      () => {
        expect(states.at(-1)).toEqual({
          phase: 'error',
          message: 'tempo esgotado (captura travada); tente novamente',
        })
      },
      { timeout: 2000 }
    )
    expect(handle.kill).toHaveBeenCalled()
  })

  it('processo saindo != 0 (não-claude) vira erro, não connected', async () => {
    const { handle, emitExit } = fakeHandle()
    const engineConnections = fakeEngineConnections()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
    })
    const states: unknown[] = []
    const id = service.start('user-1', 'codex')
    service.subscribe(id, 'user-1', (s) => states.push(s))
    emitExit(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(engineConnections.captureFromHome).not.toHaveBeenCalled()
    expect(states.at(-1)).toEqual({
      phase: 'error',
      message: 'login encerrado com erro (código de saída 1)',
    })
  })

  it('IDOR: subscribe/submitCode de outro usuário não têm acesso à sessão (nem leem, nem escrevem); o dono continua funcionando', () => {
    const { handle } = fakeHandle()
    const engineConnections = fakeEngineConnections()
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(engineConnections as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const id = service.start('user-1', 'claude')

    // Atacante ('user-2') não é dono desta sessão: subscribe deve retornar
    // null (mesmo retorno de "loginId não existe" — não pode dar pra
    // distinguir os dois casos) e submitCode deve lançar o mesmo erro
    // genérico de "não encontrada", sem tocar no stdin do container.
    const attackerCb = vi.fn()
    expect(service.subscribe(id, 'user-2', attackerCb)).toBeNull()
    expect(attackerCb).not.toHaveBeenCalled()
    expect(() => service.submitCode(id, 'user-2', 'attacker-code')).toThrow(
      'sessão de login não encontrada'
    )
    expect(handle.writeStdin).not.toHaveBeenCalled()

    // Guarda de regressão: o dono legítimo ('user-1') continua funcionando
    // normalmente na MESMA sessão depois da tentativa do atacante.
    const ownerCb = vi.fn()
    const unsubscribe = service.subscribe(id, 'user-1', ownerCb)
    expect(unsubscribe).not.toBeNull()
    expect(ownerCb).toHaveBeenCalledWith({ phase: 'starting' })
    expect(() => service.submitCode(id, 'user-1', 'owner-code')).not.toThrow()
    expect(handle.writeStdin).toHaveBeenCalledWith('owner-code\n')
  })

  it('envHome (HOME do ambiente): makeHomeImpl aponta pro dir do ambiente e o cleanup NÃO o apaga — a credencial vive ali', async () => {
    const envHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-env-persist-'))
    // Sentinela: prova de que o dir (e o que o login gravou nele) sobrevive ao
    // cleanup do login — quem destrói é a faxina 24h se o wizard for abandonado.
    await fs.writeFile(path.join(envHome, 'sentinel'), 'x')

    const emitter = new EventEmitter()
    let resolveExited: (v: { code: number | null }) => void = () => undefined
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExited = r
    })
    let capturedMakeHome: (() => string) | undefined
    const runDeviceLoginImpl = vi
      .fn()
      .mockImplementation((opts: { makeHomeImpl?: () => string }) => {
        capturedMakeHome = opts.makeHomeImpl
        return {
          // Espelha o runDeviceLogin real: makeHomeImpl decide o hostHome.
          hostHome: opts.makeHomeImpl ? opts.makeHomeImpl() : '/tmp/should-not-happen',
          onStdout: (cb: (chunk: string) => void) => emitter.on('stdout', cb),
          writeStdin: vi.fn(),
          exited,
          kill: vi.fn(),
        }
      })
    const service = new AssistedLoginService(fakeEngineConnections() as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex', envHome)
    service.subscribe(id, 'user-1', (s) => states.push(s))

    // O HOME do container é o dir do ambiente do user, não um mkdtemp efêmero.
    expect(capturedMakeHome).toBeTypeOf('function')
    expect(capturedMakeHome!()).toBe(envHome)

    // Codex sai 0 → captura → connected → cleanup (estado terminal) roda.
    resolveExited({ code: 0 })
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ phase: 'connected' })
    })

    // cleanup rodou, mas por ser HOME persistente o dir do ambiente NÃO foi
    // apagado (senão cada login esvaziaria o ambiente, inclusive os clones).
    const sentinelSurvives = await fs
      .stat(path.join(envHome, 'sentinel'))
      .then(() => true)
      .catch(() => false)
    expect(sentinelSurvives).toBe(true)

    await fs.rm(envHome, { recursive: true, force: true })
  })

  it('sem envHome (fallback): HOME efêmero é apagado no cleanup — o guard é condicional, não um "nunca apagar"', async () => {
    const ephemeralHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-eph-'))
    await fs.writeFile(path.join(ephemeralHome, 'sentinel'), 'x')

    const emitter = new EventEmitter()
    let resolveExited: (v: { code: number | null }) => void = () => undefined
    const exited = new Promise<{ code: number | null }>((r) => {
      resolveExited = r
    })
    const handle = {
      hostHome: ephemeralHome,
      onStdout: (cb: (chunk: string) => void) => emitter.on('stdout', cb),
      writeStdin: vi.fn(),
      exited,
      kill: vi.fn(),
    }
    const runDeviceLoginImpl = vi.fn().mockReturnValue(handle)
    const service = new AssistedLoginService(fakeEngineConnections() as never, {
      image: 'img',
      runDeviceLoginImpl,
    })

    const states: unknown[] = []
    const id = service.start('user-1', 'codex') // sem envHome → HOME efêmero
    service.subscribe(id, 'user-1', (s) => states.push(s))

    resolveExited({ code: 0 })
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ phase: 'connected' })
    })

    // cleanup é fire-and-forget (fs.rm sem await) → poll até o HOME sumir.
    await vi.waitFor(async () => {
      const gone = await fs
        .stat(path.join(ephemeralHome, 'sentinel'))
        .then(() => false)
        .catch(() => true)
      expect(gone).toBe(true)
    })
  })
})
