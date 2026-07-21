import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  runDeviceLogin,
  parseDevicePrompt,
  extractClaudeToken,
  type DeviceLoginHandle,
  type DeviceRuntime,
} from '@gitorch/agents'
import type { EngineConnectionService } from './engine-connection.js'
import { redactSecrets } from './engine-liveness.js'
import {
  AntigravityOnboardingScanner,
  MAX_ONBOARDING_AUTO_CONFIRMS,
} from './antigravity-screens.js'

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
// precisa.
const NEEDS_PTY: Record<DeviceRuntime, boolean> = { codex: false, claude: true, antigravity: true }

// Antigravity abre um menu TUI ("Select login method") e só emite a URL depois
// de "Google OAuth" (a opção default) ser confirmada com Enter. Esse Enter tem
// que ir DEPOIS do menu ser desenhado: mandá-lo no spawn (como era antes) é uma
// corrida — o container ainda nem subiu o `agy`, o Enter se perde no vazio e a
// URL nunca aparece (o sintoma "fica girando"). Além disso, sob o PTY em modo
// raw do TUI, Enter é CR ('\r'), não LF. Confirmado reproduzindo contra o
// binário real (08/07): Enter-após-menu com '\r' faz a URL do Google OAuth sair
// inteira; Enter-no-spawn não produz URL nenhuma.
const MENU_SELECT_MARKER: Partial<Record<DeviceRuntime, RegExp>> = {
  antigravity: /select login method/i,
}

// Antigravity chegou no CHAT (logado). CAUSA RAIZ do "tempo esgotado" achado
// ao vivo (21/07): ao contrário do Codex (device-auth, que SAI após o login →
// dispara onExit → captura), o `agy` depois do login+onboarding ABRE o chat
// interativo e fica VIVO PARA SEMPRE — o onExit nunca dispara, a captura nunca
// roda, e a sessão morria no timeout de 5min (o log mostrava o chat pronto,
// "? for shortcuts" + "(Google AI Pro)", mas o estado travado em url_ready).
// A credencial (antigravity-oauth-token) já foi gravada em disco pelo OAuth
// bem-sucedido bem antes do chat; o prompt do chat é o sinal inequívoco de que
// login+onboarding terminaram. Ao detectá-lo, NÓS matamos o processo e
// capturamos (ver `captureAntigravityAfterChat`). "? for shortcuts" é a linha
// de rodapé fixa do chat do agy — não aparece em nenhuma tela de login/
// onboarding, então é um marcador seguro. Casa no buffer cru (o texto vem
// cercado de ANSI, mas a substring literal está lá).
const ANTIGRAVITY_CHAT_READY_MARKER = /\? for shortcuts/i

// CORREÇÃO 21/07 — o PR#359 (histórico BUG 2/BUG 3 abaixo) tinha a ORDEM e as
// TELAS erradas. Testando AO VIVO contra a conta do dono, num container
// isolado (ver docs/operations/engine-collection-real-steps.md, seção
// Antigravity), a sequência REAL pós-OAuth do Antigravity (agy 1.1.4/1.1.5),
// EM ORDEM, é:
//   1. "Choose your color scheme" → botão [Next]. Enter confirma. É a
//      PRIMEIRA tela real — ANTES do consentimento/ToS, não depois.
//   2. "Terms of Service & Data Use" → checkbox `[x]` JÁ MARCADA + botões
//      [Previous] [Done]. O foco inicial é a CHECKBOX: Enter aqui TOGGLA
//      (desmarca!), nunca confirma. Confirma navegando até "Done": Down (sai
//      da checkbox, foca "Previous") → Right (foca "Done") → Enter.
//   3. "Do you trust the contents of this project?" → "Yes, I trust this
//      folder" / "No, exit" — SEM colchetes. Foco já em "Yes"; Enter confirma.
//   4. Chat principal (logado).
// O PR#359 assumia a ordem `menu → consentimento → onboarding genérico por
// colchetes`, gateando a detecção do onboarding em `consentConfirmed`: como o
// color-scheme (que TEM colchetes) chega ANTES do consentimento na vida
// real, aquele gate impedia a confirmação da 1a tela de verdade; mandar um
// único CR na tela de ToS DESMARCAVA a checkbox em vez de confirmar; e a
// tela de trust-folder (sem colchetes) nunca casava o marker genérico de
// qualquer forma — o login travava nela pra sempre.
//
// Redesenho: cada tela conhecida é reconhecida pelo seu TEXTO identificador
// (mais robusto que só o botão — trust-folder nem TEM botão entre
// colchetes) e tem sua PRÓPRIA ação de confirmação. A detecção NÃO depende
// de `consentConfirmed` nem de um contador rígido de ordem: cada detector
// age quando SUA tela aparece, tolerando versões do agy que troquem a ordem
// ou insiram telas extras. Um fallback genérico (mesmo padrão de colchetes
// de antes) cobre telas DESCONHECIDAS (futuras versões do agy — keybindings,
// usage mode, telemetria, conforme sugerido pelas strings do binário) com o
// mesmo teto anti-loop de sempre.
//
// EXTRAÍDO (21/07) pra `antigravity-screens.ts`: as definições das telas
// (`ANTIGRAVITY_ONBOARDING_SCREENS`), o fallback genérico e o SCANNER
// (`AntigravityOnboardingScanner`, ver `processAntigravityOnboarding`
// abaixo) viraram a FONTE ÚNICA DE VERDADE reusada por
// `antigravity-quota-reader.ts` — que enfrenta o MESMO onboarding num HOME
// recém-materializado antes de conseguir abrir o chat e mandar `/usage`.
// Nenhuma mudança de COMPORTAMENTO nesta extração (mesmos matchers, mesmas
// ações, mesmo teto) — só o código movido de lugar.

// Pequeno atraso entre o código e o Enter em `submitCode` (BUG 1, diagnóstico
// 20/07): ver o comentário em `submitCode` para a causa raiz completa.
const SUBMIT_CODE_ENTER_DELAY_MS = 75

// Investigação E2 (13/07): a hipótese de que este ÚNICO '\r' "vaza" no widget
// de colar código como um submit vazio (agy saindo sozinho code=0 em ~300ms,
// ANTES do usuário poder colar) NÃO reproduziu iterando contra o binário real
// (agy 1.0.16, container localhost/gitorch-agent:latest, sem mocks, via um
// harness ad-hoc que chamava runDeviceLogin de verdade): o processo ficou
// vivo minutos parado no widget, sobreviveu a um submitCode() com código de
// teste (tentou de verdade a troca OAuth com o Google, "Malformed auth code"
// — esperado) e só terminou quando o próprio timeout/kill do teste agiu. O
// "AUTO-SAI em ~300ms" observado antes batia com
// scripts/dev/capture-cli-stdout.ts chamando handle.kill() (de propósito)
// assim que a URL aparece no buffer — não com uma saída espontânea do agy. O
// bug REAL encontrado (e corrigido) foi outro: PTY_COLS estreito demais pra a
// URL do Antigravity, corrigido em device-login-runner.ts — ver o comentário
// lá e os testes "E2" em assisted-login.test.ts (fixture real A2,
// agy-login.stdout.txt).

const CLAUDE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

export type LoginState =
  | { phase: 'starting' }
  | { phase: 'url_ready'; url: string; code?: string }
  // models/quota são a prova de vida que a liveness (captureFromHome) trouxe no
  // mesmo passo que confirmou 'connected'. Vão no evento SSE para o card
  // conectado renderizar "N modelos · quota X" AO VIVO, sem depender do refetch.
  // `quota` é omitido (não `undefined`) quando o provider não expõe quota.
  //
  // BUG DE INTEGRAÇÃO (achado ao vivo 21/07): os campos de quota REAL de
  // sessão/semana (Claude via API, Codex via rate_limits, Antigravity via
  // /usage — ver quota-reader.ts) chegam no `ConnectionStatus` que
  // captureFromHome devolve, mas ANTES desta correção o setState 'connected'
  // só repassava `models` + `quota` (número). Resultado: no login AO VIVO, o
  // dono via os modelos do Claude mas NENHUMA quota — os campos existiam no
  // backend e o front já sabia lê-los (normalizeLoginState/claudeUsageFields),
  // só nunca eram ENVIADOS pelo evento SSE. Agora o LoginState connected
  // carrega os 4 campos, e `connectedStateFrom` os propaga do ConnectionStatus.
  | {
      phase: 'connected'
      models?: unknown
      quota?: number
      sessionPercentUsed?: number | null
      sessionResetsAt?: string | null
      weekPercentUsed?: number | null
      weekResetsAt?: string | null
    }
  | { phase: 'error'; message: string }

// O que captureFromHome devolve (models + quota real, incluindo os campos de
// sessão/semana coletados na liveness). Tipado a partir do próprio método pra
// não depender de um import extra do ConnectionStatus.
type CapturedStatus = Awaited<ReturnType<EngineConnectionService['captureFromHome']>>

// Monta o LoginState 'connected' a partir do ConnectionStatus que a liveness
// produziu — a FONTE ÚNICA que os dois caminhos de captura (Claude via stdout,
// Codex/Antigravity via onExit) usam. Propaga TODOS os campos de quota (o
// número legado `quota` E os campos de sessão/semana), cada um só quando
// presente (nunca força `undefined`/`null` no evento). Antes desta função, os
// campos de sessão/semana existiam no `st` mas eram descartados aqui — o card
// AO VIVO ficava sem quota (ver o comentário do LoginState connected acima).
function connectedStateFrom(st: CapturedStatus): LoginState {
  return {
    phase: 'connected',
    models: st.models,
    ...(st.quotaRemaining != null ? { quota: st.quotaRemaining } : {}),
    ...(st.sessionPercentUsed != null ? { sessionPercentUsed: st.sessionPercentUsed } : {}),
    ...(st.sessionResetsAt != null ? { sessionResetsAt: st.sessionResetsAt } : {}),
    ...(st.weekPercentUsed != null ? { weekPercentUsed: st.weekPercentUsed } : {}),
    ...(st.weekResetsAt != null ? { weekResetsAt: st.weekResetsAt } : {}),
  }
}

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
  // Antigravity: já confirmamos "Google OAuth" no menu do TUI (mandamos o CR
  // uma vez, quando "Select login method" apareceu no stdout). Guarda contra
  // reenviar o Enter a cada chunk subsequente de stdout.
  menuSelected: boolean
  // Antigravity: estado + lógica de scanning das telas de onboarding
  // (color-scheme/ToS/trust-folder + fallback genérico), extraída (21/07)
  // pra `antigravity-screens.ts` — FONTE ÚNICA DE VERDADE reusada por
  // `antigravity-quota-reader.ts`. Uma instância por sessão (o estado de
  // scan não é global).
  onboardingScanner: AntigravityOnboardingScanner
  // Guarda contra reenvio cego do código em `submitCode` (BUG 2): uma vez que
  // o código já foi escrito no stdin desta sessão, chamadas subsequentes
  // (dono reenviando achando que não foi) são no-op — não há widget de código
  // para reenviar para, e escrever de novo só atrapalha qualquer tela seguinte
  // (ex.: a de consentimento do Antigravity, que virava toggle de checkbox).
  codeSubmitted: boolean
  // O HOME desta sessão é o diretório PERSISTENTE do ambiente do user (0700),
  // não um temp efêmero. Quando true, cleanup() NÃO apaga o hostHome: a
  // credencial que o login gravou VIVE ali dentro do ambiente, protegida, e é
  // a faxina 24h (garbage collector) quem a destrói se o wizard for
  // abandonado. False = fallback mkdtemp, limpo no cleanup como sempre.
  persistentHome: boolean
}

// Observabilidade do operador: uma linha por FALHA de login, com o rabo
// redigido do stdout. É o mínimo para diagnosticar um login que não fechou (que
// prompt travou, que erro o CLI cuspiu) sem depender de reproduzir na mão.
export interface AssistedLoginLogger {
  loginFailed(entry: { runtime: DeviceRuntime; phase: LoginState['phase']; tail: string }): void
}

const defaultLogger: AssistedLoginLogger = {
  loginFailed: (entry) => {
    console.warn('[assisted-login] login falhou', entry)
  },
}

export interface AssistedLoginOptions {
  image: string
  timeoutMs?: number
  runDeviceLoginImpl?: typeof runDeviceLogin
  // Injetável para teste e para trocar o console pelo app.log do Fastify em
  // produção. Só é chamado em falha — nunca em sucesso.
  logger?: AssistedLoginLogger
}

/**
 * Orquestra o login assistido de um motor (Codex/Claude/Antigravity) num
 * container isolado por sessão. Estado em memória — é efêmero por natureza
 * (login dura no máximo alguns minutos); perder numa reinicialização do
 * processo é aceitável (o usuário clica "conectar" de novo).
 */
export class AssistedLoginService {
  private readonly sessions = new Map<string, Session>()
  private readonly logger: AssistedLoginLogger

  constructor(
    private readonly engineConnections: Pick<EngineConnectionService, 'captureFromHome'>,
    private readonly options: AssistedLoginOptions
  ) {
    this.logger = options.logger ?? defaultLogger
  }

  /**
   * Inicia o login assistido do motor. Quando `envHome` é passado (o diretório
   * do ambiente isolado do user, 0700), o container usa ELE como HOME: a
   * credencial que o CLI grava no login (`.codex/`, `.claude/`,
   * `.gitorch/env/…`) fica DENTRO do ambiente do cliente — o motor "loga
   * dentro", protegido em disco, ao lado dos clones do passo 4. Sem `envHome`
   * (fallback), cai no HOME temporário efêmero de sempre (mkdtemp), apagado no
   * cleanup. Em ambos os casos a credencial também é cifrada pro cofre
   * (captureFromHome); o `envHome` é sobre ONDE ela vive em disco durante o
   * wizard, não sobre o cofre.
   */
  start(userId: string, runtime: DeviceRuntime, envHome?: string): string {
    const id = randomUUID()
    const run = this.options.runDeviceLoginImpl ?? runDeviceLogin
    const handle = run({
      image: this.options.image,
      binary: BINARY[runtime],
      args: ARGS[runtime],
      usePty: NEEDS_PTY[runtime],
      // makeHomeImpl faz o runDeviceLogin montar ESTE dir como HOME do
      // container em vez de criar um mkdtemp. exactOptionalPropertyTypes: só
      // inclui a chave quando há envHome (nunca passa `undefined` explícito).
      ...(envHome !== undefined ? { makeHomeImpl: () => envHome } : {}),
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
      menuSelected: false,
      onboardingScanner: new AntigravityOnboardingScanner(),
      codeSubmitted: false,
      persistentHome: envHome !== undefined,
    }
    this.sessions.set(id, session)

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
    // BUG 2 (Antigravity, diagnóstico 20/07): trava reenvios cegos. Uma vez
    // que o código já foi submetido nesta sessão, ignora silenciosamente
    // qualquer chamada seguinte — o dono reenviando (achando que não foi)
    // escrevia cegamente no stdin, e depois do widget de código sumir isso
    // vira toque de navegação/toggle na tela seguinte (a de Terms of
    // Service/consentimento do Antigravity, ver ANTIGRAVITY_ONBOARDING_SCREENS).
    if (session.codeSubmitted) return
    session.codeSubmitted = true
    // Num PTY, o Enter é '\r' (carriage return): '\n' entrega o texto mas o
    // TUI nunca "submete" — o código ficava parado no prompt e o login pendia
    // pra sempre (observado ao vivo no QA manual de 2026-07-12, Claude).
    // Codex roda por pipes (sem PTY), onde '\n' é o correto.
    const enter = NEEDS_PTY[session.runtime] ? '\r' : '\n'
    // BUG 1 (Claude, diagnóstico 20/07): código e Enter vão em DOIS writeStdin
    // separados, nunca no mesmo burst. Causa raiz reproduzida byte a byte
    // contra o binário real: o campo mascarado do `claude setup-token` não
    // reconhece o Enter quando ele chega GRUDADO ao código no mesmo burst,
    // para códigos longos (~90 chars, tamanho real do token OAuth do Claude)
    // — código curto passa, código longo trava idêntico ao log do dono.
    // Determinístico pelo tamanho do burst, independe da versão do CLI.
    //
    // BUG 3 (Claude, achado 21/07 nos logs reais do dono: CLI respondeu "OAuth
    // error: Invalid code. Please make sure the full code was copied"): um
    // código OAuth nunca contém espaço — mas `.trim()` só limpa as PONTAS. A
    // página de autorização exibe o código quebrado em mais de uma linha
    // visualmente; selecionar/copiar essa exibição pode trazer um '\n' ou
    // espaço EMBUTIDO no meio da string (não nas pontas). Um '\r'/'\n' embutido
    // vira um Enter prematuro dentro do campo mascarado — submete só o PEDAÇO
    // colado até ali, exatamente o sintoma relatado. Remove TODO espaço em
    // branco (não só das pontas): a única forma seguro de garantir que o burst
    // escrito é o código inteiro, sem quebra no meio.
    const sanitizedCode = code.replace(/\s+/g, '')
    session.handle.writeStdin(sanitizedCode)
    setTimeout(() => {
      session.handle.writeStdin(enter)
    }, SUBMIT_CODE_ENTER_DELAY_MS)
  }

  private onStdout(id: string, chunk: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.buffer += chunk
    if (session.state.phase === 'connected' || session.state.phase === 'error') return

    // Antigravity: assim que o menu do TUI é desenhado ("Select login method"),
    // confirma "Google OAuth" (opção default) com CR — só então o `agy` emite a
    // URL do Google OAuth. Uma vez só (menuSelected), senão cada chunk seguinte
    // reenviaria o Enter e bagunçaria o prompt de colar o código.
    const menuMarker = MENU_SELECT_MARKER[session.runtime]
    if (menuMarker && !session.menuSelected && menuMarker.test(session.buffer)) {
      session.menuSelected = true
      session.handle.writeStdin('\r')
    }

    // Antigravity pós-OAuth: sequência REAL de telas provada AO VIVO (21/07,
    // ver o comentário grande em ANTIGRAVITY_ONBOARDING_SCREENS acima e
    // docs/operations/engine-collection-real-steps.md). Sem gate em
    // "consentimento confirmado": cada tela conhecida (color-scheme, ToS,
    // trust-folder) é reconhecida pelo próprio texto, independente de ordem.
    if (session.runtime === 'antigravity') {
      const failed = this.processAntigravityOnboarding(id, session)
      if (failed) return

      // Chat pronto = login+onboarding terminaram e a credencial já está em
      // disco. O `agy` não vai sair sozinho (fica no chat), então capturamos
      // aqui em vez de esperar um onExit que nunca vem. Uma vez só (capturing).
      if (!session.capturing && ANTIGRAVITY_CHAT_READY_MARKER.test(session.buffer)) {
        session.capturing = true
        void this.captureAntigravityAfterChat(id)
        return
      }
    }

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
      // extractClaudeToken limpa os escapes ANSI/CSI (incl. as formas privadas
      // do PTY: ESC[>4m, ESC[<u, …) ANTES de casar. O match cru truncava no
      // primeiro '[' de um escape adjacente ao token (achado da captura A2).
      const token = extractClaudeToken(session.buffer)
      if (token) {
        session.capturing = true
        void this.captureClaudeToken(id, token)
      }
    }
  }

  /**
   * Antigravity pós-OAuth: delega pro scanner compartilhado
   * (`AntigravityOnboardingScanner`, antigravity-screens.ts — mesmo usado
   * por `antigravity-quota-reader.ts`) reconhecer e confirmar cada tela da
   * sequência REAL (color-scheme → ToS → trust-folder) pelo próprio TEXTO,
   * independente de ordem rígida, com fallback genérico (colchetes +
   * fingerprint + teto anti-loop) para telas desconhecidas.
   *
   * Retorna `true` se a sessão falhou (teto anti-loop estourado) — o
   * chamador (`onStdout`) deve parar de processar este chunk nesse caso
   * (mesma disciplina do `return` que o teto já tinha inline antes).
   */
  private processAntigravityOnboarding(id: string, session: Session): boolean {
    const result = session.onboardingScanner.scan(session.buffer, session.handle)
    if (result.loopExceeded) {
      this.fail(
        id,
        `onboarding do Antigravity não avançou após ${MAX_ONBOARDING_AUTO_CONFIRMS} confirmações automáticas; possível loop — tente novamente`
      )
      return true
    }
    return false
  }

  private async captureClaudeToken(id: string, token: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.state.phase === 'connected' || session.state.phase === 'error') return
    try {
      const envDir = path.join(session.handle.hostHome, '.gitorch', 'env')
      await fs.mkdir(envDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(envDir, 'CLAUDE_CODE_OAUTH_TOKEN'), token, { mode: 0o600 })
      const st = await this.engineConnections.captureFromHome(
        session.userId,
        'claude',
        session.handle.hostHome,
        {
          credentialKind: 'env',
          envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
          expiresAt: new Date(Date.now() + CLAUDE_TOKEN_TTL_MS),
        }
      )
      // Anti-fachada: a credencial foi arquivada, mas só é 'connected' se a
      // validação viva (dentro de captureFromHome) passou. status:'error' aqui
      // significa que o motor não respondeu ao comando de liveness — mentir
      // 'connected' faria a missão falhar opaca lá na frente.
      if (st.status !== 'connected') {
        this.fail(id, st.lastError ?? 'motor não respondeu à validação viva')
        return
      }
      this.setState(id, connectedStateFrom(st))
    } catch (err) {
      this.fail(id, (err as Error).message)
    } finally {
      session.handle.kill()
    }
  }

  /**
   * Antigravity: o login+onboarding terminaram e o `agy` está no chat (vivo).
   * A credencial já está em disco; capturamos aqui em vez de esperar um onExit
   * que nunca vem (ver ANTIGRAVITY_CHAT_READY_MARKER). Mata o chat ANTES de
   * capturar: a liveness (`agy models`) e a quota (`/usage` sob PTY) rodam
   * `agy` em processos novos no MESMO homeDir — deixar o chat vivo segurando os
   * locks (sqlite do agy) arriscaria conflito. Matar não perde a credencial
   * (ela já foi gravada). O onExit que este kill dispara vê `capturing` já true
   * e não interfere.
   */
  private async captureAntigravityAfterChat(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.state.phase === 'connected' || session.state.phase === 'error') return
    session.handle.kill()
    try {
      const st = await this.engineConnections.captureFromHome(
        session.userId,
        'antigravity',
        session.handle.hostHome
      )
      if (st.status !== 'connected') {
        this.fail(id, st.lastError ?? 'motor não respondeu à validação viva')
        return
      }
      this.setState(id, connectedStateFrom(st))
    } catch (err) {
      this.fail(id, (err as Error).message)
    }
  }

  private async onExit(id: string, code: number | null): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.state.phase === 'connected' || session.state.phase === 'error') return

    // Captura JÁ em andamento por outro caminho — NÃO falhar aqui: o exit é
    // consequência do nosso próprio kill(), não um erro. Cobre dois casos:
    //  - Claude: capturado via stdout (captureClaudeToken), o processo sai logo
    //    depois de imprimir o token enquanto a captura assíncrona ainda corre.
    //  - Antigravity: capturado ao detectar o chat pronto
    //    (captureAntigravityAfterChat), que mata o processo de propósito.
    // Chamar fail() aqui apagaria a sessão (cleanup) e o setState('connected')
    // posterior da captura viraria no-op silencioso — o usuário veria "error"
    // mesmo com a credencial capturada. A captura em curso é dona do estado.
    if (session.capturing) return

    // Claude captura via stdout, nunca via exit. Se chegou aqui SEM capturing,
    // o CLI saiu sem imprimir o token = falha legítima.
    if (session.runtime === 'claude') {
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
      const st = await this.engineConnections.captureFromHome(
        session.userId,
        session.runtime,
        session.handle.hostHome
      )
      // Anti-fachada (mesma regra do Claude): a saída 0 do CLI só prova que o
      // login LOCAL terminou; 'connected' exige a validação viva verde que
      // captureFromHome roda. status:'error' ⇒ falha honesta, nunca 'connected'.
      if (st.status !== 'connected') {
        this.fail(id, st.lastError ?? 'motor não respondeu à validação viva')
        return
      }
      this.setState(id, connectedStateFrom(st))
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
    // fail() é o ÚNICO caminho para o estado 'error' (timeouts, onExit,
    // captureClaudeToken, guards de liveness reprovada) — logar aqui cobre toda
    // transição de falha num só lugar, e nunca no sucesso (setState 'connected'
    // não passa por aqui). O tail vai SEMPRE redigido (nunca token cru); a fase
    // capturada é a de ANTES do erro (o estado ainda não virou 'error').
    const session = this.sessions.get(id)
    if (session) {
      this.logger.loginFailed({
        runtime: session.runtime,
        phase: session.state.phase,
        tail: redactSecrets(session.buffer.slice(-2000)),
      })
    }
    this.setState(id, { phase: 'error', message })
  }

  private cleanup(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    clearTimeout(session.timeoutHandle)
    clearTimeout(session.absoluteTimeoutHandle)
    session.handle.kill()
    // HOME persistente (dir do ambiente do user): NÃO apagar. A credencial que
    // o login gravou VIVE ali dentro do ambiente isolado (0700), protegida, e
    // quem a destrói é a faxina 24h se o wizard for abandonado — apagar aqui
    // esvaziaria o ambiente (inclusive os clones do passo 4) a cada login.
    // HOME efêmero (fallback mkdtemp): apagar. Best-effort, fire-and-forget —
    // esse dir pode conter credencial em texto puro (.codex/auth.json,
    // .gemini/antigravity-cli/antigravity-oauth-token, ou o
    // CLAUDE_CODE_OAUTH_TOKEN escrito por captureClaudeToken) que já foi
    // cifrada pro cofre e não pode ficar largada no host. cleanup() é chamado
    // de forma síncrona a partir de setState() e precisa continuar síncrono —
    // não podemos `await` aqui; `.catch` evita unhandled rejection.
    if (!session.persistentHome) {
      void fs.rm(session.handle.hostHome, { recursive: true, force: true }).catch(() => undefined)
    }
    this.sessions.delete(id)
  }
}
