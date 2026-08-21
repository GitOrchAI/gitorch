// O passo que não tinha dono.
//
// Não existia UMA chamada de merge no control-plane inteiro: o QA aprovava ou
// reprovava e o PR ficava lá. Os PRs #61 e #63 foram mesclados à mão pelo dono.
// O fluxo de auto-merge existe dentro de alguns repositórios como arquivo de
// automação copiado — não no produto, e portanto não para cliente nenhum.
//
// Decisão do dono (D7): o produto mescla sozinho desde o primeiro ciclo, sem
// confirmação humana. São CINCO porteiros, todos determinísticos.
//
// Task 9 acrescentou os dois primeiros — cada um nasceu de dano real ou
// quase-dano:
// 1. `delegado`: sem esta trava AQUI, na porta do merge, uma entrega HUMANA
//    reconhecida por engano como trabalho do dev assíncrono seria mesclada
//    sozinha — quase aconteceu quando um PR humano citou o número de uma
//    issue no corpo e o juiz confundiu a citação com entrega (PR #99). O
//    reconhecimento já foi endurecido noutro lugar (`225091a`), mas ele pode
//    falhar de novo por outro caminho — o recuo por login do autor não exige
//    sessão nenhuma —, então a trava tem de existir também aqui: defesa em
//    profundidade, não confiança cega em quem chamou.
// 2. `shaRevisado === shaAtual`: o juiz aprovou um COMMIT específico. Se o
//    dev empurrou algo novo entre a aprovação e o merge, o código que entraria
//    não é o que foi lido — aprovação não se transfere para código que
//    ninguém viu.
//
// Os outros três (já existiam): a verificação diz se o código roda, o QA diz
// se resolve o que a tarefa pediu, e o diff completo garante que o julgamento
// foi sobre a mudança inteira.

export interface ResultadoDoMerge {
  mesclado: boolean
  motivo: string
}

export async function mesclarPr(deps: {
  numeroDoPr: number
  /** 'green' | 'red' | 'pending' | 'no checks' | 'unknown' */
  ciState: string
  vereditoDoQa: string
  diffTruncado: boolean
  /** Task 9: true só quando a entrega foi reconhecida como trabalho do dev assíncrono. */
  delegado: boolean
  /** Commit que o juiz de fato leu ao montar a diferença julgada. */
  shaRevisado: string
  /** Commit da entrega agora, no instante do merge — lido fresco, nunca herdado. */
  shaAtual: string
  /** Faz o merge de verdade. Deve lançar em falha do GitHub. */
  merge: () => Promise<boolean>
}): Promise<ResultadoDoMerge> {
  // Porteiro mais barato (um booleano já pronto, nenhuma comparação) e o mais
  // perigoso de pular: mesclar código de humano sem autorização nenhuma dele.
  if (!deps.delegado) {
    return { mesclado: false, motivo: 'esta entrega não foi encomendada pelo produto' }
  }
  // Segundo porteiro: garante que o commit que vai entrar é o MESMO que o
  // juiz leu — não um push posterior que ninguém verificou.
  if (deps.shaRevisado !== deps.shaAtual) {
    return {
      mesclado: false,
      motivo: `o código mudou depois da aprovação do QA (revisado ${deps.shaRevisado}, atual ${deps.shaAtual})`,
    }
  }
  if (deps.vereditoDoQa !== 'approve') {
    return { mesclado: false, motivo: `o QA não aprovou (${deps.vereditoDoQa})` }
  }
  if (deps.ciState !== 'green') {
    // 'no checks' entra aqui de propósito: ausência de teste não é aprovação.
    return { mesclado: false, motivo: `a verificação automática não está verde (${deps.ciState})` }
  }
  if (deps.diffTruncado) {
    return { mesclado: false, motivo: 'o diff não coube por inteiro no julgamento' }
  }

  try {
    const ok = await deps.merge()
    return ok
      ? { mesclado: true, motivo: 'verificação verde e QA aprovou' }
      : { mesclado: false, motivo: 'o GitHub recusou o merge' }
  } catch (err) {
    return { mesclado: false, motivo: `falha ao mesclar: ${(err as Error).message}` }
  }
}
