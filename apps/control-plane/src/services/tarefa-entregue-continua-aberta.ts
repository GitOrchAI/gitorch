/**
 * A tarefa fecha quando a entrega dela entra — não importa QUEM mesclou.
 *
 * DIAGNÓSTICO DO DONO, 27/08, e ele foi mais preciso que eu: "falta é o
 * gitorch saber todas issues do projeto e o que cada issue É e qual é linkado
 * a qual PR, pois já vi PRs merged com issue open".
 *
 * MEDIDO NO BANCO depois disso: dezesseis tarefas do gitorch e nove do
 * patinhas estavam ABERTAS com a entrega delas já mesclada — e o produto
 * SABIA, porque a linha da entrega tinha o commit do merge gravado. Algumas
 * foram redelegadas várias vezes por isso: a tarefa #128 chegou a ter CINCO
 * entregas, a #110 e a #210 três cada.
 *
 * POR QUE ACONTECIA: `fecharTarefaEntregue` só roda dentro da missão de QA,
 * logo depois de o produto mesclar com as próprias mãos. Quando o merge vinha
 * por outro caminho — o auto-merge do repositório, ou uma pessoa clicando —
 * ninguém fechava a tarefa. E tarefa aberta volta para a fila do gerente, que
 * a delega de novo, e a entrega nova nasce em conflito com a que já entrou.
 *
 * O conserto não é uma regra nova de fechamento: é a MESMA regra
 * (`decidirFechamento`, fechar-tarefa.ts) aplicada também fora do caminho em
 * que o produto foi o autor do merge. Este arquivo só decide QUEM merece ser
 * conferido, para a varredura não perguntar o estado de tarefa nenhuma à toa.
 */

export interface EntregaParaConferir {
  issueNumber: number
  pullRequestNumber: number | null
  mergeCommitSha: string | null
  /** Última escrita na linha da entrega — de onde sai a carência abaixo. */
  updatedAt: Date
}

/**
 * Quanto tempo a varredura espera antes de encostar numa entrega.
 *
 * O caminho normal (a missão de QA que acabou de mesclar) fecha a tarefa em
 * segundos. Se a varredura agisse junto, as DUAS comentariam e fechariam a
 * mesma tarefa — dois comentários idênticos no repositório do cliente, que é
 * exatamente o ruído que este produto evita em todo lugar. Um teste de costura
 * real pegou isso antes de ir para produção.
 *
 * Meia hora: muito além do que o caminho normal precisa, e muito aquém de
 * deixar a tarefa aberta tempo suficiente para o gerente redelegá-la.
 */
export const CARENCIA_ANTES_DE_VARRER_MS = 30 * 60_000

/**
 * As entregas que valem uma consulta ao GitHub.
 *
 * Sem commit de merge não há o que fechar. Sem número de tarefa não há o que
 * fechar. Recém-mesclada também não entra: aquela ainda é do caminho normal. E a mesma tarefa aparece uma vez só, por mais entregas que ela tenha
 * acumulado — foi justamente a redelegação repetida que encheu o quadro, e
 * perguntar cinco vezes pelo estado da mesma tarefa seria repetir o desperdício
 * em outra moeda.
 */
export function entregasQueMerecemConferencia<T extends EntregaParaConferir>(
  linhas: readonly T[],
  agora: Date = new Date()
): T[] {
  const vistas = new Set<number>()
  const escolhidas: T[] = []
  for (const linha of linhas) {
    if (!linha.mergeCommitSha) continue
    if (!Number.isInteger(linha.issueNumber) || linha.issueNumber <= 0) continue
    // Recém-mesclada é do caminho normal, não desta varredura.
    if (agora.getTime() - linha.updatedAt.getTime() < CARENCIA_ANTES_DE_VARRER_MS) continue
    if (vistas.has(linha.issueNumber)) continue
    vistas.add(linha.issueNumber)
    escolhidas.push(linha)
  }
  return escolhidas
}

/**
 * O texto do fechamento quando o merge NÃO foi feito pelo produto.
 *
 * Diferente do texto de `fecharTarefaEntregue` de propósito: lá o produto diz
 * "eu mesclei"; aqui ele não mesclou, e afirmar que mesclou seria uma mentira
 * pequena numa mensagem que fica no repositório do cliente para sempre.
 *
 * Sem número de PR o texto continua verdadeiro em vez de citar "#null": a
 * linha existe (a entrega foi mesclada, o commit está gravado), só o número do
 * pedido não foi registrado naquela passagem.
 */
export function recadoDeTarefaJaEntregue(args: {
  pullRequestNumber: number | null
  mergeCommitSha: string
}): string {
  const origem = args.pullRequestNumber
    ? `A entrega que resolve esta tarefa (PR #${args.pullRequestNumber}) foi mesclada`
    : 'A entrega que resolve esta tarefa foi mesclada'
  return [
    `Encerrada pelo GitOrch: ${origem} — commit ${args.mergeCommitSha.slice(0, 8)}.`,
    '',
    'O merge não passou pelas mãos do produto (auto-merge do repositório ou',
    'alguém clicando), e por isso a tarefa tinha ficado aberta mesmo com o',
    'trabalho entregue. Enquanto ficava aberta, ela voltava para a fila e era',
    'delegada de novo — o que produzia entregas em conflito com a que já tinha',
    'entrado.',
    '',
    'Se o problema descrito aqui ainda acontecer, reabra: entrega mesclada não',
    'é o mesmo que problema resolvido, e quem sabe isso é você.',
  ].join('\n')
}
