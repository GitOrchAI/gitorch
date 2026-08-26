/**
 * O vigia que mantém os motores vivos — "conectar uma vez e nunca mais".
 *
 * PROMESSA DO DONO (20/08): o cliente conecta o motor UMA vez no assistente de
 * configuração, e a renovação automática o mantém vivo sozinha. Só revogação
 * REAL gera pedido de reconexão. Se a renovação parar, isso é DEFEITO NOSSO a
 * consertar — nunca caso de pedir religamento ao cliente.
 *
 * CAUSA RAIZ, provada ao vivo em 20/08: rodar o CLI do motor no HOME do usuário
 * fez o token pular de 20/07 para 20/08 — o refresh token AINDA VALIA e o CLI
 * renova sozinho quando é chamado. O que faltava era chamá-lo. O motor que roda
 * missão se renova de tabela; o que fica dias parado vence sozinho, e foi assim
 * que o codex morreu em 29/07 sem ninguém notar, e a esteira ficou parada de 17
 * a 20/08.
 *
 * O GitHub já tem esse vigia rodando e provado. Este é o mesmo desenho,
 * apontado para os motores.
 */

/** Quanto antes do vencimento o motor é renovado. */
export const ANTECEDENCIA_DA_RENOVACAO_MS = 24 * 60 * 60_000

/**
 * Há quanto tempo sem uso um motor é renovado por precaução.
 *
 * Existe porque `expiresAt` é NULO para os motores hoje — foi justamente por
 * isso que a checagem de vencimento nunca barrou nada e o codex morreu em
 * silêncio. Sem data de vencimento, o único sinal que resta é o tempo parado:
 * um motor que não roda há dias é o candidato exato a ter vencido.
 */
export const OCIOSIDADE_QUE_PEDE_RENOVACAO_MS = 3 * 24 * 60 * 60_000

export interface ConexaoDeMotor {
  userId: string
  runtime: string
  status: string
  /** Vencimento conhecido do token, quando o provedor informa. */
  expiresAt: Date | null
  /** Última vez que esta linha foi tocada — o proxy de "quando rodou". */
  updatedAt: Date | null
}

export type AcaoDeRenovacao = { tipo: 'renovar'; motivo: string } | { tipo: 'nada'; motivo: string }

/**
 * O que fazer com uma conexão de motor. Pura: mesma entrada, mesma saída, sem
 * banco, sem rede, sem relógio próprio.
 */
export function decidirRenovacaoDoMotor(
  conexao: Pick<ConexaoDeMotor, 'status' | 'expiresAt' | 'updatedAt'>,
  agora: Date
): AcaoDeRenovacao {
  // Conexão que não está de pé não se renova sozinha: ou o cliente nunca
  // conectou, ou ela já foi marcada como precisando de reconexão. Insistir aqui
  // seria mexer no que o dono já sabe que está quebrado.
  if (conexao.status !== 'connected') {
    return { tipo: 'nada', motivo: `conexão em "${conexao.status}", não em "connected"` }
  }

  if (conexao.expiresAt) {
    const falta = conexao.expiresAt.getTime() - agora.getTime()
    if (falta <= ANTECEDENCIA_DA_RENOVACAO_MS) {
      return {
        tipo: 'renovar',
        motivo:
          falta <= 0
            ? 'o token já venceu'
            : `o token vence em menos de ${Math.round(ANTECEDENCIA_DA_RENOVACAO_MS / 3_600_000)}h`,
      }
    }
    return { tipo: 'nada', motivo: 'o token ainda tem prazo de sobra' }
  }

  // Sem data de vencimento — o caso REAL dos motores hoje. Ocioso demais é o
  // único sinal que resta, e é justamente o perfil do motor que morre calado.
  if (!conexao.updatedAt) {
    return { tipo: 'renovar', motivo: 'nunca foi usada desde que foi conectada' }
  }
  const parado = agora.getTime() - conexao.updatedAt.getTime()
  if (parado >= OCIOSIDADE_QUE_PEDE_RENOVACAO_MS) {
    return {
      tipo: 'renovar',
      motivo: `sem uso há ${Math.floor(parado / 86_400_000)} dias, e o provedor não informa vencimento`,
    }
  }
  return { tipo: 'nada', motivo: 'usada recentemente — o próprio uso renova' }
}

/**
 * A ordem em que os motores são renovados.
 *
 * ARMADILHA REAL (achada na pesquisa do Omniroute): em alguns provedores o
 * refresh token é ROTATIVO — renovar a conta de um cliente invalida a chave que
 * outra conta do MESMO provedor ainda ia usar. Renovar duas contas do mesmo
 * provedor em paralelo é perder uma delas.
 *
 * Por isso a fila é agrupada POR PROVEDOR: quem chama processa um grupo por
 * vez, em série, guardando o token novo antes de tocar na próxima conta. Contas
 * de provedores DIFERENTES não têm esse risco e podem correr juntas.
 */
export function agruparPorProvedor<T extends { runtime: string }>(conexoes: readonly T[]): T[][] {
  const porRuntime = new Map<string, T[]>()
  for (const c of conexoes) {
    const grupo = porRuntime.get(c.runtime)
    if (grupo) grupo.push(c)
    else porRuntime.set(c.runtime, [c])
  }
  return [...porRuntime.values()]
}

/**
 * A falha de renovação foi definitiva?
 *
 * A distinção decide se o dono é incomodado. "Não consegui agora" (rede fora,
 * provedor instável) é transitório: tenta de novo na hora seguinte, calado.
 * "Foi revogado" é definitivo, e aí sim o cliente precisa reconectar — é a
 * única exceção à promessa de conectar uma vez e nunca mais.
 *
 * Na dúvida, TRANSITÓRIO: marcar como revogado é destrutivo (a conexão para de
 * ser usada), e uma falha de rede não pode custar isso ao cliente.
 */
export function ehRevogacaoDefinitiva(saida: string): boolean {
  return /\b(invalid_grant|revoked|unauthorized_client|account (disabled|suspended))\b/i.test(saida)
}
