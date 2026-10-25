/**
 * Issue #141: "quero saber, olhando o celular, se preciso agir ou se pode
 * deixar quieto." O recado de publicação que falhou já trazia as três coisas
 * que a issue pede (o que quebrou, em qual passo, o que o produto já fez),
 * mas num parágrafo único — motivo, etapas e nota do conserto na mesma linha,
 * separados por ponto e vírgula. Numa tela de celular isso vira um bloco que
 * precisa ser lido inteiro para achar a resposta.
 *
 * Aqui cada pergunta ganha a sua linha, e cada etapa a sua, para que o olho
 * ache o que procura sem ler o resto. O texto sai cru para o Telegram (sem
 * `parse_mode`, ver `buildTelegramNotifier`), então quebra de linha é tudo o
 * que existe de formatação — nada de Markdown que apareceria como asterisco.
 *
 * Função pura e separada do scheduler para poder ser testada sem subir o
 * plugin inteiro.
 */
export interface FalhaDePublicacao {
  wingId: string
  shaDaMescla: string
  motivo: string
  etapas: Array<{ nome: string; resultado: string }>
  numeroDoConserto: number | null
}

/** Tamanho do commit no recado: o suficiente para achar no GitHub. */
const TAMANHO_DO_COMMIT = 7

export function recadoDeFalhaDePublicacao(falha: FalhaDePublicacao): string {
  const linhas = [
    `GitOrch: a publicação de ${falha.wingId} precisa de atenção.`,
    '',
    `O que quebrou: ${falha.motivo}`,
  ]
  // Sem etapas lidas não há passo a mostrar — um título sem nada embaixo
  // faria parecer que a lista se perdeu.
  if (falha.etapas.length > 0) {
    linhas.push('Em qual passo:')
    for (const etapa of falha.etapas) linhas.push(`• ${etapa.nome}: ${etapa.resultado}`)
  }
  // Sem conserto recém-aberto (já existia para este commit, ou não deu para
  // abrir) a linha some: dizer "nada foi feito" seria afirmar o que não se sabe.
  if (falha.numeroDoConserto !== null) {
    linhas.push(
      `O que já foi feito: o conserto virou tarefa no repositório (#${falha.numeroDoConserto}).`
    )
  }
  linhas.push(`Commit: ${falha.shaDaMescla.slice(0, TAMANHO_DO_COMMIT)}`)
  return linhas.join('\n')
}
