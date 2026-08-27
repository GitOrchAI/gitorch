/**
 * O recado que o dono recebe quando um motor precisa ser religado.
 *
 * PERGUNTA DO DONO, 26/08: "pq não recebo informação via telegram pra fazer
 * renew caso o automático não funcione? sabendo que já fiz isso no setup
 * wizard?"
 *
 * Ele estava certo. A vigília marcava a conexão como precisando de reconexão e
 * escrevia um aviso no LOG — que ninguém lê. O dono só descobria quando a
 * esteira parava.
 *
 * A promessa é explícita: conectar UMA vez no assistente e nunca mais, com
 * revogação real como única exceção. Mas "exceção" significa AVISAR e pedir a
 * reconexão — não marcar em silêncio e esperar que ele note sozinho.
 */

/** Como cada motor se chama para quem não é técnico. */
const NOME_DO_MOTOR: Record<string, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex (OpenAI)',
  claude: 'Claude',
}

export function nomeAmigavelDoMotor(runtime: string): string {
  return NOME_DO_MOTOR[runtime] ?? runtime
}

/**
 * O texto do recado.
 *
 * Diz O QUE FAZER, e não só que quebrou: o dono não é técnico, e um aviso que
 * só informa a falha transfere para ele o trabalho de descobrir a saída.
 *
 * Nunca carrega o erro cru do provedor — ele costuma trazer URL de OAuth e
 * pedaços de token, e isso não pode viajar para um chat.
 */
export function recadoDeMotorRevogado(runtime: string): string {
  const nome = nomeAmigavelDoMotor(runtime)
  return [
    `GitOrch: a conexão do motor ${nome} foi revogada e eu não consigo renová-la sozinho.`,
    '',
    'As tarefas automáticas que dependem dele ficam paradas até você reconectar.',
    '',
    `Para religar: abra o GitOrch, vá em configuração dos motores e conecte o ${nome} de novo —` +
      ' é o mesmo caminho do primeiro login.',
  ].join('\n')
}

/**
 * Este motor merece um recado agora?
 *
 * Só na VIRADA. A vigília roda de hora em hora, e sem esta regra o mesmo
 * recado chegaria vinte e quatro vezes por dia — e spam apaga sinal tanto
 * quanto silêncio. É a mesma disciplina que o aviso do GitHub já usa.
 */
export function deveAvisarSobreOMotor(statusAnterior: string | null | undefined): boolean {
  return statusAnterior !== 'needs_reconnect'
}
