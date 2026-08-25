/**
 * De QUEM é a cota que esta delegação vai consumir.
 *
 * O teto do dev assíncrono é da CONTA, não do projeto: no plano Pro são 100
 * sessões em 24 horas e 15 ao mesmo tempo, divididas entre TODOS os
 * repositórios que aquela conta enxerga. O produto aplicava esse número por
 * PROJETO — com dois projetos "pro" ele se achava no direito de pedir 200 por
 * dia e 30 simultâneas contra um teto real de 100 e 15.
 *
 * Foi isso que produziu mais de cem delegações recusadas num único dia: o
 * produto pedindo contra uma parede que ele mesmo não sabia que existia, já que
 * a API do Jules não expõe cota nenhuma (`/quota`, `/limits`, `/usage` e
 * `/account` respondem 404 — só se descobre o teto batendo nele).
 *
 * A chave existe como conceito próprio porque ela MUDA de dono: hoje há uma
 * conta só, a do dono da instância; com BYOK cada cliente traz a dele, e a
 * conta passa a ser a credencial daquele cliente. Escrever "por conta" desde
 * agora é o que faz o BYOK ser uma troca de valor em vez de uma reescrita.
 */

/** A conta única da instância, enquanto ninguém trouxe a própria. */
export const CONTA_DA_INSTANCIA = 'instancia'

export interface ProjetoComCredencial {
  /**
   * A credencial do dev assíncrono que ESTE projeto usa, quando o cliente
   * trouxe a dele (BYOK). Ausente = usa a conta da instância.
   */
  credencialDoDevId?: string | null | undefined
}

/**
 * A conta que esta delegação consome.
 *
 * Sem credencial própria, todos os projetos compartilham a conta da instância —
 * e é exatamente por isso que o teto precisa ser contado junto entre eles.
 */
export function contaDoDevExterno(projeto: ProjetoComCredencial | null | undefined): string {
  const id = projeto?.credencialDoDevId
  if (typeof id !== 'string') return CONTA_DA_INSTANCIA
  const limpo = id.trim()
  return limpo === '' ? CONTA_DA_INSTANCIA : limpo
}

/**
 * Dois projetos consomem a MESMA cota?
 *
 * É a pergunta que decide se a contagem deles soma. Existe como função própria
 * para o dia do BYOK: quando cada cliente tem a sua conta, dois projetos do
 * mesmo cliente continuam somando, e de clientes diferentes deixam de somar.
 */
export function dividemAMesmaConta(
  a: ProjetoComCredencial | null | undefined,
  b: ProjetoComCredencial | null | undefined
): boolean {
  return contaDoDevExterno(a) === contaDoDevExterno(b)
}

export interface UsoDaConta {
  /** Sessões abertas nas últimas 24 horas por TODOS os projetos desta conta. */
  delegadasNaJanela: number
  /** Sessões vivas agora, somando todos os projetos desta conta. */
  vivasAgora: number
}

export interface FolgaDaConta {
  /** Quantas sessões ainda cabem. Nunca negativo. */
  cabem: number
  /** Por qual dos dois tetos parou — para o recado ao dono dizer a verdade. */
  limitadoPor: 'diario' | 'concorrentes' | 'nenhum'
}

/**
 * Quantas sessões ainda cabem nesta conta agora.
 *
 * Os dois tetos são contadores DIFERENTES, e tratá-los com a mesma régua daria
 * conta errada: o de simultâneas libera a vaga no instante em que uma sessão
 * termina, enquanto o de 24 horas só devolve cada sessão 24 horas depois de ela
 * ter começado — é janela móvel, não vira à meia-noite. Quem manda é o mais
 * apertado dos dois.
 */
export function folgaDaConta(args: {
  uso: UsoDaConta
  tetoDiario: number
  tetoConcorrentes: number
}): FolgaDaConta {
  const porDia = args.tetoDiario - args.uso.delegadasNaJanela
  const porVaga = args.tetoConcorrentes - args.uso.vivasAgora
  const cabem = Math.max(0, Math.min(porDia, porVaga))

  if (cabem > 0) return { cabem, limitadoPor: 'nenhum' }
  // Empate resolve pelo diário: é o teto que só passa com o tempo, e o recado
  // ao dono precisa dizer "amanhã" em vez de "espere uma sessão terminar".
  return { cabem: 0, limitadoPor: porDia <= porVaga ? 'diario' : 'concorrentes' }
}
