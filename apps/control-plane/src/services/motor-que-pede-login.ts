/**
 * O motor que morreu pedindo login para de se dizer conectado.
 *
 * PRINT DO DONO, 26/08/2026 21:30: o assistente mostrava o card do Codex
 * VERDE, com "Conectado" e a lista de modelos, no mesmo minuto em que TODA
 * missão morria com `Failed to refresh token: 401`. Palavra dele: "no setup
 * wizard mostra conectado o codex, então é inviável eu renovar via setup
 * wizard".
 *
 * Ele estava certo, e o defeito não era da tela. Quando a missão caía por
 * credencial expirada, o produto marcava a falha no RESULTADO DA MISSÃO e
 * mandava um recado no Telegram — mas nunca tocava na linha da conexão. A
 * coluna seguia dizendo `connected` para sempre, e a tela apenas repetia o que
 * o banco afirmava. Uma tela verde não oferece nada para clicar: era a própria
 * mentira que tirava do dono o caminho de religar.
 *
 * É a MESMA doença que `prova-de-vida.ts` já descreve ("o produto para de
 * acreditar no que o banco diz sobre os motores"), num caminho que ela não
 * cobria: lá a pergunta é "há quanto tempo ele não responde?"; aqui o motor
 * acabou de responder — dizendo que não tem mais credencial.
 */

/**
 * O estado de quem só volta com login novo.
 *
 * Reusa o MESMO valor que a renovação do GitHub já grava
 * (`scheduler.ts`, `marcarPrecisaReconectar`) em vez de inventar um segundo
 * nome para o mesmo fato: `deveAvisarSobreOMotor` (recado-de-motor-revogado.ts)
 * decide o anti-spam comparando exatamente com este valor, e um sinônimo novo
 * faria o dono ser reavisado a cada tique.
 */
export const STATUS_PRECISA_RELIGAR = 'needs_reconnect'

/**
 * O motivo DURÁVEL, escrito na linha da conexão e lido pela tela.
 *
 * NUNCA carrega a saída crua do provedor. O erro real do CLI costuma trazer
 * URL de OAuth e pedaços de token; esta frase é gravada no banco e mostrada
 * numa tela, então ela é escrita à mão, em português de gente, e só diz o que
 * aconteceu e o que resolve.
 */
export function motivoDeCredencialExpirada(runtime: string): string {
  return `o login de ${runtime} venceu e a renovação automática não deu conta: só volta com um login novo`
}

/** Este motor está pedindo login? É o que a tela precisa saber. */
export function precisaReligar(status: string | null | undefined): boolean {
  return status === STATUS_PRECISA_RELIGAR
}

/**
 * O que escrever na conexão quando a missão morre por credencial expirada.
 *
 * Decisão PURA de propósito: quem grava (o scheduler) fica com uma linha só, e
 * o teto do que pode ser escrito — inclusive o "nunca apagar a credencial" —
 * mora aqui, testável sem banco.
 *
 * A credencial cifrada NÃO é apagada, ao contrário de `revoke()`. Duas razões:
 * uma renovação posterior ainda pode ressuscitá-la, e `captureFromHome` volta
 * a gravar `connected` sozinho na primeira missão que der certo — quer dizer
 * que a marca se desfaz sozinha quando o motor voltar, sem ninguém limpar nada
 * na mão.
 */
export interface MarcaDePedidoDeLogin {
  status: typeof STATUS_PRECISA_RELIGAR
  lastError: string
}

export function marcaDePedidoDeLogin(runtime: string): MarcaDePedidoDeLogin {
  return { status: STATUS_PRECISA_RELIGAR, lastError: motivoDeCredencialExpirada(runtime) }
}
