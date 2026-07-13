// Extrai a URL de autorização (e o código de uso único, quando o CLI expõe um)
// do stdout acumulado do login de cada motor. Markers vindos da observação real
// dos CLIs (spike 2026-07-07). Só ler — nunca logar o buffer (pode conter token).

export type DeviceRuntime = 'codex' | 'claude' | 'antigravity'

export interface DevicePrompt {
  url?: string
  code?: string
}

// Limpeza de escapes de terminal (locus ÚNICO) do stdout dos CLIs sob PTY.
// A captura REAL (Task A2 — apps/control-plane/src/services/__fixtures__/
// claude-setup-token.stdout.txt) provou que a limpeza antiga
// (/\[[0-9;?]*[A-Za-z]/) era insuficiente por dois motivos:
//   1. NÃO consumia o byte ESC (0x1b) — deixava um ESC solto grudado no texto.
//   2. Só aceitava [0-9;?] nos parâmetros, então NÃO limpava as formas privadas
//      que o `claude` emite: ESC[>4m, ESC[>0q, ESC[<u (e a família ESC[=…u),
//      que sobravam como lixo visível (>4m, >0q, <u).
// Um escape adjacente à URL (ou no meio do token) picotava o match. Aqui cobrimos
// a gramática CSI COMPLETA (parâmetros 0x30–0x3f, incluindo `< = > ?`, +
// intermediários 0x20–0x2f + byte final 0x40–0x7e), OSC (ESC]…BEL/ST), escapes
// nF/de dois caracteres (ESC(B designação de charset, ESC7/ESC8 salvar/restaurar
// cursor) e qualquer ESC remanescente.
// eslint-disable-next-line no-control-regex -- ESC/BEL são o alvo desta limpeza
const OSC = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?/g
// Hyperlink OSC-8 (`ESC]8;params;URI` terminado por BEL/ST): DIFERENTE do OSC
// genérico acima — aqui a URI é o próprio conteúdo que precisamos (é onde o
// agy imprime a URL de autorização do Google como link clicável). Achado real
// ao iterar contra o binário (agy 1.0.16, fixture A2
// apps/control-plane/src/services/__fixtures__/agy-login.stdout.txt): o agy
// NÃO fecha a URI com BEL/ST antes de um reset de cor (`ESC[m`) que aparece
// no meio dela — a URI "esbarra" direto num CSI sem que o hyperlink tenha seu
// próprio terminador OSC. O OSC genérico trata essa URI inteira como "lixo de
// escape sem terminador" e a apaga por completo — bug real observado: a URL
// do Google OAuth sumia do estado (nunca virava 'url_ready'). Aqui capturamos
// e PRESERVAMOS a URI como texto visível; só a moldura (`ESC]8;id=...;` e o
// fechamento `ESC]8;;BEL`) é removida.
// eslint-disable-next-line no-control-regex -- ESC/BEL são o alvo desta limpeza
const OSC8_HYPERLINK = /\x1b\]8;[^;]*;([^\x07\x1b\n]*)(?:\x07|\x1b\\)?/g
// eslint-disable-next-line no-control-regex -- byte ESC é o alvo desta limpeza
const CSI = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g
// eslint-disable-next-line no-control-regex -- byte ESC é o alvo desta limpeza
const NF_ESC = /\x1b[\x20-\x2f]*[\x30-\x7e]/g
// eslint-disable-next-line no-control-regex -- byte ESC é o alvo desta limpeza
const LONE_ESC = /\x1b/g

// Ordem importa: hyperlink OSC-8 primeiro (preserva a URI antes de qualquer
// outra limpeza mexer nela), OSC genérico e CSI em seguida, antes do escape
// genérico (NF_ESC) — senão este comeria só o `ESC]`/`ESC[` e deixaria o corpo
// da sequência como lixo. LONE_ESC varre qualquer ESC que sobrou (ex.: no fim
// do buffer, sem byte final).
export function stripAnsi(s: string): string {
  return s
    .replace(OSC8_HYPERLINK, '$1')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(NF_ESC, '')
    .replace(LONE_ESC, '')
}

// Cauda de URL que NÃO atravessa fronteiras: para em espaço, em `]` (o
// terminador visível `]8;;` de hyperlink OSC-8) e ANTES de um segundo
// `https://`. Necessário porque o agy imprime a URL como hyperlink OSC-8: o
// alvo do link e o texto visível são a MESMA URL, coladas SEM espaço no buffer
// limpo — um `\S+` guloso engolia as duas (`...state=XyzHTTPS://accounts...`)
// e o Google respondia 404 (observado ao vivo no QA manual de 2026-07-12). O
// primeiro match é o alvo OSC-8, que chega inteiro e sem quebra de linha.
const URL_TAIL = '(?:(?!https://)[^\\s\\]\\u001b])'

function matchUrl(clean: string, prefix: string, tail: '+' | '*'): string | undefined {
  // `g`: terminal estreito (achado real, ver PTY_COLS em device-login-runner.ts)
  // faz o agy quebrar o hyperlink OSC-8 em mais de uma "linha" impressa — cada
  // pedaço casa o prefixo de novo. Preferir o ÚLTIMO match (não o mais longo:
  // um pedaço truncado no meio de um escape percentual pode ser TEXTUALMENTE
  // mais longo que a versão limpa e completa impressa depois) — o que o CLI
  // desenha por último é o que fica visível/válido na tela. Com PTY largo o
  // bastante (fix real: PTY_COLS folgado), só há UM match e isto vira no-op.
  const matches = clean.match(new RegExp(prefix + URL_TAIL + tail, 'g'))
  if (!matches || matches.length === 0) return undefined
  return matches[matches.length - 1]
}

export function parseDevicePrompt(buffered: string, runtime: DeviceRuntime): DevicePrompt {
  const clean = stripAnsi(buffered)
  switch (runtime) {
    case 'codex': {
      // `codex login --device-auth`: URL fixa + código XXXX-XXXX.
      const url = matchUrl(clean, 'https://auth\\.openai\\.com/codex/device', '*')
      const code = clean.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0]
      return { ...(url ? { url } : {}), ...(code ? { code } : {}) }
    }
    case 'claude': {
      // `claude setup-token` sob PTY: URL OAuth de authorization-code. O código
      // NÃO vem do CLI — o usuário pega na página de callback e cola de volta.
      const url = matchUrl(clean, 'https://claude\\.com/cai/oauth/authorize\\?', '+')
      return url ? { url } : {}
    }
    case 'antigravity': {
      // Re-testado 2026-07-07 sob PTY com HOME descartável (agy 1.0.16): o menu
      // "Select login method" emite esta URL do Google OAuth assim que o Enter
      // inicial seleciona "1. Google OAuth" (ver runDeviceLogin/Task 2 — o
      // Enter é responsabilidade de quem chama, não deste parser). MESMO
      // padrão bidirecional do Claude: sem código no stdout, o usuário cola de
      // volta o que a página antigravity.google/oauth-callback devolver.
      const url = matchUrl(clean, 'https://accounts\\.google\\.com/o/oauth2/auth\\?', '+')
      return url ? { url } : {}
    }
  }
}

// `claude setup-token` imprime o token final no stdout (não grava arquivo). O
// token real tem corpo longo (~100+ chars); um corpo curtíssimo é fragmento/lixo
// de escape sobrevivente, não credencial — daí o piso de shape. A fronteira à
// direita (?![A-Za-z0-9_-]) formaliza que o match é o token COMPLETO (o `+`
// guloso já estende até ela) — nunca um pedaço truncado por um caractere adiante.
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/
const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat01-'
// Piso conservador: barra fragmentos absurdos sem rejeitar os tokens curtos dos
// testes. A validade REAL do token é atestada pela liveness (captureFromHome),
// não aqui — este helper só garante extração íntegra, resistente a ANSI.
const MIN_CLAUDE_TOKEN_BODY = 8

/**
 * Extrai o token final do `claude setup-token` do stdout cru (com ANSI). Limpa
 * os escapes ANTES de casar — a captura A2 mostrou formas privadas (ESC[>4m,
 * ESC[<u, …) que, adjacentes ao token, cortavam o match cru no primeiro `[`.
 * Retorna o token COMPLETO ou `null` (nunca um fragmento parcial).
 */
export function extractClaudeToken(buffer: string): string | null {
  const token = stripAnsi(buffer).match(CLAUDE_TOKEN_RE)?.[0]
  if (!token) return null
  if (token.length - CLAUDE_TOKEN_PREFIX.length < MIN_CLAUDE_TOKEN_BODY) return null
  return token
}

export function isDeviceRuntime(x: string): x is DeviceRuntime {
  return x === 'codex' || x === 'claude' || x === 'antigravity'
}
