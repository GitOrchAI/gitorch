import { stripAnsi } from '@gitorch/agents'

// FONTE ÚNICA DE VERDADE do onboarding do Antigravity — extraída de
// assisted-login.ts (21/07) pra ser reusada por antigravity-quota-reader.ts,
// que enfrenta o MESMO onboarding: um HOME recém-materializado (só a
// credencial `antigravity-oauth-token`, sem estado de onboarding) pode
// reexibir as telas color-scheme→ToS→trust-folder ANTES do chat, mesmo numa
// leitura de quota que não é um login de verdade (a credencial já existe —
// é o PRÓPRIO `agy`, na primeira vez que roda com aquele HOME, que insiste em
// mostrar essas telas de novo).
//
// NÃO mudar o comportamento do login assistido ao mexer aqui — qualquer
// alteração de comportamento intencional deve vir acompanhada de atualização
// dos testes E3 em assisted-login.test.ts (a prova viva de que a sequência
// bate com o `agy` real, ver docs/operations/engine-collection-real-steps.md).

/** Só o que o scanner precisa pra confirmar uma tela — nunca a Session
 * inteira do login nem o AgyChatHandle inteiro da leitura de quota, só o
 * verbo em comum entre os dois. */
export interface AntigravityStdinWriter {
  writeStdin: (data: string) => void
}

// Teclas de navegação sob PTY em modo raw (ANSI padrão de terminal): Down é
// `ESC [ B`, Right é `ESC [ C`, Enter é `\r` (CR — TUI raw nunca aceita LF
// como submit).
export const KEY_DOWN = '\x1b[B'
export const KEY_RIGHT = '\x1b[C'
export const KEY_ENTER = '\r'

// Sob PTY em modo raw, o TUI processa uma tecla de cada vez — mandar
// Down/Right/Enter grudados no mesmo burst arrisca perder toques.
export const ONBOARDING_NAV_KEY_DELAY_MS = 75

export function confirmWithEnter(writer: AntigravityStdinWriter): void {
  writer.writeStdin(KEY_ENTER)
}

// Terms of Service & Data Use: o foco inicial é a checkbox "[x]" (já marcada
// por padrão) — mandar só Enter aqui TOGGLA a checkbox (desmarca!), nunca
// confirma a tela. Provado ao vivo (21/07): pra confirmar de verdade é
// preciso navegar até o botão "Done": Down (sai da checkbox, foca
// "Previous") → Right (foca "Done") → Enter (confirma). O rodapé do TUI
// mostra "enter Toggle" com foco na checkbox e "enter Confirm" num botão —
// confirmando que um único Enter ali NÃO tem o efeito de confirmar.
export function confirmTermsOfServiceByNavigatingToDone(writer: AntigravityStdinWriter): void {
  writer.writeStdin(KEY_DOWN)
  setTimeout(() => {
    writer.writeStdin(KEY_RIGHT)
    setTimeout(() => {
      writer.writeStdin(KEY_ENTER)
    }, ONBOARDING_NAV_KEY_DELAY_MS)
  }, ONBOARDING_NAV_KEY_DELAY_MS)
}

export interface AntigravityOnboardingScreen {
  /** Só para logs/comentários — não é exposto nem persistido. */
  id: string
  /** Texto identificador da tela (case-insensitive), testado contra o buffer
   * já limpo de ANSI. Mais robusto que detectar só pelo botão: a tela de
   * trust-folder nem TEM botão entre colchetes. */
  matcher: RegExp
  confirm: (writer: AntigravityStdinWriter) => void
}

// Sequência REAL pós-OAuth do Antigravity (agy 1.1.4/1.1.5), provada ao vivo
// contra a conta do dono num container isolado (21/07 — ver
// docs/operations/engine-collection-real-steps.md, seção Antigravity). A
// ORDEM real é color-scheme → ToS → trust-folder, mas a detecção não
// depende de posição: cada detector abaixo é checado a cada chunk novo de
// stdout e age quando SUA tela aparece (ver `AntigravityOnboardingScanner`),
// tolerando variações de ordem ou telas extras entre versões do agy.
export const ANTIGRAVITY_ONBOARDING_SCREENS: readonly AntigravityOnboardingScreen[] = [
  {
    id: 'color-scheme',
    matcher: /choose your color scheme/i,
    confirm: confirmWithEnter,
  },
  {
    id: 'terms-of-service',
    matcher: /terms of service|agree to help improve antigravity/i,
    confirm: confirmTermsOfServiceByNavigatingToDone,
  },
  {
    id: 'trust-folder',
    matcher: /do you trust|trust this folder/i,
    confirm: confirmWithEnter,
  },
]

// Fallback genérico (telas DESCONHECIDAS, fora das 3 reais mapeadas acima):
// botão de ação primária entre colchetes — mesmo padrão de sempre.
export const ANTIGRAVITY_ONBOARDING_BUTTON_MARKER =
  /\[(?:next|done|get started|continue|finish)\]/gi

// Teto de confirmações automáticas do fallback GENÉRICO por sessão. As 3
// telas conhecidas NÃO consomem este teto — são finitas por definição (uma
// flag por id, nunca reconfirmadas). Existe só pra telas NOVAS/desconhecidas:
// se a MESMA tela ficar sendo "confirmada" indefinidamente (bug real, não uma
// sequência legítima), a sessão tem que falhar honesto em vez de girar pra
// sempre.
export const MAX_ONBOARDING_AUTO_CONFIRMS = 8

export interface OnboardingScanResult {
  /** true quando o teto anti-loop do fallback genérico estourou — quem chama
   * deve tratar como falha honesta (nunca continuar girando). */
  loopExceeded: boolean
}

/**
 * Estado + lógica de scanning do onboarding do Antigravity. Reconhece e
 * confirma cada tela da sequência REAL (color-scheme → ToS → trust-folder)
 * pelo próprio TEXTO, independente de ordem rígida — e usa o fallback
 * genérico (colchetes + fingerprint + teto anti-loop) para telas
 * desconhecidas de versões futuras do agy.
 *
 * Consumida por DOIS lugares que enfrentam o MESMO onboarding a partir de um
 * HOME recém-materializado: `AssistedLoginService` (login de verdade) e
 * `antigravity-quota-reader.ts` (leitura de quota via `/usage`, que só chega
 * no chat DEPOIS que essas telas — se aparecerem — forem confirmadas). Uma
 * instância por sessão/leitura — nunca compartilhar entre chamadas
 * concorrentes (o estado de scan é por-instância, não global).
 */
export class AntigravityOnboardingScanner {
  private readonly screensConfirmed = new Set<string>()
  private confirmCount = 0
  // Posição (no texto já limpo de ANSI) até onde já examinamos o buffer em
  // busca de telas de onboarding (conhecidas OU desconhecidas). Avança para o
  // fim do buffer limpo a cada chamada processada (tenha confirmado ou não)
  // — nunca só até o fim do match — para que o texto de rodapé que vem
  // DEPOIS do botão não vaze pro fingerprint da PRÓXIMA tela desconhecida, e
  // para que uma tela CONHECIDA já processada nunca seja reinterpretada pelo
  // fallback genérico como tela nova.
  private scanPos = 0
  // Fingerprint (o texto limpo desde `scanPos` até o fim do último match
  // confirmado) da ÚLTIMA tela DESCONHECIDA confirmada pelo fallback
  // genérico. Um repaint idêntico da MESMA tela reproduz o MESMO
  // fingerprint — não reconfirma. Só usado pelo fallback: as 3 telas
  // conhecidas usam `screensConfirmed` (idempotência por id, não por
  // conteúdo).
  private lastFingerprint = ''

  /**
   * Examina `buffer` (RAW, com ANSI — a limpeza é feita aqui dentro) em busca
   * de telas de onboarding ainda não vistas, confirmando cada uma via
   * `writer.writeStdin`. Chamar a cada novo chunk de stdout acumulado (o
   * buffer INTEIRO acumulado até agora, não só o chunk novo — mesmo contrato
   * de antes).
   */
  scan(buffer: string, writer: AntigravityStdinWriter): OnboardingScanResult {
    const clean = stripAnsi(buffer)
    const newRegion = clean.slice(this.scanPos)
    if (newRegion.length === 0) return { loopExceeded: false }

    // 1) Telas CONHECIDAS (as 3 reais). Testadas contra a região NOVA (nunca
    // o buffer inteiro): uma tela antiga permanece no buffer acumulado para
    // sempre, e testar o buffer inteiro a cada chamada faria o scanner
    // "pular" por cima de conteúdo novo ainda não examinado sempre que
    // qualquer tela conhecida já tivesse aparecido alguma vez.
    const knownScreen = ANTIGRAVITY_ONBOARDING_SCREENS.find((screen) =>
      screen.matcher.test(newRegion)
    )
    if (knownScreen) {
      // Consome TODA a região nova — nunca deixa esse conteúdo cair no
      // fallback genérico abaixo (ex.: a própria tela de ToS TEM um
      // "[Done]", que também casaria o padrão genérico de botão).
      this.scanPos = clean.length
      if (!this.screensConfirmed.has(knownScreen.id)) {
        this.screensConfirmed.add(knownScreen.id)
        knownScreen.confirm(writer)
      }
      // Repaint (id já confirmado): não reconfirma, mas a região já foi
      // consumida acima — não fica reexaminando este trecho pra sempre.
      return { loopExceeded: false }
    }

    // 2) Fallback genérico: tela DESCONHECIDA (versão do agy com telas
    // extras) com um botão de ação primária entre colchetes.
    let lastMatch: RegExpMatchArray | undefined
    for (const match of newRegion.matchAll(ANTIGRAVITY_ONBOARDING_BUTTON_MARKER)) lastMatch = match
    if (!lastMatch) return { loopExceeded: false }

    const matchEnd = (lastMatch.index ?? 0) + lastMatch[0].length
    // Fingerprint = todo o conteúdo novo desde o início da região até o fim
    // DESTE botão — não só o texto do botão em si. Duas telas diferentes que
    // por acaso terminam no mesmo rótulo (ex.: dois "[Next]" seguidos) têm
    // fingerprints diferentes porque o conteúdo antes do botão difere.
    const fingerprint = newRegion.slice(0, matchEnd)
    // Avança para o fim do BUFFER LIMPO inteiro (não só até `matchEnd`):
    // qualquer rodapé que venha depois do botão neste mesmo chunk fica
    // marcado como já visto, para não vazar pro fingerprint da PRÓXIMA tela
    // caso a MESMA tela seja reimpressa por inteiro (repaint) num chunk
    // separado.
    this.scanPos = clean.length

    if (fingerprint === this.lastFingerprint) return { loopExceeded: false } // repaint idêntico

    if (this.confirmCount >= MAX_ONBOARDING_AUTO_CONFIRMS) {
      return { loopExceeded: true }
    }
    this.lastFingerprint = fingerprint
    this.confirmCount++
    writer.writeStdin(KEY_ENTER)
    return { loopExceeded: false }
  }
}
