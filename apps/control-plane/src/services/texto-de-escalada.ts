/**
 * O texto de RESERVA (PT-BR, determinístico) para escalar uma dúvida do dev
 * assíncrono ao dono, quando o modelo não deixou uma tradução executiva
 * pronta (`perguntaExecutivaPtBr`).
 *
 * Isto acontece em DOIS caminhos, por desenho (não é bug do modelo):
 *  - `destinoAposRa` (services/duvida-do-dev.ts) — chamado depois que o RA
 *    também não soube responder — NUNCA carrega `perguntaExecutiva`: a
 *    função não tem esse campo.
 *  - o próprio QA pode deixar `perguntaExecutivaPtBr`/`opcoesPtBr` vazios de
 *    propósito — o prompt (duvida-rails-mission.ts) autoriza isso
 *    explicitamente ("leave both empty rather than forcing a bad one").
 *
 * ANTES desta tarefa, os dois caminhos caíam para `avisarDonoDoProjeto` — um
 * aviso de TEXTO SOLTO no Telegram, sem botões e sem virar `agent_question`
 * (dedupKey `duvida-dev:*`). É a raiz do defeito medido em 02/09: 24 sessões
 * escaladas, ZERO perguntas reais no painel/Telegram. D71 é claro: toda
 * pergunta ao dono é `agent_question` com opções, nunca texto solto — este
 * helper existe para que a escalada SEMPRE vire uma pergunta de verdade,
 * mesmo sem tradução executiva do modelo.
 */
export function textoDeEscaladaParaODono(args: {
  issueNumber: number
  repository: string
  /** A pergunta original do dev, quando disponível (pode estar em inglês). */
  pergunta?: string | null
}): string {
  const base = `O dev assíncrono está parado na tarefa #${args.issueNumber} de ${args.repository} esperando uma decisão sua.`
  const perguntaLimpa = args.pergunta?.trim()
  if (!perguntaLimpa) return base
  // Corte defensivo: uma pergunta gigante do dev não pode virar um texto sem
  // fim no Telegram/painel — 400 caracteres é generoso para dar contexto sem
  // estourar a mensagem.
  return `${base}\n\nPergunta original do dev: "${perguntaLimpa.slice(0, 400)}"`
}
