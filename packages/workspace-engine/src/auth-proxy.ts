import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

export interface AuthProxyEvents {
  prompt: (message: string, respond: (answer: string) => void) => void
}

export interface AuthProxyOptions {
  stdout: Readable
  stdin: Writable
  stderr?: Readable
}

export class AuthProxy extends EventEmitter {
  private stdin: Writable
  private stdout: Readable
  private stderr?: Readable
  private buffer = ''
  private maxBufferSize = 4096
  private streamListeners: Array<{
    stream: Readable
    handler: (chunk: Buffer | string) => void
  }> = []

  constructor(options: AuthProxyOptions) {
    super()
    this.stdin = options.stdin
    this.stdout = options.stdout
    this.stderr = options.stderr

    this.setupListeners()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on<K extends keyof AuthProxyEvents>(event: K, listener: AuthProxyEvents[K]): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.on(event, listener as any)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override once<K extends keyof AuthProxyEvents>(event: K, listener: AuthProxyEvents[K]): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.once(event, listener as any)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off<K extends keyof AuthProxyEvents>(event: K, listener: AuthProxyEvents[K]): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.off(event, listener as any)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit<K extends keyof AuthProxyEvents>(
    event: K,
    ...args: Parameters<AuthProxyEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }

  private setupListeners(): void {
    const handleData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      this.buffer += text
      if (this.buffer.length > this.maxBufferSize) {
        this.buffer = this.buffer.slice(-this.maxBufferSize)
      }

      if (this.containsPromptPattern(this.buffer)) {
        const promptMsg = this.buffer
        // Limpa o buffer para não disparar o mesmo prompt novamente em chunks subsequentes
        this.buffer = ''
        this.emit('prompt', promptMsg, (answer: string) => {
          this.provideAnswer(answer)
        })
      }
    }

    this.stdout.on('data', handleData)
    this.streamListeners.push({ stream: this.stdout, handler: handleData })

    if (this.stderr) {
      this.stderr.on('data', handleData)
      this.streamListeners.push({ stream: this.stderr, handler: handleData })
    }
  }

  private containsPromptPattern(text: string): boolean {
    const patterns = [/token/i, /code/i, /password/i, /prompt/i, /auth/i, /login/i]
    return patterns.some((pattern) => pattern.test(text))
  }

  public provideAnswer(answer: string): void {
    this.stdin.write(`${answer}\n`)
  }

  public destroy(): void {
    for (const listener of this.streamListeners) {
      listener.stream.off('data', listener.handler)
    }
    this.streamListeners = []
    this.removeAllListeners()
  }
}
