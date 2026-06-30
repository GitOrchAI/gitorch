/**
 * OpenRouter Client — Free-Route-Only com retry anti-moderação.
 *
 * Regra inegociável: SEMPRE usa a rota free (`openrouter/free`), NUNCA modelo pago
 * e NUNCA modelo hardcoded. A rota free re-sorteia um modelo grátis por chamada.
 *
 * Problema que isto resolve: a rota free pode sortear um modelo de moderação
 * (ex.: `nvidia/nemotron-3.5-content-safety`) cuja única saída é um veredito tipo
 * "User Safety: safe". A resposta inclui o campo `model` dizendo qual modelo respondeu;
 * usamos isso (+ validação de conteúdo) para detectar saída ruim e re-chamar a rota free,
 * que re-sorteia outro modelo — até obter uma resposta utilizável.
 */

import { z } from 'zod'

export const FREE_ROUTE = 'openrouter/free'

// Configuration schema
export const OpenRouterConfigSchema = z.object({
  apiKey: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  model: z.string().default(FREE_ROUTE),
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  maxTokens: z.number().int().positive().default(8000),
  temperature: z.number().min(0).max(2).default(0.1),
  referer: z.string().url().optional(),
  title: z.string().optional(),
  timeoutMs: z.number().int().positive().default(60000),
  // Número de re-sorteios da rota free quando vem modelo de moderação / saída ruim.
  maxRetries: z.number().int().nonnegative().default(6),
})

export type OpenRouterConfig = z.infer<typeof OpenRouterConfigSchema>

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
})

export const ChatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  // Modelo realmente usado pela rota free — chave para detectar moderação.
  model: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number().optional(),
      message: ChatMessageSchema,
      finish_reason: z.string().nullable().optional(),
    })
  ),
})

export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>

/**
 * Valida que o modelo é a rota free ou um modelo com sufixo :free. Caso contrário, throw.
 */
export function validateFreeRoute(model: string): void {
  const isFree = model === FREE_ROUTE || model.endsWith(':free')
  if (!isFree) {
    throw new Error(
      `Apenas a rota free ('${FREE_ROUTE}') ou modelos ':free' são permitidos. Recebido: '${model}'`
    )
  }
}

/**
 * Detecta, pelo id do modelo retornado, se a rota free caiu num modelo de moderação/safety,
 * cujo propósito é classificar conteúdo (não gerar texto útil).
 */
export function isModerationModel(modelId: string): boolean {
  return /safety|guard|moderation/i.test(modelId)
}

/**
 * Detecta saída inutilizável: vazia, curta demais, ou um veredito de moderação.
 */
export function isBadOutput(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 20) return true
  if (/^\s*(\*\*)?\s*(user\s+|content\s+)?(safety|policy|moderation)\s*:/i.test(trimmed))
    return true
  if (/^\s*safe\.?\s*$/i.test(trimmed)) return true
  return false
}

// Apenas padrões ANCORADOS de veredito — nunca apaga a palavra "safe" de texto legítimo.
const SAFETY_VERDICT_LINES = [
  /^\s*(\*\*)?\s*User Safety:.*$/gim,
  /^\s*(\*\*)?\s*Content Policy:\s*safe.*$/gim,
  /^\s*(\*\*)?\s*Safety:\s*safe.*$/gim,
] as const

/**
 * Limpa resíduos de veredito de moderação (rede de segurança). A defesa principal é o retry.
 */
export function sanitizeResponse(text: string): string {
  let sanitized = text
  for (const pattern of SAFETY_VERDICT_LINES) {
    sanitized = sanitized.replace(pattern, '')
  }
  return sanitized.replace(/\n{3,}/g, '\n\n').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OpenRouterClient {
  private readonly config: OpenRouterConfig
  private readonly headers: Record<string, string>

  constructor(config: Partial<OpenRouterConfig> & { apiKey: string }) {
    this.config = OpenRouterConfigSchema.parse(config)
    validateFreeRoute(this.config.model)
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      'HTTP-Referer': this.config.referer || 'https://github.com/loureng/gitorch',
      'X-Title': this.config.title || 'GitOrch Dependabot-Jules Automation',
    }
  }

  private async postChat(
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: FREE_ROUTE,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenRouter API error (${response.status}): ${errorText}`)
      }
      const data = await response.json()
      return ChatCompletionResponseSchema.parse(data)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Chama a rota free e re-sorteia até obter resposta utilizável (não-moderação, não-vazia).
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? this.config.maxTokens
    const temperature = options?.temperature ?? this.config.temperature

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const data = await this.postChat(messages, maxTokens, temperature)
        const usedModel = data.model ?? 'desconhecido'
        const content = sanitizeResponse(data.choices[0]?.message?.content ?? '')

        if (isModerationModel(usedModel) || isBadOutput(content)) {
          console.warn(
            `Rota free sorteou modelo ruim (${usedModel}) ou saída inutilizável, re-sorteando [${attempt + 1}/${this.config.maxRetries + 1}]`
          )
          await sleep(Math.min(1000 * 2 ** attempt, 8000))
          continue
        }

        console.log(`Resposta utilizável obtida do modelo: ${usedModel}`)
        return content
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        // 401/403 = credencial inválida: não adianta repetir.
        if (lastError.message.includes('401') || lastError.message.includes('403')) {
          throw lastError
        }
        console.warn(
          `Falha na chamada à rota free [${attempt + 1}/${this.config.maxRetries + 1}]: ${lastError.message}`
        )
        await sleep(Math.min(1000 * 2 ** attempt, 8000))
      }
    }

    throw (
      lastError || new Error('Rota free não retornou resposta utilizável após todas as tentativas')
    )
  }

  async complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    return this.chatCompletion([{ role: 'user', content: prompt }], options)
  }

  async completeWithSystem(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    return this.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options
    )
  }
}

/**
 * Cria um OpenRouterClient a partir do ambiente. SEMPRE rota free.
 * `OPENROUTER_FREE_MODEL`, se presente, deve ser a rota free ou um modelo ':free' — senão throw.
 */
export function createOpenRouterClientFromEnv(): OpenRouterClient {
  const env = process.env as Record<string, string | undefined>
  const apiKey = env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set')
  }

  const model = env['OPENROUTER_FREE_MODEL'] || FREE_ROUTE
  validateFreeRoute(model)

  return new OpenRouterClient({
    apiKey,
    model,
    referer: env['REPO_OWNER']
      ? `https://github.com/${env['REPO_OWNER']}/${env['REPO_NAME'] || 'gitorch'}`
      : undefined,
    title: 'GitOrch Dependabot-Jules Automation',
    maxTokens: 8000,
    temperature: 0.1,
    timeoutMs: 120000,
    maxRetries: 6,
  })
}
