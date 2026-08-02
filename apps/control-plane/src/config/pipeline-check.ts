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
