/**
 * Script TEMPORÁRIO de diagnóstico — somente leitura. Investiga por que o auto-fix nativo
 * do Jules não reagiu a uma falha de CI. Não envia nenhuma mensagem.
 * Uso: tsx debug-jules-session.ts <sessionId>
 */
import { JulesClient } from './lib/jules-client.js'

async function main(): Promise<void> {
  const sessionId = process.argv[2]
  if (!sessionId) {
    console.error('Uso: tsx debug-jules-session.ts <sessionId>')
    process.exit(1)
  }
  const apiKey = process.env['JULES_API_KEY']
  if (!apiKey) throw new Error('JULES_API_KEY não configurado')

  const jules = new JulesClient(apiKey)

  console.log('=== SESSION ===')
  try {
    const session = await jules.getSession(sessionId)
    console.log(JSON.stringify(session, null, 2))
  } catch (err) {
    console.error('getSession falhou:', err instanceof Error ? err.message : err)
  }

  console.log('\n=== ACTIVITIES (últimas 30) ===')
  try {
    const activities = await jules.getActivities(sessionId, 30)
    console.log(JSON.stringify(activities, null, 2))
  } catch (err) {
    console.error('getActivities falhou:', err instanceof Error ? err.message : err)
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
