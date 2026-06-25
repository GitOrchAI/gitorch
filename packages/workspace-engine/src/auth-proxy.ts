import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

export interface AuthProxyOptions {
  stdout: Readable
  stdin: Writable
  stderr?: Readable
}

export class AuthProxy extends EventEmitter {
  private stdin: Writable
  private stdout: Readable
  private stderr?: Readable

  constructor(options: AuthProxyOptions) {
    super()
    this.stdin = options.stdin
    this.stdout = options.stdout
    this.stderr = options.stderr

    this.setupListeners()
  }

  private setupListeners(): void {
    const handleData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (this.containsPromptPattern(text)) {
        this.emit('prompt', text, (answer: string) => {
          this.provideAnswer(answer)
        })
      }
    }

    this.stdout.on('data', handleData)
    if (this.stderr) {
      this.stderr.on('data', handleData)
    }
  }

  private containsPromptPattern(text: string): boolean {
    const patterns = [/token/i, /code/i, /password/i, /prompt/i, /auth/i, /login/i]
    return patterns.some((pattern) => pattern.test(text))
  }

  public provideAnswer(answer: string): void {
    this.stdin.write(`${answer}\n`)
  }
}
