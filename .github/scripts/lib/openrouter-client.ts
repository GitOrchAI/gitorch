/**
 * OpenRouter Client with Free Model Enforcement and Safety Filter
 *
 * Only allows :free models and sanitizes "User Safety: safe" leakage from responses.
 */

import { z } from 'zod'

// Configuration schema
export const OpenRouterConfigSchema = z.object({
  apiKey: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  model: z
    .string()
    .regex(/:free$/, 'Model must end with :free suffix')
    .default('openrouter/free'),
  fallbackModels: z
    .array(z.string().regex(/:free$/))
    .default([
      'openrouter/free',
      'qwen/qwen3-coder:free',
      'openai/gpt-oss-20b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-26b-a4b-it:free',
      'poolside/laguna-m.1:free',
      'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      'openai/gpt-oss-120b:free',
    ]),
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  maxTokens: z.number().int().positive().default(8000),
  temperature: z.number().min(0).max(2).default(0.1),
  referer: z.string().url().optional(),
  title: z.string().optional(),
  timeoutMs: z.number().int().positive().default(60000),
  maxRetries: z.number().int().nonnegative().default(3),
})

export type OpenRouterConfig = z.infer<typeof OpenRouterConfigSchema>

// Request/Response schemas
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
})

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
})

export const ChatCompletionChoiceSchema = z.object({
  index: z.number(),
  message: ChatMessageSchema,
  finish_reason: z.string().nullable(),
})

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChatCompletionChoiceSchema),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
})

export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>

// Safety filter patterns to remove from free model outputs
const SAFETY_FILTER_PATTERNS = [
  /User Safety: safe/gi,
  /Safety: safe/gi,
  /Content Policy: safe/gi,
  /SAFE/gi,
  /\[User Safety: safe\]/gi,
  /\*\*User Safety: safe\*\*/gi,
] as const

/**
 * Sanitizes LLM response by removing safety filter leakage artifacts
 */
export function sanitizeResponse(text: string): string {
  let sanitized = text

  for (const pattern of SAFETY_FILTER_PATTERNS) {
    sanitized = sanitized.replace(pattern, '')
  }

  // Clean up extra whitespace and empty lines
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim()

  return sanitized
}

/**
 * Validates that a model string uses the :free suffix
 */
export function validateFreeModel(model: string): void {
  if (!model.endsWith(':free')) {
    throw new Error(`Model must use :free suffix. Got: ${model}`)
  }
}

/**
 * Creates a delay with exponential backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * OpenRouter Client for free models with safety filtering
 */
export class OpenRouterClient {
  private readonly config: OpenRouterConfig
  private readonly headers: Record<string, string>

  constructor(config: Partial<OpenRouterConfig> & { apiKey: string }) {
    const parsed = OpenRouterConfigSchema.parse(config)
    this.config = parsed

    // Validate model is free
    validateFreeModel(this.config.model)

    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      'HTTP-Referer': this.config.referer || 'https://github.com/loureng/gitorch',
      'X-Title': this.config.title || 'GitOrch Dependabot-Jules Automation',
    }
  }

  /**
   * Creates a chat completion with retry logic and safety filtering
   * Tries primary model, then fallback models if they fail
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: { model?: string; maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const primaryModel = options?.model || this.config.model
    validateFreeModel(primaryModel)

    // Build model list: primary + fallbacks (deduplicated)
    const modelsToTry = [primaryModel, ...this.config.fallbackModels].filter(
      (m, i, arr) => arr.indexOf(m) === i
    )

    const requestBodyBase = {
      messages,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
    }

    let lastError: Error | null = null

    for (const model of modelsToTry) {
      validateFreeModel(model)

      const requestBody: ChatCompletionRequest = {
        model,
        ...requestBodyBase,
      }

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)

          const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          })

          clearTimeout(timeoutId)

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`OpenRouter API error (${response.status}): ${errorText}`)
          }

          const data = await response.json()
          const parsed = ChatCompletionResponseSchema.parse(data)

          if (!parsed.choices || parsed.choices.length === 0) {
            throw new Error('No choices in OpenRouter response')
          }

          const content = parsed.choices[0]?.message?.content ?? ''
          return sanitizeResponse(content)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Don't retry on certain errors
          if (error instanceof Error) {
            if (
              error.name === 'AbortError' ||
              error.message.includes('401') ||
              error.message.includes('403')
            ) {
              throw error
            }
          }

          if (attempt < this.config.maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000)
            console.warn(
              `OpenRouter request failed (model: ${model}, attempt ${attempt + 1}/${this.config.maxRetries + 1}), retrying in ${delay}ms:`,
              lastError.message
            )
            await sleep(delay)
          }
        }
      }

      // If we exhausted retries for this model, try next fallback
      console.warn(`Model ${model} exhausted retries, trying next fallback...`)
    }

    throw lastError || new Error('OpenRouter request failed after all models and retries')
  }

  /**
   * Creates a simple completion with a single user message
   */
  async complete(
    prompt: string,
    options?: { model?: string; maxTokens?: number; temperature?: number }
  ): Promise<string> {
    return this.chatCompletion([{ role: 'user', content: prompt }], options)
  }

  /**
   * Creates a completion with system + user messages
   */
  async completeWithSystem(
    systemPrompt: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number; temperature?: number }
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
 * Creates an OpenRouterClient from environment variables
 */
export function createOpenRouterClientFromEnv(): OpenRouterClient {
  const env = process.env as Record<string, string | undefined>
  const apiKey = env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set')
  }

  return new OpenRouterClient({
    apiKey,
    model: env['OPENROUTER_FREE_MODEL'] || 'qwen/qwen-2.5-7b-instruct:free',
    referer: env['REPO_OWNER']
      ? `https://github.com/${env['REPO_OWNER']}/${env['REPO_NAME'] || 'gitorch'}`
      : undefined,
    title: 'GitOrch Dependabot-Jules Automation',
    maxTokens: 8000,
    temperature: 0.1,
    timeoutMs: 120000,
    maxRetries: 3,
  })
}
