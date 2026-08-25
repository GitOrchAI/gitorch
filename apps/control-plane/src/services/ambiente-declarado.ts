/**
 * Qual ambiente de publicação o PROJETO declarou como sendo o dele.
 *
 * Existe porque descobrir sozinho não funcionou. O produto listava os
 * ambientes do repositório, filtrava os que parecem efêmeros e usava o resto —
 * e num repositório real isso trouxe um ambiente chamado `copilot`, criado por
 * outra ferramenta, que o aplicativo do GitOrch não tem permissão para ler.
 * Resultado medido em 24h no `loureng/patinhas-3d-crafts`: 992 leituras
 * recusadas com 403, a publicação nunca confirmando, e SEIS entregas já
 * mescladas presas sem nunca fechar a tarefa.
 *
 * A saída fácil seria ignorar o ambiente que não dá para ler. O dono recusou,
 * e com razão: se o ambiente ilegível FOSSE a produção de verdade, o produto
 * passaria a dizer "está no ar" sem ter visto nada. Declarar é mais trabalhoso
 * e é honesto.
 */

/** Onde a declaração vive, ao lado de `ambientes.caminhos` e `ambientes.endereco`. */
export interface ConfiguracaoComAmbiente {
  ambientes?: {
    /**
     * O nome exato do ambiente de publicação deste projeto, como aparece no
     * GitHub. Aceita uma lista para o caso de o projeto publicar em mais de um
     * lugar de verdade.
     */
    producao?: unknown
  }
}

/**
 * Os ambientes que o projeto declarou, na ordem em que foram declarados.
 *
 * Devolve lista vazia quando não há declaração — e vazio significa "o projeto
 * não disse", nunca "não tem ambiente". Quem chama decide o que fazer com
 * isso; aqui não se inventa nome nenhum.
 */
export function ambientesDeclaradosPeloProjeto(runtimeConfig: unknown): string[] {
  const bruto = (runtimeConfig as ConfiguracaoComAmbiente | null)?.ambientes?.producao
  if (typeof bruto === 'string') {
    const limpo = bruto.trim()
    return limpo === '' ? [] : [limpo]
  }
  if (!Array.isArray(bruto)) return []

  const nomes: string[] = []
  for (const item of bruto) {
    if (typeof item !== 'string') continue
    const limpo = item.trim()
    // Nome repetido viraria leitura repetida da mesma coisa a cada varredura.
    if (limpo !== '' && !nomes.includes(limpo)) nomes.push(limpo)
  }
  return nomes
}

/**
 * O projeto declarou onde publica?
 *
 * Separado da leitura porque a diferença importa: uma lista vazia por falta de
 * declaração é um caso a tratar (avisar o dono, ou cair na descoberta), e não
 * um erro.
 */
export function projetoDeclarouOndePublica(runtimeConfig: unknown): boolean {
  return ambientesDeclaradosPeloProjeto(runtimeConfig).length > 0
}

/** O mínimo de uma linha de sessão para saber se a entrega dela já foi mesclada. */
export interface LinhaComMescla {
  issueNumber: number
  mergeCommitSha?: string | null | undefined
}

/**
 * As tarefas cuja entrega JÁ FOI MESCLADA.
 *
 * Rede de segurança, e ela existe porque o caminho principal falhou de um jeito
 * que ninguém previu: a tarefa só fecha quando a publicação confirma, a leitura
 * da publicação quebrou, e o SM passou a redelegar trabalho que já estava
 * pronto — a issue #110 chegou a ter DOIS pull requests mesclados.
 *
 * Consertar a publicação resolve o caso de hoje. Isto resolve o de amanhã: na
 * próxima vez que a confirmação emperrar por qualquer outro motivo, o produto
 * não volta a pagar pelo mesmo trabalho.
 *
 * Não substitui o fechamento da tarefa: a issue continua tendo que fechar, e o
 * quadro do cliente continua tendo que ficar limpo. Isto só impede o gasto.
 */
export function tarefasComEntregaMesclada(linhas: LinhaComMescla[]): Set<number> {
  const entregues = new Set<number>()
  for (const linha of linhas) {
    // String vazia é "não mesclado" tanto quanto nulo — o campo só ganha
    // conteúdo quando o merge de fato aconteceu.
    if (typeof linha.mergeCommitSha === 'string' && linha.mergeCommitSha.trim() !== '') {
      entregues.add(linha.issueNumber)
    }
  }
  return entregues
}
