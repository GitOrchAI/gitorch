// A instrução que toda retomada de pull request leva para o dev.
//
// Medido em produção: 62 sessões de retomada (14 dias até 29/09/2026) mandavam
// o resultado de volta para o ramo do PR antigo e nenhuma virou entrega. Depois
// a retomada passou a PARTIR do ramo antigo — e medido em 30/09 o Jules abre o
// PR novo com BASE no ponto de partida da sessão, então o PR nascia mirando o
// ramo antigo e nunca chegava na `main`. Agora a sessão parte da `main` e o
// trabalho antigo viaja SÓ por este texto: o dev busca o ramo, traz o que é da
// tarefa e publica contra a `main`. O PR antigo é fechado como substituído
// quando o novo aparece (pr-substituido.ts).

/** Diz ao dev, com todas as letras, onde está o trabalho antigo e onde publicar. */
export function instrucaoDePrNovoAPartirDoRamo(args: {
  numeroDoPr: number
  ramoDoPr: string
}): string {
  return [
    `O trabalho anterior desta tarefa está no ramo \`${args.ramoDoPr}\` (git fetch origin ${args.ramoDoPr}), pull request #${args.numeroDoPr}.`,
    'Crie seu ramo a partir da main, traga desse ramo APENAS o que pertence à tarefa',
    '(checkout/cherry-pick de arquivos), aplique o pedido acima, e publique o resultado como',
    'pull request contra a `main`. Não inclua arquivos fora do escopo da tarefa.',
  ].join('\n')
}
