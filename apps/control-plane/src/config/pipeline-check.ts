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

export function parsePipelineError(
  error: unknown,
  context: { step?: string } = {}
): PipelineErrorMetadata {
  const message = error instanceof Error ? error.message : String(error)
  const step = context.step || 'unknown'
  const lowerMsg = message.toLowerCase()

  if (lowerMsg.includes('lint')) {
    return {
      step,
      reason: 'Falha de Linting',
      mitigationAction: 'Revisar erros de linting e corrigir estilo de código',
      requiresAction: true,
    }
  }

  if (lowerMsg.includes('test')) {
    return {
      step,
      reason: 'Falha de Teste',
      mitigationAction: 'Revisar falhas nos testes e corrigir regressões',
      requiresAction: true,
    }
  }

  if (lowerMsg.includes('build')) {
    return {
      step,
      reason: 'Falha de Build',
      mitigationAction: 'Verificar logs de compilação/build',
      requiresAction: true,
    }
  }

  return {
    step,
    reason: 'Erro Técnico Desconhecido',
    mitigationAction: 'Analisar stack trace e logs brutamente',
    requiresAction: true,
  }
}
