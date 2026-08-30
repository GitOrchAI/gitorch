import type { PrismaClient } from '@prisma/client'

/**
 * A cota de cada motor do dono, lida de `engine_connections`.
 *
 * POR QUE ESTE ARQUIVO EXISTE (30/08/2026): o painel dizia "Nenhum motor
 * conectado ainda." com o banco cheio. A rota `/api/v1/painel/agentes` recebia
 * a leitura por injeção e caía num default `async () => []` porque
 * `painelRoutes(app)` era chamada sem o segundo argumento. Vazio é um estado
 * PLAUSÍVEL — por isso ninguém viu por semanas.
 *
 * O default era honesto quando foi escrito: naquele momento a cota realmente
 * não era gravada em lugar nenhum. O PR #381 passou a gravá-la pelo relógio, e
 * a premissa expirou sem ninguém voltar aqui. Premissa que expira em silêncio
 * é a mentira mais cara: continua parecendo verdade.
 *
 * Nada de segunda fonte da verdade: os números saem das MESMAS colunas que o
 * coletor grava (`services/quota-reader.ts` -> `engine_connections`).
 */

/** Nomes de exibição — os MESMOS do assistente (components/setup/engine-status.ts).
 *  Dois nomes para o mesmo motor em telas diferentes confundem o dono. */
export const NOMES_DOS_MOTORES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  github: 'GitHub',
}

/** Estado do motor, do ponto de vista de quem vai usá-lo agora. */
export type EstadoDoMotor =
  /** dá para trabalhar. */
  | 'ligado'
  /** a credencial venceu e a renovação automática não deu conta. */
  | 'precisa_religar'
  /** nunca foi conectado, ou está no meio do processo. */
  | 'nao_conectado'

export interface MotorCota {
  /** o runtime, como o banco guarda: claude | codex | antigravity | github. */
  id: string
  nome: string
  estado: EstadoDoMotor
  /** % JÁ USADO da janela de sessão. `null` = não sei (nunca zero). */
  sessao: number | null
  /** % JÁ USADO da janela da semana. `null` = não sei. */
  semana: number | null
  /** quando a cota foi lida, ISO. `null` = nunca foi lida. */
  lidoEm: string | null
  /** o que o dono precisa fazer. Separado de `estado` porque é a ação, não o fato. */
  precisaReligar: boolean
}

/**
 * `needs_reconnect` é o que o produto grava quando a credencial vence e a
 * renovação falha. Qualquer outro estado que não seja `connected` significa
 * "ainda não dá para usar", e o dono precisa ver isso — o assistente já mostrou
 * "Codex Conectado" com o motor morto havia uma hora, e foi ele quem descobriu.
 */
function estadoDe(status: string): EstadoDoMotor {
  if (status === 'needs_reconnect') return 'precisa_religar'
  if (status === 'connected') return 'ligado'
  return 'nao_conectado'
}

export async function lerCotasDosMotores(
  prisma: Pick<PrismaClient, 'engineConnection'>,
  ownerId: string
): Promise<MotorCota[]> {
  const linhas = await prisma.engineConnection.findMany({
    where: { userId: ownerId },
    orderBy: { runtime: 'asc' },
    select: {
      runtime: true,
      status: true,
      sessionPercentUsed: true,
      weekPercentUsed: true,
      quotaRefreshedAt: true,
    },
  })

  return linhas.map((l) => {
    const estado = estadoDe(l.status)
    return {
      id: l.runtime,
      // Motor fora da lista cai no nome cru em vez de sumir: melhor mostrar
      // algo do que esconder um motor que existe de verdade.
      nome: NOMES_DOS_MOTORES[l.runtime] ?? l.runtime,
      estado,
      // `?? null` e não `?? 0`: zero é um número, e diria ao dono que a cota
      // está inteira quando na verdade ninguém mediu.
      sessao: l.sessionPercentUsed ?? null,
      semana: l.weekPercentUsed ?? null,
      lidoEm: l.quotaRefreshedAt ? l.quotaRefreshedAt.toISOString() : null,
      precisaReligar: estado === 'precisa_religar',
    }
  })
}
