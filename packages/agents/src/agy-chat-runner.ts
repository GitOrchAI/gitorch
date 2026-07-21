import { spawn as ptySpawnDefault } from 'node-pty-prebuilt-multiarch'
import { wirePtyHandle, type PtySpawn, type WiredPtyHandle } from './device-login-runner.js'

// Sobe o `agy` em modo CHAT (sem argumentos — é o TUI normal do produto, NÃO
// `agy usage`, que falha sem TTY e nem é o comando certo de quota — ver o
// comentário grande em antigravity-quota-reader.ts, apps/control-plane). A
// quota real do Antigravity vem do slash `/usage` DENTRO deste chat, que só
// funciona sob um PTY de verdade (provado ao vivo 21/07, ver
// docs/operations/engine-collection-real-steps.md).
//
// Diferente do login assistido (device-login-runner.ts), aqui o `agy` roda
// DIRETO no host — sem container/podman — com HOME apontando pro dir já
// materializado com a credencial (`antigravity-oauth-token`). Mesmo padrão
// que `model-catalog.ts`/`quota-reader.ts` (control-plane) já usam pra ler
// modelos/quota do Antigravity (`defaultRunner`): nenhum isolamento extra
// além do HOME, porque a leitura de quota não executa nada perigoso — só lê
// uma tela.

export type AgyChatHandle = WiredPtyHandle

// Terminal largo o bastante pra a tela do `/usage` (barras de progresso +
// legendas) nunca quebrar em múltiplas linhas dentro do buffer — mesmo
// raciocínio do PTY_COLS de device-login-runner.ts (lá é pra URL de OAuth de
// ~500 chars; aqui a tela é bem mais estreita, mas um terminal largo nunca
// atrapalha um parser baseado em regex/linha, só evita qualquer wrap).
export const AGY_CHAT_PTY_COLS = 200
export const AGY_CHAT_PTY_ROWS = 50

export interface RunAgyChatCommandOptions {
  /** HOME já materializado com a credencial do Antigravity (ver
   * `antigravity-quota-reader.ts`, control-plane) — vira o HOME do processo
   * `agy` spawnado (sem container: é o MESMO dir, não um bind-mount). */
  homeDir: string
  /** Binário a rodar — default `agy`, sobrescrevível (mesmo padrão de
   * `GITORCH_AGY_BIN` no resto do produto; o override em si é
   * responsabilidade de quem chama, não deste helper genérico de PTY). */
  agyBin?: string
  cols?: number
  rows?: number
  /** Injetável para teste — NUNCA sobe o `agy` real numa suite de testes. */
  ptySpawnImpl?: PtySpawn
}

/**
 * Sobe `agy` (modo chat) sob um PTY real, DIRETO no host, com `HOME` apontado
 * pro homeDir recebido. Devolve um handle de stdout/stdin/exit/kill — quem
 * chama (`antigravity-quota-reader.ts`) é dono do PROTOCOLO inteiro (tratar
 * telas de onboarding se reaparecerem, mandar `/usage`, capturar e parsear a
 * tela, sair limpo) — este módulo só sabe subir o processo, igual
 * `runDeviceLogin` é dono só do spawn no login assistido. `wirePtyHandle` (
 * device-login-runner.ts) é a MESMA fiação de PTY que o login usa — reusada
 * aqui de propósito, pra nunca reinventar node-pty duas vezes no repo.
 */
export function runAgyChatCommand(options: RunAgyChatCommandOptions): AgyChatHandle {
  const bin = options.agyBin ?? 'agy'
  const spawnPty = options.ptySpawnImpl ?? ptySpawnDefault

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: options.homeDir,
  }
  // Mesma razão do `defaultRunner` em model-catalog.ts/quota-reader.ts: sem
  // XDG_RUNTIME_DIR o Antigravity CLI trava no socket do seu language-server
  // interno.
  if (process.env['XDG_RUNTIME_DIR']) env['XDG_RUNTIME_DIR'] = process.env['XDG_RUNTIME_DIR']

  const ptyProcess = spawnPty(bin, [], {
    name: 'xterm-256color',
    cols: options.cols ?? AGY_CHAT_PTY_COLS,
    rows: options.rows ?? AGY_CHAT_PTY_ROWS,
    env,
  })

  return wirePtyHandle(ptyProcess)
}
