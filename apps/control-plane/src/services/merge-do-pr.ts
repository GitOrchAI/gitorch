// O passo que não tinha dono.
//
// Não existia UMA chamada de merge no control-plane inteiro: o QA aprovava ou
// reprovava e o PR ficava lá. Os PRs #61 e #63 foram mesclados à mão pelo dono.
// O fluxo de auto-merge existe dentro de alguns repositórios como arquivo de
// automação copiado — não no produto, e portanto não para cliente nenhum.
//
// Decisão do dono (D7): o produto mescla sozinho desde o primeiro ciclo, sem
// confirmação humana. São TRÊS porteiros, todos determinísticos: a verificação
// diz se o código roda, o QA diz se resolve o que a tarefa pediu, e o diff
// completo garante que o julgamento foi sobre a mudança inteira.

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
  /** Faz o merge de verdade. Deve lançar em falha do GitHub. */
  merge: () => Promise<boolean>
}): Promise<ResultadoDoMerge> {
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
