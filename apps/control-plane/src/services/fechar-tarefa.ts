// O produto fecha o que ele mesmo entregou.
//
// Provado ao vivo: uma entrega foi mesclada e a tarefa FICOU ABERTA, porque o
// texto da entrega não trazia a palavra ("closes", "fixes"...) que faz o
// GitHub fechar sozinho. O dev assíncrono é EXTERNO — o produto não controla
// o que ele escreve na PR — e no método deste produto quem administra tarefa
// é o gerente, não o dev. Por isso o produto fecha por conta própria, em vez
// de depender do texto de outro ator para isso acontecer.
//
// Dois limites duros, mesmo espírito de `mesclarPr` (merge-do-pr.ts):
// - PR de um humano nunca é seguido do produto fechando a tarefa dessa
//   pessoa — o produto julga toda entrega, mas só administra (mescla, fecha)
//   o que ele mesmo encomendou.
// - Se o GitHub já fechou a tarefa sozinho (o texto tinha a palavra-gatilho),
//   o produto não faz nada: fechar de novo, ou anunciar um fechamento que não
//   aconteceu, é ruído e uma mentira pequena.

export interface DecidirFechamentoArgs {
  /** A mescla aconteceu de fato nesta passagem — não uma suposição. */
  mesclado: boolean
  /** Estado ATUAL da tarefa no GitHub, lido fresco (nunca herdado de uma
   *  leitura anterior: a issue pode ter fechado sozinha entre o julgamento e
   *  o merge). */
  tarefaAberta: boolean
  /** Só entrega do dev assíncrono é administrada pelo produto. */
  delegado: boolean
}

export interface DecisaoDeFechamento {
  fechar: boolean
  motivo: string
}

/** Decisão pura: fecha só quando a entrega é do dev delegado, foi mesclada de
 *  verdade, e a tarefa continua genuinamente aberta. */
export function decidirFechamento(args: DecidirFechamentoArgs): DecisaoDeFechamento {
  // O porteiro mais perigoso de pular vem primeiro — mesmo espírito de
  // `mesclarPr`: o produto julga toda entrega, mas só administra a que ele
  // mesmo encomendou.
  if (!args.delegado) {
    return {
      fechar: false,
      motivo: 'entrega de humano — o produto não administra tarefa de gente',
    }
  }
  if (!args.mesclado) {
    return { fechar: false, motivo: 'ainda não foi mesclado' }
  }
  if (!args.tarefaAberta) {
    return { fechar: false, motivo: 'o GitHub já fechou a tarefa sozinho' }
  }
  return { fechar: true, motivo: 'entrega mesclada e a tarefa continua aberta' }
}

export interface FecharTarefaEntregueDeps {
  /** Número do PR que resolveu a tarefa — entra no comentário, para o
   *  fechamento ficar auditável (qual entrega motivou). */
  numeroDoPr: number
  mesclado: boolean
  delegado: boolean
  /** Lê o estado ATUAL da tarefa — nunca herdado de uma leitura anterior. */
  lerEstadoDaTarefa: () => Promise<'open' | 'closed'>
  /** Comentário público, legível por gente, dizendo qual entrega resolveu. */
  comentar: (texto: string) => Promise<void>
  /** Fecha a tarefa de fato. */
  fechar: () => Promise<void>
}

/**
 * Fecha a tarefa que a entrega mesclada resolveu — só quando `decidirFechamento`
 * autoriza.
 *
 * NUNCA engole a falha de `comentar`/`fechar`: fechar a issue do cliente é uma
 * escrita real na infraestrutura dele, e uma exceção aqui sobe para quem
 * chamou. Silenciá-la faria o board mentir do mesmo jeito que a lacuna
 * original (mesclado, tarefa aberta) — só que agora por um erro nosso, não
 * pelo texto do dev externo. Quem chama decide como a falha fica visível
 * (log estruturado, nota na memória da missão); este módulo só entrega a
 * exceção, nunca a esconde.
 */
export async function fecharTarefaEntregue(deps: FecharTarefaEntregueDeps): Promise<void> {
  // Poupa a leitura de rede quando a decisão já está resolvida sem ela —
  // `decidirFechamento` rejeitaria de qualquer jeito (mesma lógica, só sem
  // gastar a chamada de "ler o estado da tarefa" à toa).
  if (!deps.delegado || !deps.mesclado) return

  const tarefaAberta = (await deps.lerEstadoDaTarefa()) === 'open'
  const decisao = decidirFechamento({
    mesclado: deps.mesclado,
    tarefaAberta,
    delegado: deps.delegado,
  })
  if (!decisao.fechar) return

  await deps.comentar(
    `O GitOrch mesclou a entrega que resolve esta tarefa — PR #${deps.numeroDoPr}. Fechando por aqui.`
  )
  await deps.fechar()
}
