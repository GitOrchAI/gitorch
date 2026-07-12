// Extrai a URL de autorização (e o código de uso único, quando o CLI expõe um)
// do stdout acumulado do login de cada motor. Markers vindos da observação real
// dos CLIs (spike 2026-07-07). Só ler — nunca logar o buffer (pode conter token).

export type DeviceRuntime = 'codex' | 'claude' | 'antigravity'

export interface DevicePrompt {
  url?: string
  code?: string
}

// Sequências ANSI/CSI que os CLIs interativos intercalam no stdout (spinners,
// cursor). Removidas antes do match para a URL não vir picotada por escapes.
const ANSI = /\[[0-9;?]*[A-Za-z]/g

// Cauda de URL que NÃO atravessa fronteiras: para em espaço, em `]` (o
// terminador visível `]8;;` de hyperlink OSC-8) e ANTES de um segundo
// `https://`. Necessário porque o agy imprime a URL como hyperlink OSC-8: o
// alvo do link e o texto visível são a MESMA URL, coladas SEM espaço no buffer
// limpo — um `\S+` guloso engolia as duas (`...state=XyzHTTPS://accounts...`)
// e o Google respondia 404 (observado ao vivo no QA manual de 2026-07-12). O
// primeiro match é o alvo OSC-8, que chega inteiro e sem quebra de linha.
const URL_TAIL = '(?:(?!https://)[^\\s\\]\\u001b])'

function matchUrl(clean: string, prefix: string, tail: '+' | '*'): string | undefined {
  return clean.match(new RegExp(prefix + URL_TAIL + tail))?.[0]
}

export function parseDevicePrompt(buffered: string, runtime: DeviceRuntime): DevicePrompt {
  const clean = buffered.replace(ANSI, '')
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

export function isDeviceRuntime(x: string): x is DeviceRuntime {
  return x === 'codex' || x === 'claude' || x === 'antigravity'
}
