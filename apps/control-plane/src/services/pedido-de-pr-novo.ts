// A instrução que toda retomada de pull request leva para o dev.
//
// Medido em produção (14 dias até 29/09/2026): 62 sessões de retomada
// mandavam o resultado de volta para o ramo do PR antigo e nenhuma virou
// entrega — a sessão fazia o conserto e não publicava nada. A retomada agora
// PARTE do ramo antigo (para não perder o trabalho) e publica um pull request
// NOVO contra a `main`; o PR antigo é fechado como substituído quando o novo
// aparece (pr-substituido.ts).

/** Diz ao dev, com todas as letras, de onde partir e onde publicar. */
export function instrucaoDePrNovoAPartirDoRamo(args: {
  numeroDoPr: number
  ramoDoPr: string
}): string {
  return [
    `Parta do ramo \`${args.ramoDoPr}\`, onde está o trabalho do pull request #${args.numeroDoPr}.`,
    'Traga a `main` atual para dentro dele (resolvendo o conflito, se houver), aplique o que é',
    'pedido acima e publique o resultado como pull request NOVO contra a `main`.',
    'Não empurre commits para o ramo antigo: o pull request antigo será fechado quando o novo aparecer.',
  ].join('\n')
}
