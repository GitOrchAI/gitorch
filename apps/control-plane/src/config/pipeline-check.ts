/**
 * Modo INERTE para o health pré-switch da esteira (F2.3): a app sobe inteira
 * (rotas, prisma, redis, front estático) mas NÃO age — sem tick do scheduler,
 * sem varredura de mission-creds no boot, sem ceifador, sem getUpdates do
 * Telegram. Sem isto, a instância de verificação apagaria credencial de missão
 * em voo, disputaria missões contra a prod viva e causaria 409 no bot (P1-2).
 * NODE_ENV continua 'production' de propósito.
 */
export function pipelineCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['GITORCH_PIPELINE_CHECK'] === '1'
}

export interface PipelineErrorMetadata {
  step: string
  reason: string
  mitigationAction: string
  requiresAction: boolean
}

export function parsePipelineError(error: unknown, stepContext: string): PipelineErrorMetadata {
  let reason = 'Unknown pipeline error'
  if (error instanceof Error) {
    reason = error.message
  } else if (typeof error === 'string') {
    reason = error
  } else if (error !== null && typeof error === 'object') {
    reason = JSON.stringify(error)
  }

  return {
    step: stepContext || 'unknown',
    reason,
    mitigationAction: 'Manual operator intervention required',
    requiresAction: true,
  }
}
