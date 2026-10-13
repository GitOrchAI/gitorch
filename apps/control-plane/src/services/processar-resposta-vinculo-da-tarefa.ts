// A resposta do dono à pergunta "a qual tarefa este pull request pertence?"
// (perguntar-vinculo-da-tarefa.ts). Sem este tratador a resposta ficava
// guardada e nada acontecia: o pull request seguia sem tarefa.
//
//  - clicou numa tarefa candidata (`vinculo-issue-N`): o vínculo é gravado
//    como confirmação do dono. Só vale o número que estava entre as opções
//    DA PERGUNTA, nunca um valor qualquer que chegue como resposta;
//  - "nenhuma destas": não muda nada, e a pergunta não volta (ela foi
//    respondida);
//  - texto livre: entendido por `interpretarRespostaDeVinculo` ("3976", "é a
//    3976", "tarefa 3976", o link da tarefa, "nenhuma", "é avulso"), sem exigir
//    formato. O número precisa ser uma tarefa aberta no GitHub. Resposta que
//    não deu para usar NÃO fecha a pergunta: o dono recebe, no mesmo canal em
//    que respondeu, o que faltou e um exemplo, e a pergunta segue aberta.
//    Nada de adivinhar o que o dono quis dizer.

import type { ResultadoDoManipuladorDeResposta } from './agent-question.js'
import { interpretarRespostaDeVinculo } from './interpretar-resposta-de-vinculo.js'
import { parseDedupKeyDeVinculoDaTarefa } from './perguntar-vinculo-da-tarefa.js'

const PREFIXO_DA_OPCAO = 'vinculo-issue-'
export const RESPOSTA_NENHUMA_DESTAS = 'nenhuma-destas'

/** Quantas vezes o exemplo de resposta é mandado para a mesma pergunta. */
export const MAX_EXEMPLOS_POR_PERGUNTA = 2

export interface DepsDaRespostaDoVinculo {
  /** Grava `issue_number = N` e `vinculo_origem = 'dono'` na ficha do pull request. */
  gravarVinculo: (a: { numeroDoPr: number; issueNumber: number }) => Promise<void>
  /** A tarefa N está aberta no GitHub? `null` = não deu para conferir. */
  issueAberta: (numero: number) => Promise<boolean | null>
  /** Anota no painel uma vez por `chave`; `true` quando era novo, `false` quando já existia. */
  registrarNoPainel: (a: { chave: string; texto: string }) => Promise<boolean>
  onWarn: (mensagem: string) => void
}

function numeroDaOpcao(valor: string): number | null {
  if (!valor.startsWith(PREFIXO_DA_OPCAO)) return null
  const resto = valor.slice(PREFIXO_DA_OPCAO.length)
  if (!/^\d+$/.test(resto)) return null
  const numero = Number(resto)
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null
}

/** A pergunta continua aberta e o dono recebe `mensagem` no canal em que respondeu. */
function seguePerguntando(mensagem: string): ResultadoDoManipuladorDeResposta {
  return { naoEntendida: mensagem }
}

export async function processarRespostaDoVinculoDaTarefa(
  args: { dedupKey: string; resposta: string; opcoes: Array<{ label: string; value: string }> },
  deps: DepsDaRespostaDoVinculo
): Promise<ResultadoDoManipuladorDeResposta | void> {
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

  if (daOpcao !== null) {
    await registrarSemEfeito('opcao-fora', 'essa opção não estava na pergunta')
    return
  }

  const entendida = interpretarRespostaDeVinculo(resposta, repository)

  if (entendida.tipo === 'nenhuma') {
    await deps.registrarNoPainel({
      chave: `vinculo-resposta:${repository}:${numeroDoPr}:nenhuma`,
      texto:
        `GitOrch: anotei, como você disse, que o pull request #${numeroDoPr} não pertence a ` +
        'nenhuma tarefa. Ele segue sem tarefa ligada.',
    })
    return
  }

  if (entendida.tipo === 'outro-repositorio') {
    await registrarSemEfeito(
      `outro-repositorio`,
      `o link é de uma tarefa de ${entendida.repositorio}, outro projeto`
    )
    return seguePerguntando(
      `Esse link é de uma tarefa de outro projeto (${entendida.repositorio}), e este pedido é de ` +
        `${repository}. Responda com o número ou o link de uma tarefa de ${repository}, ou diga "nenhuma".`
    )
  }

  if (entendida.tipo === 'varias') {
    const citadas = entendida.numeros.map((n) => `#${n}`).join(', ')
    await registrarSemEfeito(`varias`, `a resposta cita mais de uma tarefa (${citadas})`)
    return seguePerguntando(
      `Você citou mais de uma tarefa (${citadas}), mas este pedido pertence a uma só. ` +
        'Responda só com o número da que vale.'
    )
  }

  if (entendida.tipo === 'nao-entendida') {
    // Conta quantas vezes esta pergunta já recebeu o exemplo: cada tentativa ocupa a
    // próxima chave livre (o registro no painel é uma vez por chave).
    let tentativa = 1
    while (tentativa <= MAX_EXEMPLOS_POR_PERGUNTA + 1) {
      const nova = await deps.registrarNoPainel({
        chave: `vinculo-resposta:${repository}:${numeroDoPr}:nao-entendida-${tentativa}`,
        texto:
          `GitOrch: recebi sua resposta sobre a tarefa do pull request #${numeroDoPr}, mas não ` +
          'consegui ligá-la a uma tarefa. A pergunta continua aberta.',
      })
      if (nova) break
      tentativa += 1
    }
    deps.onWarn(
      `vinculo-da-tarefa: resposta do dono sobre o pull request #${numeroDoPr} de ${repository} não entendida (tentativa ${tentativa})`
    )
    if (tentativa > MAX_EXEMPLOS_POR_PERGUNTA) return seguePerguntando('')
    return seguePerguntando(
      'Não consegui ligar sua resposta a uma tarefa. Para este pedido, responda só com o número ' +
        'da tarefa, por exemplo 3976, ou diga "nenhuma" se ele não pertence a nenhuma tarefa. ' +
        'A pergunta continua aberta.'
    )
  }

  const numero = entendida.numero
  const aberta = await deps.issueAberta(numero)
  if (aberta === null) {
    await registrarSemEfeito(
      `nao-conferiu-${numero}`,
      `não consegui conferir no GitHub se a tarefa #${numero} está aberta`
    )
    return seguePerguntando(
      `Não consegui conferir agora se a tarefa #${numero} existe. A pergunta continua aberta: ` +
        'responda de novo em alguns minutos.'
    )
  }
  if (!aberta) {
    await registrarSemEfeito(`nao-aberta-${numero}`, `a tarefa #${numero} não está aberta`)
    return seguePerguntando(
      `A tarefa #${numero} não está aberta em ${repository} (já foi fechada ou não existe). ` +
        'Responda com o número de outra tarefa, ou diga "nenhuma".'
    )
  }
  await deps.gravarVinculo({ numeroDoPr, issueNumber: numero })
}
