// "Quais vagas do dev externo estão presas sem ninguém para soltá-las?"
//
// O fechamento já arquiva do lado do fornecedor desde o PR #160. Isso estanca
// o vazamento novo e não devolve nada do que já vazou: uma sessão que o
// produto fechou ANTES daquele conserto — ou que ele nunca chegou a conhecer,
// porque a gravação da linha falhou depois de a sessão nascer — continua viva
// lá fora, ocupando uma vaga, para sempre. Medido em 21/08/2026: dezenove
// sessões ativas no fornecedor, cinco delas sem dono deste lado.
//
// Este módulo é puro de propósito — sem rede, sem banco, sem relógio próprio.
// Ele só responde "quais destas estão órfãs"; arquivar é com quem chamou.

/** O mínimo que a varredura precisa saber de uma sessão do fornecedor. */
export interface SessaoDoFornecedor {
  sessionName: string
  /** Já arquivada lá fora: a vaga está livre, não há o que fazer. */
  archived: boolean
  /** `createTime` do fornecedor. Pode faltar — e a falta importa (ver abaixo). */
  criadaEm: string | null
}

/**
 * Dez minutos entre nascer lá fora e ser considerada órfã aqui.
 *
 * Não é número escolhido por gosto: é a fresta da corrida. A sessão é criada
 * no fornecedor e SÓ DEPOIS a linha é gravada no banco (sm-delegation.ts), e
 * entre as duas coisas cabem uma resposta lenta, uma reinicialização e uma
 * retentativa. Dez minutos cobrem isso com folga larga, e o custo de errar
 * para o lado conservador é uma vaga presa por mais um ciclo — contra o custo
 * de errar para o outro lado, que é matar no berço a delegação que acabou de
 * ser feita.
 */
export const IDADE_MINIMA_PADRAO_MS = 10 * 60_000

export interface ArgumentosDaReconciliacao {
  /** O que o fornecedor diz estar ativo agora. */
  ativasNoFornecedor: SessaoDoFornecedor[]
  /**
   * Nomes das sessões com linha VIVA no banco — da INSTÂNCIA INTEIRA, nunca de
   * um projeto só.
   *
   * O escopo é a parte perigosa. Uma chave de API serve todos os projetos
   * desta instalação, então a listagem do fornecedor traz sessões de todos
   * eles. Cruzar essa lista completa contra as sessões vivas de UM projeto
   * marcaria como órfão o trabalho em andamento de todos os outros — e a
   * varredura arquivaria, uma a uma, as entregas dos vizinhos.
   */
  vivasNoBanco: string[]
  agora: Date
  /** Padrão: `IDADE_MINIMA_PADRAO_MS`. */
  idadeMinimaMs?: number | undefined
}

/**
 * Devolve os nomes das sessões que podem ser arquivadas com segurança.
 *
 * Toda dúvida resolve a favor de NÃO arquivar. Idade ausente ou ilegível conta
 * como desconhecida, e desconhecida não é o mesmo que antiga: sem saber quando
 * a sessão nasceu, não dá para afirmar que ela passou da fresta da corrida, e
 * a única resposta honesta é deixá-la em paz. Uma vaga presa é um incômodo;
 * uma delegação morta no berço é o defeito de volta.
 */
export function vagasOrfas(args: ArgumentosDaReconciliacao): string[] {
  const idadeMinima = args.idadeMinimaMs ?? IDADE_MINIMA_PADRAO_MS
  const vivas = new Set(args.vivasNoBanco)
  const orfas: string[] = []

  for (const sessao of args.ativasNoFornecedor) {
    if (sessao.archived) continue
    if (vivas.has(sessao.sessionName)) continue

    const nascimento = sessao.criadaEm ? Date.parse(sessao.criadaEm) : Number.NaN
    if (Number.isNaN(nascimento)) continue
    if (args.agora.getTime() - nascimento < idadeMinima) continue

    orfas.push(sessao.sessionName)
  }

  return orfas
}

/** Teto de arquivamentos por varredura — ver `varrerVagasVazadas`. */
export const TETO_PADRAO_POR_VARREDURA = 10

export interface DepsDaVarredura {
  /** Lista o que o fornecedor diz estar ativo. `null` = não consegui perguntar. */
  listarNoFornecedor: () => Promise<SessaoDoFornecedor[] | null>
  /** Nomes das sessões com linha viva no banco, da INSTÂNCIA INTEIRA. */
  vivasNoBanco: () => Promise<string[]>
  /** Encerra a sessão lá fora. `false` = não deu, e a vaga continua presa. */
  arquivarNoFornecedor: (sessionName: string) => Promise<boolean>
  agora: Date
  idadeMinimaMs?: number | undefined
  /** Padrão: `TETO_PADRAO_POR_VARREDURA`. */
  teto?: number | undefined
  onWarn?: ((mensagem: string) => void) | undefined
}

export interface RelatorioDaVarredura {
  examinadas: number
  orfas: number
  arquivadas: number
  /** `true` quando não deu para perguntar ao fornecedor ou ao banco. */
  naoConsultado: boolean
}

/**
 * Devolve ao fornecedor as vagas que ninguém aqui reclama.
 *
 * TRÊS GUARDAS, todas contra a mesma classe de erro — arquivar trabalho vivo:
 *
 * 1. Fornecedor mudo não é fornecedor limpo. Se a listagem falhar, a varredura
 *    para. Uma lista vazia por queda de rede, tratada como verdade, faria o
 *    produto concluir que nada está ativo lá fora.
 *
 * 2. Banco mudo tampouco. Se a leitura das sessões vivas falhar, TODAS as
 *    ativas pareceriam órfãs de uma vez — o pior resultado possível desta
 *    função. Metade da informação é pior que nenhuma.
 *
 * 3. Teto por varredura. Mesmo com tudo certo, um erro de lógica aqui não pode
 *    virar centenas de arquivamentos numa tacada. Dez por vez esvazia qualquer
 *    acúmulo real em poucos ciclos e mantém o estrago de um engano pequeno e
 *    visível.
 *
 * Falha em arquivar UMA sessão nunca interrompe as outras: a vaga continua
 * presa, o aviso sai com o nome dentro, e o próximo ciclo tenta de novo.
 */
export async function varrerVagasVazadas(deps: DepsDaVarredura): Promise<RelatorioDaVarredura> {
  const warn = deps.onWarn ?? (() => undefined)
  const vazio: RelatorioDaVarredura = {
    examinadas: 0,
    orfas: 0,
    arquivadas: 0,
    naoConsultado: true,
  }

  let ativas: SessaoDoFornecedor[] | null
  let vivas: string[]
  try {
    ativas = await deps.listarNoFornecedor()
    if (ativas === null) return vazio
    vivas = await deps.vivasNoBanco()
  } catch (err) {
    warn(`[reconciliação] varredura abortada antes de tocar em nada: ${(err as Error).message}`)
    return vazio
  }

  // BANCO VAZIO É SUSPEITA, NÃO É VERDADE.
  //
  // Se o fornecedor tem sessões ativas e este banco não conhece NENHUMA, as
  // duas explicações são muito diferentes e não dá para distinguir daqui: ou
  // tudo vazou de verdade, ou estamos lendo o banco errado — instalação
  // restaurada, base recriada, outra instância dividindo a mesma chave de API.
  // Na segunda hipótese, seguir em frente arquivaria o trabalho vivo de
  // outra gente, dez por hora, sem ninguém pedir.
  //
  // A varredura para e DIZ o que viu. Uma vaga presa por mais um dia custa
  // pouco; entregas alheias arquivadas em silêncio não têm volta.
  if (ativas.length > 0 && vivas.length === 0) {
    warn(
      `[reconciliação] o fornecedor tem ${ativas.length} sessões ativas e este banco não conhece ` +
        `nenhuma. Isso pode ser vazamento total ou banco errado, e daqui não dá para saber — ` +
        `varredura interrompida sem arquivar nada.`
    )
    return { examinadas: ativas.length, orfas: 0, arquivadas: 0, naoConsultado: true }
  }

  const orfas = vagasOrfas({
    ativasNoFornecedor: ativas,
    vivasNoBanco: vivas,
    agora: deps.agora,
    idadeMinimaMs: deps.idadeMinimaMs,
  })

  let arquivadas = 0
  for (const nome of orfas.slice(0, deps.teto ?? TETO_PADRAO_POR_VARREDURA)) {
    try {
      if (await deps.arquivarNoFornecedor(nome)) {
        arquivadas += 1
      } else {
        warn(
          `[reconciliação] a vaga de ${nome} continua presa: o fornecedor recusou o arquivamento`
        )
      }
    } catch (err) {
      warn(`[reconciliação] falha ao arquivar ${nome}: ${(err as Error).message}`)
    }
  }

  return { examinadas: ativas.length, orfas: orfas.length, arquivadas, naoConsultado: false }
}
