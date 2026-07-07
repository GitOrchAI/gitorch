import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  runDeviceLogin,
  parseDevicePrompt,
  type DeviceLoginHandle,
  type DeviceRuntime,
} from '@gitorch/agents'
import type { EngineConnectionService } from './engine-connection.js'

const BINARY: Record<DeviceRuntime, string> = {
  codex: 'codex',
  claude: 'claude',
  antigravity: 'agy',
}

const ARGS: Record<DeviceRuntime, string[]> = {
  codex: ['login', '--device-auth'],
  claude: ['setup-token'],
  antigravity: [],
}

// Claude e Antigravity só emitem a URL sob PTY (spike 2026-07-07); Codex não
// precisa. Antigravity também precisa de 1 Enter inicial pra escolher
// "Google OAuth" no menu do TUI antes da URL aparecer.
const NEEDS_PTY: Record<DeviceRuntime, boolean> = { codex: false, claude: true, antigravity: true }
const NEEDS_INITIAL_ENTER: Record<DeviceRuntime, boolean> = {
  codex: false,
  claude: false,
  antigravity: true,
}

// `claude setup-token` imprime o token final no stdout (não grava arquivo) —
// formato confirmado (já usado como placeholder na tela antiga de paste-token).
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/

const CLAUDE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

export type LoginState =
  | { phase: 'starting' }
  | { phase: 'url_ready'; url: string; code?: string }
  | { phase: 'connected' }
  | { phase: 'error'; message: string }

interface Session {
  id: string
  userId: string
  runtime: DeviceRuntime
  handle: DeviceLoginHandle
  buffer: string
  state: LoginState
  subscribers: Array<(state: LoginState) => void>
  timeoutHandle: ReturnType<typeof setTimeout>
  // Backstop incondicional (ver `start()`): garante que uma captura
  // genuinamente travada para sempre (ex.: captureFromHome nunca resolve nem
  // rejeita) ainda assim libere a sessão, o container e o hostHome
  // (credencial em texto puro) eventualmente — em vez de ficar deferindo pra
  // `capturing` sem limite superior.
  absoluteTimeoutHandle: ReturnType<typeof setTimeout>
  // Marca uma captura de credencial em andamento (Claude via stdout, ou
  // Codex/Antigravity via captureFromHome no onExit). Serve dois propósitos:
  // 1) Guarda contra chamar captureClaudeToken mais de uma vez para a mesma
  //    sessão: o token, uma vez presente no buffer acumulado, casa a regex em
  //    todos os onStdout subsequentes (buffer nunca é limpo) — sem isto,
  //    qualquer stdout extra depois do token (linha em branco, prompt final do CLI)
  //    dispara captureFromHome e kill() de novo, concorrendo com a primeira
  //    captura ainda em andamento.
  // 2) Gate para o timeout de 5min (ver `start()`): se uma captura já está em
  //    andamento (para qualquer runtime), o timeout não deve chamar fail() —
  //    isso apagaria a sessão (cleanup) antes da captura resolver, e o
  //    setState({phase:'connected'}) posterior viraria um no-op silencioso —
  //    usuário veria "tempo esgotado" mesmo com a credencial capturada.
  capturing: boolean
}

export interface AssistedLoginOptions {
  image: string
  timeoutMs?: number
  runDeviceLoginImpl?: typeof runDeviceLogin
}

/**
 * Orquestra o login assistido de um motor (Codex/Claude/Antigravity) num
 * container isolado por sessão. Estado em memória — é efêmero por natureza
 * (login dura no máximo alguns minutos); perder numa reinicialização do
 * processo é aceitável (o usuário clica "conectar" de novo).
 */
export class AssistedLoginService {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly engineConnections: Pick<EngineConnectionService, 'captureFromHome'>,
    private readonly options: AssistedLoginOptions
  ) {}

  start(userId: string, runtime: DeviceRuntime): string {
    const id = randomUUID()
    const run = this.options.runDeviceLoginImpl ?? runDeviceLogin
    const handle = run({
      image: this.options.image,
      binary: BINARY[runtime],
      args: ARGS[runtime],
      usePty: NEEDS_PTY[runtime],
    })

    const session: Session = {
      id,
      userId,
      runtime,
      handle,
      buffer: '',
      state: { phase: 'starting' },
      subscribers: [],
      // Não falha se uma captura de credencial já está em andamento (ver
      // comentário em `capturing`) — a própria captura (sucesso ou catch) é
      // dona da transição terminal nesse caso. O timeout aqui só existe para
      // pegar logins que nunca chegaram nem perto de capturar nada (ex.:
      // usuário nunca aprovou a URL). Uma captura travada para sempre é
      // coberta pelo `absoluteTimeoutHandle` abaixo, que não tem esse guard.
      timeoutHandle: setTimeout(
        () => {
          const s = this.sessions.get(id)
          if (s && !s.capturing) this.fail(id, 'tempo esgotado; tente novamente')
        },
        this.options.timeoutMs ?? 5 * 60_000
      ),
      // Backstop: dispara incondicionalmente (sem checar `capturing`) depois
      // de um prazo bem mais largo. Um login/captura normal termina em
      // segundos a poucos minutos; este prazo só é atingido se
      // captureFromHome (ou qualquer outra promise da captura) travar de
      // verdade e nunca resolver nem rejeitar — cenário em que o timeout
      // principal deferiria pra sempre. Sem isto, a sessão, o container e o
      // hostHome (credencial em texto puro) nunca seriam liberados.
      // Multiplicador de 20x (não um valor menor tipo 3x): os testes que
      // provam que o timeout principal defere corretamente enquanto
      // `capturing` é true usam um `timeoutMs` artificialmente curto (10ms) e
      // esperam ~50ms reais antes de resolver a captura manualmente — um
      // multiplicador pequeno faria o backstop disparar DENTRO dessa janela
      // de espera do teste (falso positivo, sem nenhuma captura travada de
      // verdade). 20x dá margem confortável nesse cenário de teste e continua
      // sendo um backstop bem mais curto que "nunca" em produção (o único
      // caso em que ele importa é uma captura genuinamente travada).
      absoluteTimeoutHandle: setTimeout(
        () => this.fail(id, 'tempo esgotado (captura travada); tente novamente'),
        (this.options.timeoutMs ?? 5 * 60_000) * 20
      ),
      capturing: false,
    }
    this.sessions.set(id, session)

    if (NEEDS_INITIAL_ENTER[runtime]) handle.writeStdin('\n')

    handle.onStdout((chunk) => this.onStdout(id, chunk))
    handle.exited.then(({ code }) => this.onExit(id, code))

    return id
  }

  /**
   * Emite o estado atual imediatamente e passa a notificar mudanças futuras.
   *
   * `userId` é o dono autenticado que está chamando — precisa bater com o
   * `session.userId` gravado em `start()`. Sessão inexistente e sessão de
   * outro usuário retornam o MESMO `null`: não dá pra distinguir os dois
   * casos pelo valor de retorno (nem pela rota HTTP que consome isto), senão
   * um usuário autenticado poderia usar a resposta pra descobrir se um dado
   * `loginId` de outra pessoa existe (IDOR).
   */
  subscribe(id: string, userId: string, cb: (state: LoginState) => void): (() => void) | null {
    const session = this.sessions.get(id)
    if (!session || session.userId !== userId) return null
    session.subscribers.push(cb)
    cb(session.state)
    return () => {
      session.subscribers = session.subscribers.filter((s) => s !== cb)
    }
  }

  /**
   * O usuário colou de volta o código da página de OAuth (Claude/Antigravity).
   *
   * `userId` precisa bater com o dono da sessão (mesmo raciocínio de
   * `subscribe`): sessão inexistente e sessão de outro usuário lançam o
   * MESMO erro genérico, para não vazar (via mensagem de erro) se um dado
   * `loginId` pertence a outra pessoa.
   */
  submitCode(id: string, userId: string, code: string): void {
    const session = this.sessions.get(id)
    if (!session || session.userId !== userId) throw new Error('sessão de login não encontrada')
    session.handle.writeStdin(`${code.trim()}\n`)
  }

  private onStdout(id: string, chunk: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.buffer += chunk
    if (session.state.phase === 'connected' || session.state.phase === 'error') return

    // Continua reparseando enquanto a fase for 'starting' OU já tivermos a URL
    // mas ainda faltar o código (Codex): URL e código podem chegar em chunks
    // de stdout separados — parar de reparsear assim que 'url_ready' é
    // atingido faria o código nunca ser capturado se ele vier depois. Seguro
    // para runtimes sem código (claude/antigravity): `state.code` fica
    // undefined para sempre e o reparse é idempotente e barato.
    if (
      session.state.phase === 'starting' ||
      (session.state.phase === 'url_ready' && !session.state.code)
    ) {
      const prompt = parseDevicePrompt(session.buffer, session.runtime)
      if (prompt.url) {
        this.setState(id, {
          phase: 'url_ready',
          url: prompt.url,
          ...(prompt.code ? { code: prompt.code } : {}),
        })
      }
    }

    if (session.runtime === 'claude' && !session.capturing) {
      const token = session.buffer.match(CLAUDE_TOKEN_RE)?.[0]
      if (token) {
        session.capturing = true
        void this.captureClaudeToken(id, token)
      }
    }
  }

  private async captureClaudeToken(id: string, token: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.state.phase === 'connected' || session.state.phase === 'error') return
    try {
      const envDir = path.join(session.handle.hostHome, '.gitorch', 'env')
      await fs.mkdir(envDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(envDir, 'CLAUDE_CODE_OAUTH_TOKEN'), token, { mode: 0o600 })
      await this.engineConnections.captureFromHome(
        session.userId,
        'claude',
        session.handle.hostHome,
        {
          credentialKind: 'env',
          envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
          expiresAt: new Date(Date.now() + CLAUDE_TOKEN_TTL_MS),
        }
      )
      this.setState(id, { phase: 'connected' })
    } catch (err) {
      this.fail(id, (err as Error).message)
    } finally {
      session.handle.kill()
    }
  }

  private async onExit(id: string, code: number | null): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.state.phase === 'connected' || session.state.phase === 'error') return

    // Claude captura via stdout (captureClaudeToken), nunca via exit code. Se
    // uma captura já está em andamento (capturing), NÃO falhar aqui: o
    // processo pode legitimamente sair logo após imprimir o token, enquanto
    // captureClaudeToken ainda está no meio do seu chain assíncrono
    // (mkdir/writeFile/captureFromHome). Chamar fail() aqui apagaria a sessão
    // (cleanup) e o setState({phase:'connected'}) posterior de
    // captureClaudeToken viraria um no-op silencioso — usuário veria "error"
    // mesmo com a credencial capturada com sucesso. Deixamos o próprio
    // captureClaudeToken (sucesso ou catch) dono da transição terminal.
    if (session.runtime === 'claude') {
      if (session.capturing) return
      this.fail(id, `login encerrado sem token (código de saída ${code})`)
      return
    }
    if (code !== 0) {
      this.fail(id, `login encerrado com erro (código de saída ${code})`)
      return
    }
    try {
      // Marcado ANTES do await, de forma síncrona: fecha a mesma janela de
      // corrida que `capturing` fecha para o Claude — se o timeout de 5min
      // disparasse durante este await (captureFromHome pode ser lento: I/O
      // de disco + potencialmente rede), ele veria `capturing` já true (JS é
      // single-threaded, não há como o timeout intercalar entre este set e o
      // início do await) e não chamaria fail() nem apagaria a sessão.
      session.capturing = true
      await this.engineConnections.captureFromHome(
        session.userId,
        session.runtime,
        session.handle.hostHome
      )
      this.setState(id, { phase: 'connected' })
    } catch (err) {
      this.fail(id, (err as Error).message)
    }
  }

  private setState(id: string, state: LoginState): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.state = state
    for (const cb of session.subscribers) cb(state)
    if (state.phase === 'connected' || state.phase === 'error') this.cleanup(id)
  }

  private fail(id: string, message: string): void {
    this.setState(id, { phase: 'error', message })
  }

  private cleanup(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    clearTimeout(session.timeoutHandle)
    clearTimeout(session.absoluteTimeoutHandle)
    session.handle.kill()
    // Best-effort, fire-and-forget: hostHome é um diretório mkdtempSync no
    // host que pode conter credenciais em texto puro (.codex/auth.json,
    // .gemini/antigravity-cli/antigravity-oauth-token, ou o
    // CLAUDE_CODE_OAUTH_TOKEN escrito por captureClaudeToken). cleanup() é
    // chamado de forma síncrona a partir de setState() e precisa continuar
    // síncrono — não podemos `await` aqui. `.catch` garante que uma falha de
    // limpeza nunca vire unhandled rejection.
    void fs.rm(session.handle.hostHome, { recursive: true, force: true }).catch(() => undefined)
    this.sessions.delete(id)
  }
}
