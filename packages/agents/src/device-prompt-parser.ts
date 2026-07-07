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

export function parseDevicePrompt(buffered: string, runtime: DeviceRuntime): DevicePrompt {
  const clean = buffered.replace(ANSI, '')
  switch (runtime) {
    case 'codex': {
      // `codex login --device-auth`: URL fixa + código XXXX-XXXX.
      const url = clean.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/)?.[0]
      const code = clean.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0]
      return { ...(url ? { url } : {}), ...(code ? { code } : {}) }
    }
    case 'claude': {
      // `claude setup-token` sob PTY: URL OAuth de authorization-code. O código
      // NÃO vem do CLI — o usuário pega na página de callback e cola de volta.
      const url = clean.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/)?.[0]
      return url ? { url } : {}
    }
    case 'antigravity':
      // agy não expõe device-code/URL headless (spike): sem markers. Tratado
      // pelo paste-fallback até um mecanismo automatizável ser confirmado.
      return {}
  }
}
