import { recadoDeMotorRevogado } from './recado-de-motor-revogado.js'

/**
 * DJ-T18 (15/09) — DECISÃO DO DONO, pergunta estruturada: quando um motor é
 * revogado de vez (`ehRevogacaoDefinitiva`, `renovar-motores.ts`) e o dono
 * precisa reconectar, o aviso vai para AS DUAS pontas, nunca uma no lugar da
 * outra. Telegram continua (pedido textual do dono, 26/08: "pq não recebo
 * informação via telegram pra fazer renew caso o automático não funcione?");
 * o painel entra por D76 (10/09): "se eu precisar ver como estão as coisas eu
 * acesso o painel; o Telegram é como WhatsApp".
 *
 * Extraído do call site em `scheduler.ts` (dentro de `renovarMotoresDoRelogio`)
 * para poder testar a ORQUESTRAÇÃO do aviso sem precisar simular o CLI do
 * motor de verdade (`materializeToHome`/`realRuntimeCommandRunner`, que
 * fazem I/O de arquivo e processo) — a decisão de SE renova continua em
 * `renovar-motores.ts`, o TEXTO em `recado-de-motor-revogado.ts`; este
 * arquivo só liga os dois canais de aviso.
 *
 * `EngineConnection` é por USUÁRIO (um motor serve todos os projetos dele),
 * não por projeto — sem um projeto "dono" natural do evento, usa QUALQUER
 * projeto ATIVO do mesmo usuário: `GET /api/v1/painel/timeline`
 * (routes/painel.ts) já agrega os eventos de TODOS os projetos ativos do
 * dono e nunca mostra de qual projeto veio, então o texto aparece igual não
 * importa qual projeto carrega o registro. Sem projeto ativo (usuário só
 * conectou o motor no assistente, nunca cadastrou um projeto): nada para
 * anexar no painel — o Telegram, quando ligado, já avisou; best-effort aqui,
 * igual ao resto desta vigília (nunca pode derrubar o tique).
 */

/** Só o que `avisarMotorRevogado` precisa do Prisma. */
export interface PrismaDoAvisoDeMotorRevogado {
  project: {
    findFirst: (args: {
      where: { userId: string; isActive: boolean }
      select: { id: true }
    }) => Promise<{ id: string } | null>
  }
}

export interface AvisarMotorRevogadoArgs {
  prisma: PrismaDoAvisoDeMotorRevogado
  userId: string
  runtime: string
  /** `undefined` quando não há bot/chat configurado — mesmo contrato de `buildTelegramNotifier`. */
  avisarPorTelegram: ((texto: string) => Promise<boolean>) | undefined
  /** `registrarStatusNoPainel` de `scheduler.ts` — já embrulha `registrarNoPainelUmaVez` + log de falha (best-effort). */
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
}

/**
 * Chave estável do dedupe no painel — `registrarNoPainelUmaVez` grava no
 * máximo UM evento por chave. Por `runtime` E `userId`: motores diferentes do
 * mesmo dono nunca compartilham chave (cada revogação é seu próprio fato), e
 * o mesmo motor reprocessado (mesmo par) nunca duplica.
 */
export function chaveDeMotorRevogado(runtime: string, userId: string): string {
  return `motor-revogado:${runtime}:${userId}`
}

/**
 * Avisa o dono de um motor revogado nas DUAS pontas — Telegram (se houver
 * vínculo) e o painel (se houver projeto ativo para anexar o registro).
 *
 * Nenhuma das duas condiciona a outra: falha ou ausência de uma nunca
 * impede a outra de rodar. `avisarPorTelegram` já vem resolvido (undefined
 * quando não há bot/chat, o mesmo contrato de `buildTelegramNotifier`) — este
 * módulo só decide QUANDO chamar, não COMO montar o notificador. A busca do
 * projeto é best-effort (`.catch`): uma falha de banco aqui não pode apagar
 * o aviso que já foi (ou vai ser) entregue por Telegram.
 */
export async function avisarMotorRevogado(args: AvisarMotorRevogadoArgs): Promise<void> {
  const texto = recadoDeMotorRevogado(args.runtime)

  if (args.avisarPorTelegram) {
    await args.avisarPorTelegram(texto)
  }

  const projeto = await args.prisma.project
    .findFirst({ where: { userId: args.userId, isActive: true }, select: { id: true } })
    .catch(() => null)
  if (!projeto) return

  await args.registrarNoPainel(projeto.id, chaveDeMotorRevogado(args.runtime, args.userId), texto)
}
