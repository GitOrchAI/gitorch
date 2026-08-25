import { createHash } from 'node:crypto'
import { CONTA_DA_INSTANCIA } from './conta-do-dev-externo.js'

/**
 * BYOK — cada cliente traz a própria conta do dev assíncrono (D34).
 *
 * O teto do dev assíncrono é da CONTA: no plano Pro são 100 sessões em 24h e 15
 * ao mesmo tempo, divididas entre TODOS os repositórios daquela conta. Com uma
 * conta só — a do dono da instância — dois clientes já estouram o teto e a
 * recusa vira rotina por volta do sexto ao nono cliente. Com a conta do próprio
 * cliente, cada um traz o seu teto e a escala deixa de ser uma divisão.
 *
 * Aqui mora a pergunta "de quem é a chave desta delegação, e a que conta ela
 * pertence" — as duas respostas SEMPRE juntas, porque separá-las produziria a
 * pior falha possível: contar a cota de um cliente e gastar a chave de outro.
 *
 * A credencial em si segue o caminho que já existe para os motores de IA do
 * cliente (cifrada no banco, decifrada só no instante do uso, nunca escrita em
 * arquivo, nunca em log). Este módulo é puro de propósito: recebe o texto
 * cifrado e a função de decifrar, para poder ser provado sem banco e sem chave
 * de verdade.
 */

/** Recusa quando o cliente trouxe uma credencial que o produto não consegue ler. */
export const ERRO_CREDENCIAL_ILEGIVEL = 'credencial-do-dev-ilegivel'
/** Recusa quando não há credencial nenhuma — nem do cliente, nem da instância. */
export const ERRO_SEM_CREDENCIAL = 'sem-credencial-do-dev'

/**
 * A identidade da conta a partir da chave.
 *
 * É a IMPRESSÃO DIGITAL da chave, não a chave: vai para o banco, para o log e
 * para o painel, e por isso não pode carregar o segredo dentro. Sai do texto
 * decifrado, e não do envelope cifrado, porque o envelope tem sal aleatório —
 * a mesma chave guardada em dois projetos do mesmo cliente produz dois
 * envelopes diferentes, e usar o envelope faria o produto achar que são dois
 * clientes, dando ao cliente o dobro do teto que ele tem.
 */
export function identidadeDaConta(chave: string): string {
  return `conta-${createHash('sha256').update(chave).digest('hex').slice(0, 16)}`
}

export type CredencialDoDev =
  | { ok: true; chave: string; conta: string; propria: boolean }
  | { ok: false; motivo: typeof ERRO_CREDENCIAL_ILEGIVEL | typeof ERRO_SEM_CREDENCIAL }

/**
 * Qual chave esta delegação usa, e contra qual conta ela conta.
 *
 * Credencial ilegível RECUSA em vez de cair na conta da instância. O silêncio
 * seria pior que o erro: o cliente acharia que está gastando a conta dele e a
 * fatura chegaria para o dono, sem nada no caminho denunciando a troca.
 */
export function resolverCredencialDoDev(args: {
  /** O que o cliente guardou no produto, cifrado. Ausente = não trouxe conta. */
  credencialCifrada: string | null | undefined
  /** A chave da instância (do dono), usada por quem não trouxe a própria. */
  chaveDaInstancia: string | null | undefined
  decifrar: (envelope: string) => string
}): CredencialDoDev {
  const envelope = args.credencialCifrada?.trim()
  if (envelope) {
    let aberta: string
    try {
      aberta = args.decifrar(envelope).trim()
    } catch {
      // Sem detalhe do erro de propósito: mensagem de cripto costuma vazar
      // tamanho e formato do que estava lá dentro.
      return { ok: false, motivo: ERRO_CREDENCIAL_ILEGIVEL }
    }
    if (aberta === '') return { ok: false, motivo: ERRO_CREDENCIAL_ILEGIVEL }
    return { ok: true, chave: aberta, conta: identidadeDaConta(aberta), propria: true }
  }

  const daInstancia = args.chaveDaInstancia?.trim()
  if (!daInstancia) return { ok: false, motivo: ERRO_SEM_CREDENCIAL }
  return { ok: true, chave: daInstancia, conta: CONTA_DA_INSTANCIA, propria: false }
}

/** Recado ao dono/cliente, em linguagem de gente, para cada recusa. */
export function recadoDaRecusa(motivo: string): string {
  return motivo === ERRO_CREDENCIAL_ILEGIVEL
    ? 'a conta do dev assíncrono deste projeto não pôde ser lida — reconecte a conta nas configurações do projeto'
    : 'nenhuma conta de dev assíncrono conectada — conecte a sua no wizard para este projeto delegar'
}

/**
 * Quais projetos dividem a cota deste aqui.
 *
 * Existe como função (e não como consulta escrita à mão em cada ponto) porque
 * errar esta condição é caro dos dois lados: larga demais, um cliente come o
 * teto do outro; estreita demais, o produto se acha com o dobro do teto que
 * tem e as delegações voltam recusadas — foi o que produziu mais de cem
 * recusas num dia só.
 *
 * Sem conta própria, o projeto divide a conta da instância com os OUTROS que
 * também não trouxeram a sua: `null` casa com `null`, e nunca com quem trouxe.
 */
export function filtroDaMesmaConta(devAccountId: string | null | undefined): {
  devAccountId: string | null
} {
  const id = devAccountId?.trim()
  return { devAccountId: id ? id : null }
}
