import {
  stripAnsi,
  runAgyChatCommand,
  type AgyChatHandle,
  type RunAgyChatCommandOptions,
} from '@gitorch/agents'
import { AntigravityOnboardingScanner } from './antigravity-screens.js'
import { envReading, type QuotaReader, type QuotaReading } from './quota-env.js'

// A QUOTA REAL do Antigravity — provada ao vivo 21/07 (ver
// docs/operations/engine-collection-real-steps.md, seção Antigravity):
//
//   `agy usage` (o que o produto tentava até agora, via execFile sem TTY)
//   FALHA com "CLI error: bubbletea: could not open TTY" — e MESMO sob um
//   TTY de verdade, `agy usage` NÃO É o comando de quota: ele abre o chat
//   normal (idêntico a rodar `agy` sem argumento nenhum). A quota do
//   Antigravity NUNCA funcionou por este caminho — sempre voltou null.
//
//   O jeito CERTO é o slash `/usage` DENTRO do chat TUI do `agy`, que só
//   funciona sob um PTY real (o mesmo motivo do login assistido: sem PTY, o
//   `agy` nem desenha nada). Ao abrir o chat e mandar `/usage` + Enter,
//   aparece uma tela com barras de progresso POR GRUPO de modelo (ex.:
//   "GEMINI MODELS", "CLAUDE AND GPT MODELS" — o texto do cabeçalho de
//   grupo pode variar entre versões do agy, por isso o parser abaixo NUNCA
//   depende dele, só da sequência "Weekly Limit"/"Five Hour Limit ... NN%").
//
// SEMÂNTICA DA BARRA — o ponto mais fácil de errar, CONFIRMADO ao vivo:
//   Weekly Limit    [████████████████░░] 82.29%
//     82% remaining · Refreshes in 34h 59m
//   A barra mostra 82.29% E a legenda logo abaixo diz "82% remaining". Se
//   fosse % USADO, a legenda diria "82% used"/"used" — ela diz REMAINING.
//   Logo: a barra é a % QUE AINDA RESTA (não a que já foi usada). O grupo
//   Claude/GPT confirma isso no outro extremo: barra 100.00% + legenda
//   "Quota available" (nada usado, tudo disponível) — 100% só faz sentido
//   como "100% restante", nunca como "100% usado" (isso seria quota
//   ESGOTADA, o oposto do que a legenda diz).
//   `QuotaReading.weekPercentUsed`/`sessionPercentUsed` são % USADO (mesmo
//   contrato do Claude/Codex) — por isso este módulo converte SEMPRE
//   `percentUsed = 100 - <percentual da barra>`. A legenda "X% remaining"
//   (versão arredondada em inteiro da mesma barra) NUNCA é usada pro
//   percentual em si — só pra confirmar a semântica em comentário/teste; o
//   valor usado é sempre a barra (mais preciso, com 2 casas decimais). A
//   legenda SIM é usada pro "Refreshes in Hh Mm" (a barra não tem essa
//   informação).
//
// GRUPOS — o Antigravity tem MÚLTIPLOS grupos de modelo com quotas
// independentes (Gemini, Claude/GPT). Este reader usa o PIOR CASO entre os
// grupos, POR JANELA (semana e sessão de forma independente — a pior semana
// pode vir de um grupo diferente da pior sessão): é o que vai bloquear o
// cliente primeiro, mais honesto pra um cockpit de quota do que só mostrar o
// grupo "default" (Gemini) e esconder que outro grupo já está mais gasto.
//
// ARQUITETURA — reusa a MESMA infra de PTY do login assistido
// (`runAgyChatCommand`, packages/agents/agy-chat-runner.ts — que por sua vez
// reusa `wirePtyHandle` de device-login-runner.ts, nunca reinventa node-pty)
// e o MESMO scanner de telas de onboarding do login
// (`AntigravityOnboardingScanner`, antigravity-screens.ts): um HOME recém-
// materializado (só a credencial `antigravity-oauth-token`, sem estado de
// onboarding) PODE reexibir color-scheme→ToS→trust-folder ANTES do chat,
// mesmo essa leitura não sendo um login de verdade (a credencial já existe
// — é o `agy`, na primeira vez que roda com aquele HOME, que insiste nessas
// telas).
//
// Fluxo: sobe `agy` (chat) sob PTY → trata onboarding se aparecer → espera o
// prompt do chat pronto ("? for shortcuts", o rodapé do TUI — NUNCA um "> "
// solto: telas de onboarding como "> Yes, I trust this folder" também
// começam com ">", então um marker só de ">" dispararia cedo demais) →
// manda `/usage` + Enter (confirmado ao vivo: 1 Enter só, que seleciona o
// autocomplete E executa) → captura a tela, parseia, resolve → sai limpo
// (Esc fecha a tela do /usage, depois kill). Timeout duro (default 45s):
// nunca trava, nunca lança — best-effort, tudo null se nada resolver a
// tempo (mesmo contrato honesto do resto de quota-reader.ts).

const DEFAULT_TIMEOUT_MS = 45_000
// Mesmo raciocínio dos outros delays de tecla do produto (ONBOARDING_NAV_KEY_
// DELAY_MS, SUBMIT_CODE_ENTER_DELAY_MS): sob PTY em modo raw o TUI processa
// uma tecla de cada vez — mandar `/usage` colado ao Enter no mesmo burst
// arrisca perder o autocomplete.
const USAGE_COMMAND_ENTER_DELAY_MS = 75
// Uma tela de TUI (bubbletea) redesenha o viewport inteiro numa única
// escrita do processo — mas essa escrita ainda pode chegar fatiada em mais
// de um chunk de stdout (limite de buffer do pipe/pty, ou só o jeito como o
// kernel entrega). Assim que a PRIMEIRA janela é reconhecida no buffer
// acumulado, espera este "silêncio" de stdout antes de parsear/resolver —
// protege o pior-caso-entre-grupos de fechar cedo demais com só o PRIMEIRO
// grupo, perdendo um grupo mais gasto que ainda não tinha terminado de
// desenhar. Reiniciado a cada novo chunk (a tela pode continuar chegando).
const DEFAULT_QUIET_MS = 250

// Mesmos 6 campos null que EMPTY_CLAUDE_QUOTA/EMPTY_CODEX_QUOTA (quota-
// reader.ts) — nunca undefined — pro front tratar os 3 motores da mesma
// forma quando a coleta falha ou nunca rodou.
const EMPTY_ANTIGRAVITY_QUOTA: QuotaReading = {
  remaining: null,
  total: null,
  sessionPercentUsed: null,
  sessionResetsAt: null,
  weekPercentUsed: null,
  weekResetsAt: null,
}

// Rodapé do TUI do chat principal ("? for shortcuts") — NUNCA um `>` solto:
// várias telas de ONBOARDING também começam com `>` (ex. "> Yes, I trust
// this folder", "> 1. Google OAuth" no menu de login), então um marker de
// `>` sozinho confundiria onboarding com o chat pronto.
const CHAT_PROMPT_MARKER = /\? for shortcuts/i

type AntigravityUsageWindowKind = 'weekly' | 'five_hour'

export interface AntigravityUsageWindowMatch {
  kind: AntigravityUsageWindowKind
  /** % da BARRA — que é % RESTANTE, não usado (ver comentário grande acima). */
  percentRemaining: number
  /** 100 - percentRemaining, arredondado a 2 casas — o que `QuotaReading`
   * espera (sessionPercentUsed/weekPercentUsed são % USADO). */
  percentUsed: number
  /** ISO string (now + "Refreshes in Hh Mm"), ou `null` quando a legenda é
   * "Quota available" (nada a esperar — a quota já está cheia). */
  resetsAt: string | null
}

// CORREÇÃO 21/07 (tela REAL capturada ao vivo do dono, ver
// docs/operations/engine-collection-real-steps.md): o rótulo e a barra/percentual
// ficam em LINHAS SEPARADAS, não na mesma linha. O formato real é:
//     "  Weekly Limit"                              <- só o rótulo
//     "    [████████████░░] 80.82%"                 <- a barra + percentual
//     "    81% remaining · Refreshes in 21h 25m"    <- o caption do reset
// O regex antigo (`Weekly Limit [barra] NN%` tudo numa linha) NUNCA casava a
// tela real → `janelasVistas: 0` → quota nula (achado no diagnóstico do reteste
// do dono, apesar da tela ter aparecido de verdade). Agora são dois regexes:
// o rótulo sozinho e a barra+percentual na linha seguinte.
const WINDOW_LABEL_RE = /^\s*(Weekly Limit|Five Hour Limit)\s*$/i

// "    [████████████████░░] 80.82%" — a barra + o percentual, numa linha só
// (a linha logo abaixo do rótulo). NUNCA depende do conteúdo entre colchetes
// (os blocos ASCII variam por terminal/versão), só do percentual após o `]`.
const WINDOW_BAR_RE = /\[[^\]]*\]\s*([0-9]+(?:\.[0-9]+)?)\s*%/

// "    82% remaining · Refreshes in 34h 59m" — só usada pro tempo de reset
// (o percentual em si vem da barra, ver comentário grande no topo do
// arquivo). "h"/"m" são independentes: aceita "34h 59m", só "34h" ou só
// "59m".
const REMAINING_CAPTION_RE =
  /^\s*[0-9]+(?:\.[0-9]+)?\s*%\s*remaining\b.*?Refreshes in\s*(?:([0-9]+)\s*h)?\s*(?:([0-9]+)\s*m)?/i

// "    Quota available" — grupo com a janela cheia (barra 100%), sem
// informação de refresh (não há o que esperar).
const QUOTA_AVAILABLE_RE = /^\s*Quota available\s*$/i

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Extrai TODAS as janelas (Weekly Limit / Five Hour Limit, de QUALQUER
 * grupo de modelo) da tela do `/usage` já limpa de ANSI. Puro e testável —
 * nunca lança, ignora silenciosamente linhas que não casam o formato
 * esperado. Não depende do texto do cabeçalho de grupo (que pode variar
 * entre versões do agy) — só empareia cada linha "Weekly Limit"/"Five Hour
 * Limit ... NN.NN%" com a legenda na linha seguinte.
 */
export function parseAntigravityUsageWindows(
  clean: string,
  now: () => number = Date.now
): AntigravityUsageWindowMatch[] {
  const lines = clean.split('\n')
  const windows: AntigravityUsageWindowMatch[] = []

  for (let i = 0; i < lines.length; i++) {
    const labelMatch = WINDOW_LABEL_RE.exec(lines[i] ?? '')
    if (!labelMatch) continue
    const label = labelMatch[1]
    if (!label) continue

    // A barra + o percentual estão na PRÓXIMA linha (ver WINDOW_BAR_RE). Sem
    // ela, a janela não tem número — ignora (não é uma janela válida).
    const barMatch = WINDOW_BAR_RE.exec(lines[i + 1] ?? '')
    const percentRemainingRaw = barMatch?.[1]
    if (!percentRemainingRaw) continue
    const percentRemaining = Number(percentRemainingRaw)
    if (!Number.isFinite(percentRemaining)) continue

    const kind: AntigravityUsageWindowKind =
      label.toLowerCase() === 'weekly limit' ? 'weekly' : 'five_hour'

    // O caption (reset OU "Quota available") vem na linha SEGUINTE à barra.
    const caption = (lines[i + 2] ?? '').trim()
    let resetsAt: string | null = null
    if (!QUOTA_AVAILABLE_RE.test(caption)) {
      const capMatch = REMAINING_CAPTION_RE.exec(caption)
      if (capMatch) {
        const hours = capMatch[1] ? Number(capMatch[1]) : 0
        const minutes = capMatch[2] ? Number(capMatch[2]) : 0
        resetsAt = new Date(now() + (hours * 3600 + minutes * 60) * 1000).toISOString()
      }
    }

    windows.push({
      kind,
      percentRemaining,
      percentUsed: round2(100 - percentRemaining),
      resetsAt,
    })
  }

  return windows
}

/** Pior caso (maior percentUsed) entre as janelas de um kind — ou `null` se
 * nenhuma janela desse kind foi encontrada. */
function pickWorstCase(
  windows: readonly AntigravityUsageWindowMatch[],
  kind: AntigravityUsageWindowKind
): AntigravityUsageWindowMatch | null {
  let worst: AntigravityUsageWindowMatch | null = null
  for (const w of windows) {
    if (w.kind !== kind) continue
    if (!worst || w.percentUsed > worst.percentUsed) worst = w
  }
  return worst
}

/**
 * Converte a tela inteira do `/usage` (já limpa de ANSI) num `QuotaReading`,
 * usando o PIOR CASO entre os grupos de modelo, por janela (ver o
 * comentário grande no topo do arquivo). `EMPTY_ANTIGRAVITY_QUOTA` se
 * nenhuma janela foi reconhecida (formato inesperado — nunca lança).
 */
export function antigravityUsageScreenToQuotaReading(
  clean: string,
  now: () => number = Date.now
): QuotaReading {
  const windows = parseAntigravityUsageWindows(clean, now)
  const week = pickWorstCase(windows, 'weekly')
  const fiveHour = pickWorstCase(windows, 'five_hour')
  if (!week && !fiveHour) return EMPTY_ANTIGRAVITY_QUOTA
  return {
    remaining: null,
    total: null,
    weekPercentUsed: week ? week.percentUsed : null,
    weekResetsAt: week ? week.resetsAt : null,
    sessionPercentUsed: fiveHour ? fiveHour.percentUsed : null,
    sessionResetsAt: fiveHour ? fiveHour.resetsAt : null,
  }
}

export interface AntigravityQuotaReaderPtyOptions {
  agyBin?: string
  timeoutMs?: number
  /** Silêncio de stdout esperado antes de finalizar depois da 1a janela
   * reconhecida (ver DEFAULT_QUIET_MS acima). Baixado nos testes pra não
   * esperar de verdade. */
  quietMs?: number
  /** Injetável para teste — NUNCA sobe o `agy` real numa suite de testes. */
  runAgyChatCommandImpl?: (options: RunAgyChatCommandOptions) => AgyChatHandle
  /** Injetável para teste — congela o "agora" usado pra calcular `resetsAt`. */
  now?: () => number
}

/**
 * Antigravity: quota real via `/usage` no chat TUI sob PTY (ver o comentário
 * grande no topo do arquivo). Best-effort — nunca lança, nunca trava (timeout
 * duro): qualquer falha (onboarding em loop, `agy` não abre, tela do
 * `/usage` nunca aparece, timeout) resolve `EMPTY_ANTIGRAVITY_QUOTA`.
 */
export function makeAntigravityQuotaReaderPty(
  options: AntigravityQuotaReaderPtyOptions = {}
): QuotaReader {
  const run = options.runAgyChatCommandImpl ?? runAgyChatCommand
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS
  const now = options.now ?? Date.now
  const agyBin = options.agyBin ?? process.env['GITORCH_AGY_BIN'] ?? 'agy'

  return (homeDir: string) =>
    new Promise<QuotaReading>((resolve) => {
      const env = envReading('antigravity')
      if (env) {
        resolve(env)
        return
      }

      let handle: AgyChatHandle
      try {
        handle = run({ homeDir, agyBin })
      } catch (err) {
        console.warn('[antigravity-quota-reader] subir o agy sob PTY falhou — quota nula', {
          error: err instanceof Error ? err.message : String(err),
        })
        resolve(EMPTY_ANTIGRAVITY_QUOTA)
        return
      }

      let settled = false
      let buffer = ''
      let usageSent = false
      let quietTimer: ReturnType<typeof setTimeout> | undefined
      const scanner = new AntigravityOnboardingScanner()

      function settle(reading: QuotaReading): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (quietTimer) clearTimeout(quietTimer)
        // Resolve PRIMEIRO — a leitura não pode depender de cleanup ter
        // sucesso. Esc fecha a tela do /usage (se ainda aberta), depois
        // mata o processo — tudo best-effort (nunca esperamos confirmação;
        // node-pty garante write/kill seguros mesmo pós-saída, ver
        // device-login-runner.ts).
        resolve(reading)
        try {
          handle.writeStdin('\x1b')
          handle.kill()
        } catch {
          // best-effort — a leitura já foi resolvida de qualquer forma.
        }
      }

      // Diagnóstico dos caminhos SILENCIOSOS (achado 21/07: a quota do
      // Antigravity veio nula no reteste do dono sem NENHUM log — o timeout e o
      // exit resolviam EMPTY sem dizer onde pararam). Loga um resumo do estado:
      // chegou no chat? mandou /usage? o que a última tela mostrava? Tudo já
      // limpo de ANSI e truncado (a tela do /usage não tem segredo, mas o tail
      // curto evita despejar quilobytes no journal).
      const diag = (motivo: string): void => {
        const clean = stripAnsi(buffer)
        console.warn('[antigravity-quota-reader] quota nula', {
          motivo,
          chatDetectado: CHAT_PROMPT_MARKER.test(clean),
          usageEnviado: usageSent,
          janelasVistas: parseAntigravityUsageWindows(clean, now).length,
          tail: clean.slice(-300).replace(/\s+/g, ' ').trim(),
        })
      }

      const timer = setTimeout(() => {
        diag('timeout')
        settle(EMPTY_ANTIGRAVITY_QUOTA)
      }, timeoutMs)

      handle.onStdout((chunk) => {
        if (settled) return
        try {
          buffer += chunk
          const clean = stripAnsi(buffer)

          // 1) Onboarding: HOME recém-materializado pode reexibir
          // color-scheme → ToS → trust-folder ANTES do chat (mesma lógica
          // do login assistido — antigravity-screens.ts é a fonte única de
          // verdade).
          const onboarding = scanner.scan(buffer, handle)
          if (onboarding.loopExceeded) {
            settle(EMPTY_ANTIGRAVITY_QUOTA)
            return
          }

          // 2) A tela do /usage já apareceu? Não finaliza no PRIMEIRO
          // chunk que reconhece uma janela — a escrita pode ter vindo
          // fatiada e outro grupo (talvez mais gasto) ainda não terminou de
          // desenhar. Espera um pequeno silêncio de stdout (DEFAULT_QUIET_MS)
          // antes de parsear o buffer acumulado por completo — reinicia a
          // cada novo chunk, então a tela pode continuar chegando.
          const windows = parseAntigravityUsageWindows(clean, now)
          if (windows.length > 0) {
            if (quietTimer) clearTimeout(quietTimer)
            quietTimer = setTimeout(() => {
              try {
                settle(antigravityUsageScreenToQuotaReading(stripAnsi(buffer), now))
              } catch (err) {
                console.warn(
                  '[antigravity-quota-reader] erro parseando a tela do /usage — quota nula',
                  { error: err instanceof Error ? err.message : String(err) }
                )
                settle(EMPTY_ANTIGRAVITY_QUOTA)
              }
            }, quietMs)
            return
          }

          // 3) Chat pronto e ainda não mandamos o comando?
          if (!usageSent && CHAT_PROMPT_MARKER.test(clean)) {
            usageSent = true
            handle.writeStdin('/usage')
            setTimeout(() => {
              if (!settled) handle.writeStdin('\r')
            }, USAGE_COMMAND_ENTER_DELAY_MS)
          }
        } catch (err) {
          console.warn('[antigravity-quota-reader] erro processando stdout do agy — quota nula', {
            error: err instanceof Error ? err.message : String(err),
          })
          settle(EMPTY_ANTIGRAVITY_QUOTA)
        }
      })

      // Processo saiu (crash, kill externo, ou nunca chegou no chat) sem
      // nunca mostrar a tela do /usage — best-effort, nunca lança.
      handle.exited.then(() => {
        if (!settled) diag('processo saiu antes do /usage')
        settle(EMPTY_ANTIGRAVITY_QUOTA)
      })
    })
}

/** Instância real usada em produção (QUOTA_READERS.antigravity, quota-
 *  reader.ts) — sobe o `agy` de verdade via node-pty. */
export const readAntigravityQuota: QuotaReader = makeAntigravityQuotaReaderPty()
