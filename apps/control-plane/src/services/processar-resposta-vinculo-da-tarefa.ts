// A resposta do dono à pergunta "a qual tarefa este pull request pertence?"
// (perguntar-vinculo-da-tarefa.ts). Sem este tratador a resposta ficava
// guardada e nada acontecia: o pull request seguia sem tarefa.
//
//  - clicou numa tarefa candidata (`vinculo-issue-N`): o vínculo é gravado
//    como confirmação do dono. Só vale o número que estava entre as opções
//    DA PERGUNTA, nunca um valor qualquer que chegue como resposta;
//  - "nenhuma destas": não muda nada, e a pergunta não volta (ela foi
//    respondida);
//  - texto livre: precisa trazer exatamente um "#N" e N precisa ser uma
//    tarefa aberta no GitHub. Qualquer outra coisa não grava nada e deixa o
//    rastro no painel e no log: nada de adivinhar o que o dono quis dizer.

import { parseDedupKeyDeVinculoDaTarefa } from './perguntar-vinculo-da-tarefa.js'

const PREFIXO_DA_OPCAO = 'vinculo-issue-'
export const RESPOSTA_NENHUMA_DESTAS = 'nenhuma-destas'

export interface DepsDaRespostaDoVinculo {
  /** Grava `issue_number = N` e `vinculo_origem = 'dono'` na ficha do pull request. */
  gravarVinculo: (a: { numeroDoPr: number; issueNumber: number }) => Promise<void>
  /** A tarefa N está aberta no GitHub? `null` = não deu para conferir. */
  issueAberta: (numero: number) => Promise<boolean | null>
  registrarNoPainel: (a: { chave: string; texto: string }) => Promise<void>
  onWarn: (mensagem: string) => void
}

function numeroDaOpcao(valor: string): number | null {
  if (!valor.startsWith(PREFIXO_DA_OPCAO)) return null
  const resto = valor.slice(PREFIXO_DA_OPCAO.length)
  if (!/^\d+$/.test(resto)) return null
  const numero = Number(resto)
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null
}

/** O único "#N" do texto, ou `null` quando não há nenhum ou há mais de um diferente. */
function numeroUnicoDoTexto(texto: string): number | null {
  const numeros = new Set<number>()
  for (const achado of texto.matchAll(/#(\d{1,9})\b/g)) numeros.add(Number(achado[1]))
  if (numeros.size !== 1) return null
  const [unico] = [...numeros]
  return unico !== undefined && unico > 0 ? unico : null
}

export async function processarRespostaDoVinculoDaTarefa(
  args: { dedupKey: string; resposta: string; opcoes: Array<{ label: string; value: string }> },
  deps: DepsDaRespostaDoVinculo
): Promise<void> {
  const chave = parseDedupKeyDeVinculoDaTarefa(args.dedupKey)
  if (!chave) return
  const { repository, numeroDoPr } = chave
  const resposta = args.resposta.trim()

  if (resposta === RESPOSTA_NENHUMA_DESTAS) return

  // Clique numa candidata: só vale se a opção estava na pergunta.
  const daOpcao = numeroDaOpcao(resposta)
  if (daOpcao !== null && args.opcoes.some((o) => o.value === resposta)) {
    await deps.gravarVinculo({ numeroDoPr, issueNumber: daOpcao })
    return
  }

  const registrarSemEfeito = async (codigo: string, motivo: string): Promise<void> => {
    deps.onWarn(
      `vinculo-da-tarefa: resposta do dono sobre o pull request #${numeroDoPr} de ${repository} não aplicada (${motivo})`
    )
    await deps.registrarNoPainel({
      chave: `vinculo-resposta:${repository}:${numeroDoPr}:${codigo}`,
      texto:
        `GitOrch: recebi sua resposta sobre a tarefa do pull request #${numeroDoPr}, mas não ` +
        `consegui usá-la (${motivo}). O pull request continua sem tarefa ligada.`,
    })
  }

  const numero = daOpcao === null ? numeroUnicoDoTexto(resposta) : null
  if (numero === null) {
    await (daOpcao === null
      ? registrarSemEfeito(
          'sem-numero',
          'não achei um número de tarefa, no formato #N, na resposta'
        )
      : registrarSemEfeito('opcao-fora', 'essa opção não estava na pergunta'))
    return
  }

  const aberta = await deps.issueAberta(numero)
  if (aberta === null) {
    await registrarSemEfeito(
      `nao-conferiu-${numero}`,
      `não consegui conferir no GitHub se a tarefa #${numero} está aberta`
    )
    return
  }
  if (!aberta) {
    await registrarSemEfeito(`nao-aberta-${numero}`, `a tarefa #${numero} não está aberta`)
    return
  }
  await deps.gravarVinculo({ numeroDoPr, issueNumber: numero })
}
