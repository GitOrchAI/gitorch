import { validateForm, type MiniSchema } from '@gitorch/cadence'

// Rails-runner: executa UM passo de roteiro sob a Lei "LLM decide, sistema
// executa". O motor devolve texto; aqui extraímos o JSON, validamos contra o
// schema do formulário e, se vier torto, re-perguntamos com os erros (repair).
// Esgotou → RailsStepError, que o chamador usa para acionar o failover de motor.

export class RailsStepError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
    public readonly attempts: number
  ) {
    super(message)
    this.name = 'RailsStepError'
  }
}

/**
 * Extrai o PRIMEIRO objeto JSON balanceado de um texto de motor (que pode vir
 * com prosa em volta e cercas de markdown). Ignora chaves dentro de strings.
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  for (let from = start; from !== -1; from = text.indexOf('{', from + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = from; i < text.length; i++) {
      const ch = text[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(from, i + 1))
          } catch {
            break // objeto malformado: tenta a partir da próxima '{'
          }
        }
      }
    }
  }
  return null
}

export interface RunFormStepOptions {
  schema: MiniSchema
  prompt: string
  /** Executa o motor com um prompt e devolve a saída de texto crua. */
  execute: (prompt: string) => Promise<string>
  /** Re-tentativas com feedback dos erros (padrão 2). */
  maxRepairs?: number
}

/**
 * Roda um passo de formulário: motor → extrai JSON → valida → (repair)* →
 * objeto validado. Nunca aplica nada — quem age é o executor determinístico.
 */
export async function runFormStep(options: RunFormStepOptions): Promise<unknown> {
  const maxRepairs = options.maxRepairs ?? 2
  let prompt = options.prompt
  let lastErrors: string[] = []

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const output = await options.execute(prompt)
    const parsed = extractJson(output)

    if (parsed === null) {
      lastErrors = ['no JSON object found in the reply']
    } else {
      const check = validateForm(options.schema, parsed)
      if (check.ok) return parsed
      lastErrors = check.errors
    }

    // Repair: re-pergunta apontando exatamente o que veio errado.
    prompt = [
      options.prompt,
      '',
      'Your previous reply was invalid:',
      ...lastErrors.map((e) => `- ${e}`),
      '',
      'Reply again with ONLY a single valid JSON object matching the schema.',
    ].join('\n')
  }

  throw new RailsStepError(
    `Form step failed after ${maxRepairs + 1} attempts: ${lastErrors.join('; ')}`,
    lastErrors,
    maxRepairs + 1
  )
}
