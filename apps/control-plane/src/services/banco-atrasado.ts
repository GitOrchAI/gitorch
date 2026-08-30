import { computePending } from '../lib/migration-ledger.js'
import { buildTelegramNotifier } from './sm-watchdog.js'

/**
 * O banco está atrás do código — e alguém precisa ficar sabendo.
 *
 * INCIDENTE DE 26/08/2026: entre 19:43 e 21:05 NENHUMA missão rodou nos dois
 * projetos. A coluna `missions.waiting_status` não existia: o PR que a
 * introduziu trouxe o campo no schema E o SQL no ledger, mas o SQL nunca foi
 * aplicado. A cada tique o scheduler estourava P2022 e morria em
 * `processSetupMissions`.
 *
 * Oitenta minutos de esteira parada. O erro estourava de minuto em minuto no
 * journal — e journal ninguém lê. Não virou alerta, não virou estado, não
 * virou nada. O dono só soube porque alguém foi olhar o log por outro motivo.
 *
 * O conserto do dia foi rodar a migração na mão. O conserto de verdade é este:
 * o produto CONFERE no arranque se o banco está em dia com o ledger e, se não
 * estiver, grita — no log e no chat do dono, dizendo o comando que resolve.
 *
 * POR QUE NÃO RECUSAR SUBIR: derrubar o processo levaria junto a API, os
 * webhooks do GitHub e o assistente de configuração — coisas que funcionam
 * mesmo com uma coluna faltando. Subir calado foi o defeito; subir gritando é
 * o conserto. Recusar seria trocar uma falha silenciosa por uma queda total.
 */

export interface EstadoDoBanco {
  /** Migrações do ledger que ainda não foram aplicadas, na ordem canônica. */
  pendentes: string[]
  emDia: boolean
}

export function estadoDoBanco(aplicadas: string[]): EstadoDoBanco {
  const pendentes = computePending(aplicadas)
  return { pendentes, emDia: pendentes.length === 0 }
}

/**
 * O recado para o dono.
 *
 * Diz O QUE FAZER, não só que quebrou — ele não é técnico, e um aviso que só
 * informa a falha transfere para ele o trabalho de descobrir a saída. O
 * comando vai literal porque é ele que resolve, e porque foi exatamente o que
 * resolveu no dia.
 */
export function recadoDeBancoAtrasado(pendentes: string[]): string {
  const quantas =
    pendentes.length === 1 ? 'uma mudança de banco' : `${pendentes.length} mudanças de banco`
  return [
    `GitOrch: o banco está atrasado em relação ao código — falta aplicar ${quantas}.`,
    '',
    'Enquanto isso não for feito, as tarefas automáticas podem parar sem aviso: foi o que',
    'aconteceu em 26/08, quando a esteira ficou 80 minutos morta por causa de uma coluna que',
    'não existia.',
    '',
    'Para resolver, rode na máquina do GitOrch:',
    '  cd apps/control-plane && bash scripts/db-migrate.sh',
  ].join('\n')
}

/**
 * O canal para falar com o dono da INSTÂNCIA, ou `null` se não houver.
 *
 * Vai direto no chat da instância, sem passar por `resolveNotifyChatId`: aquele
 * caminho resolve o chat de um PROJETO (parte do userId dele), e um problema de
 * infra (banco atrasado, relógio interno quebrado) não é problema de projeto
 * nenhum — é da instância inteira, e às vezes ainda não há projeto em mãos
 * (arranque) nem tarefa em andamento (relógio parado).
 *
 * Nunca lança: sem chat ligado o aviso fica só no log, que é o que sobra, e é
 * melhor que derrubar o arranque ou o relógio por falta de mensageiro.
 *
 * Movida de index.ts (era função local, uso único) para cá quando o relógio
 * interno (scheduler.ts) passou a precisar do MESMO canal para avisar de tique
 * quebrado repetido — dois consumidores merecem um lugar canônico, não duas
 * cópias divergindo.
 */
export function notificadorDaInstancia(): ((texto: string) => Promise<boolean>) | null {
  const chatId = process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID']
  const avisar = buildTelegramNotifier({
    botToken: process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
    ...(chatId ? { chatId } : {}),
  })
  return avisar ?? null
}

/** O mínimo de banco que a conferência precisa. */
export interface PrismaParaConferencia {
  $queryRawUnsafe: (sql: string) => Promise<Array<{ name: string }>>
}

/**
 * Confere no ARRANQUE se o banco está em dia e, se não estiver, grita.
 *
 * Best-effort e nunca lança: se a própria conferência falhar (tabela do ledger
 * ausente num banco virgem, banco fora do ar no instante do boot), o processo
 * segue subindo. O objetivo é não repetir o silêncio de 26/08, não criar um
 * novo jeito de o produto não subir.
 */
export async function conferirBancoNoArranque(args: {
  prisma: PrismaParaConferencia
  avisar: ((texto: string) => Promise<boolean>) | null
  log: { warn: (msg: string) => void; info: (msg: string) => void }
}): Promise<EstadoDoBanco | null> {
  let aplicadas: string[]
  try {
    const linhas = await args.prisma.$queryRawUnsafe('SELECT name FROM gitorch_schema_migrations')
    aplicadas = linhas.map((l) => l.name)
  } catch (err) {
    args.log.warn(
      `[Arranque] não consegui conferir se o banco está em dia: ${(err as Error).message}`
    )
    return null
  }

  const estado = estadoDoBanco(aplicadas)
  if (estado.emDia) {
    args.log.info(`[Arranque] banco em dia com o ledger (${aplicadas.length} migrações aplicadas)`)
    return estado
  }

  // Alto e claro nos DOIS canais. O log sozinho foi o que não bastou.
  args.log.warn(
    `[Arranque] BANCO ATRASADO: faltam ${estado.pendentes.length} migração(ões) — ` +
      `${estado.pendentes.join(', ')}. Rode apps/control-plane/scripts/db-migrate.sh. ` +
      `Enquanto isso, missões podem falhar com coluna inexistente.`
  )
  if (args.avisar) await args.avisar(recadoDeBancoAtrasado(estado.pendentes))
  return estado
}
