/**
 * A pergunta EXECUTIVA de RESERVA (PT-BR, determinística, sempre com 3
 * opções objetivas) para escalar uma dúvida técnica do dev assíncrono ao
 * dono, quando nem o modelo (QA) nem o RA deixaram uma tradução executiva
 * pronta (`perguntaExecutivaPtBr`/`opcoesPtBr`).
 *
 * D72 (02/09) — SUBSTITUI a versão anterior (`textoDeEscaladaParaODono`),
 * que encaminhava a MENSAGEM CRUA do dev (em inglês) ao dono, com um único
 * botão "Outro". O dono flagrou ao vivo, com print do painel/Telegram:
 * "O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch
 * esperando uma decisão sua. Pergunta original do dev: 'I have successfully
 * modified the code...'" — nas palavras dele: "não são perguntas
 * formuladas ... não são três opções ... não é pra fazer isso para dúvidas
 * técnicas, seja executivo".
 *
 * Isto acontecia em dois caminhos, por desenho (não é bug do modelo):
 *  - `destinoAposRa` (services/duvida-do-dev.ts) — chamado depois que o RA
 *    também não soube responder — NUNCA carrega `perguntaExecutiva`: a
 *    função não tem esse campo;
 *  - o próprio QA pode deixar `perguntaExecutivaPtBr`/`opcoesPtBr` vazios de
 *    propósito — o prompt (duvida-rails-mission.ts) autoriza isso
 *    explicitamente ("leave both empty rather than forcing a bad one").
 *
 * A partir de D72, o produto NUNCA mais despeja o texto técnico cru do dev
 * no dono: a reserva é sempre esta pergunta executiva fixa, com exatamente
 * 3 opções que o dono pode decidir sem ler uma linha de código.
 */

export interface OpcaoDeReserva {
  label: string
  value: string
}

/**
 * As 3 opções — nesta ordem exata (pedido do dono, D72). A 4ª opção ("Outro
 * / respondo por texto") é sempre adicionada por quem chama `ask()`
 * (`buildFreeTextOption`, telegram-bot.ts) — nunca duplicada aqui.
 */
export const OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA: OpcaoDeReserva[] = [
  { label: 'Pausar a tarefa e revisar depois', value: 'pausar' },
  { label: 'Seguir com a melhor suposição do RA mesmo assim', value: 'seguir-suposicao-ra' },
  { label: 'Pedir ao dev que abra o PR com o que tem', value: 'pedir-pr' },
]

export interface PerguntaExecutivaDeReserva {
  text: string
  options: OpcaoDeReserva[]
}

/**
 * Monta a pergunta executiva de reserva para a tarefa #`issueNumber` de
 * `repository`. NUNCA recebe (nem cita) a pergunta original do dev — é
 * texto fixo, sempre em português, sempre com as mesmas 3 opções.
 */
export function perguntaExecutivaDeReserva(args: {
  issueNumber: number
  repository: string
}): PerguntaExecutivaDeReserva {
  return {
    text:
      `O dev está travado numa dúvida técnica na tarefa #${args.issueNumber} de ` +
      `${args.repository} e nem o RA conseguiu resolver. O que fazer?`,
    options: OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA,
  }
}
