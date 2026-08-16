import {
  AcessoNaoVerificavelError,
  CredencialDoGithubInvalidaError,
} from './acesso-ao-repositorio.js'

/**
 * A reconferência de acesso do CAMINHO AUTOMÁTICO.
 *
 * As duas portas do pedido (a tela e o mensageiro) reconferem o acesso na hora
 * de usar. O relógio não reconferia nada — e é ele quem escreve muito mais,
 * sozinho, sem ninguém clicar em botão nenhum:
 *
 *   Alice é colaboradora com escrita em `acme/api`. Ela conclui o cadastro (a
 *   prova passa) e o projeto nasce com as agendas padrão. A Acme remove a
 *   Alice. As portas do pedido passam a recusar na hora — e o relógio continua
 *   disparando missão e escrevendo naquele repositório com a credencial da
 *   INSTALAÇÃO, que continua legítima.
 *
 * O desenho NÃO é provar a cada operação: seria uma chamada a mais por missão,
 * contra a cota do cliente, para responder algo que muda raramente — e o
 * produto age com a credencial da instalação, não com a do cliente, então a
 * pergunta não pertence ao momento da escrita. O desenho é:
 *
 * **O projeto é SUSPENSO quando o dono perde o acesso ao repositório.**
 *
 * - a conferência é PERIÓDICA e POR PROJETO: uma prova por projeto por ciclo,
 *   com intervalo próprio (INTERVALO_DE_RECONFERENCIA_MS) e sempre antes do
 *   primeiro disparo do dia;
 * - perdeu o acesso → o projeto para de disparar missão, o estado fica
 *   registrado no banco e o dono é avisado pelo Telegram, com o motivo em
 *   português de gente;
 * - NÃO deu para verificar → **não suspende**. Indisponibilidade do GitHub não
 *   pode derrubar o trabalho de todo mundo. Registra a falha e tenta de novo
 *   no ciclo seguinte (mais curto, ver INTERVALO_DE_NOVA_TENTATIVA_MS); depois
 *   de várias falhas seguidas, avisa o dono que não está conseguindo conferir;
 * - recuperou o acesso → volta a disparar sozinho, sem ninguém mexer em nada.
 *
 * Tudo aqui é decidido por função PURA, testada caso a caso, e só depois ligado
 * ao relógio (plugins/scheduler.ts). A porta que efetivamente segura o disparo
 * é `projetoEstaSuspensoPorAcesso`, consultada no ponto único onde a missão
 * nasce.
 */

/** De quanto em quanto tempo cada projeto é reconferido, no caso normal. */
export const INTERVALO_DE_RECONFERENCIA_MS = 6 * 60 * 60 * 1000

/**
 * Intervalo quando a última tentativa não concluiu nada.
 *
 * Mais curto que o normal de propósito: uma instabilidade do GitHub não pode
 * empurrar a próxima tentativa para daqui a seis horas (o produto ficaria
 * meio dia sem saber se ainda pode escrever). Mais longo que o tique do
 * relógio, também de propósito: repetir a cada minuto, para todos os projetos,
 * transformaria a indisponibilidade deles numa rajada nossa.
 */
export const INTERVALO_DE_NOVA_TENTATIVA_MS = 30 * 60 * 1000

/**
 * Quantas falhas seguidas antes de avisar o dono que não estamos conseguindo
 * conferir. Nada é suspenso por isso — o aviso existe para o silêncio não ser
 * confundido com "está tudo certo".
 */
export const FALHAS_ATE_AVISAR = 4

/** O acompanhamento de acesso de UM projeto, do jeito que o banco o guarda. */
export interface EstadoDeAcesso {
  /** Última conferência CONCLUÍDA (com resposta ou com falha). */
  conferidoEm: Date | null
  /** Preenchido = projeto suspenso; a data é a de quando a suspensão começou. */
  suspensoEm: Date | null
  /** Por que foi suspenso — texto curto, para o log e para o suporte. */
  motivoDaSuspensao: string | null
  /** Conferências seguidas que não concluíram nada. Zera em qualquer resposta. */
  falhasSeguidas: number
}

/** O que a conferência conseguiu apurar sobre um repositório. */
export type ProvaDeAcesso =
  | { tipo: 'escreve' }
  | { tipo: 'nao-escreve' }
  | { tipo: 'inconclusiva'; motivo: string; credencial?: boolean }

export interface DecisaoDeAcesso {
  /** O estado a gravar. */
  estado: EstadoDeAcesso
  /** Mudou de regime nesta rodada? É o que merece log e aviso. */
  virada: 'suspendeu' | 'liberou' | null
  /** Texto para o dono, em português de gente. `null` = não incomodar. */
  avisoAoDono: string | null
}

function mensagemDeSuspensao(repo: string): string {
  return (
    `Parei as tarefas automáticas de ${repo}: o GitHub diz que você não tem mais acesso ` +
    'de escrita nesse repositório, então nada pode ser registrado lá. ' +
    'Assim que o acesso voltar, eu retomo sozinho.'
  )
}

function mensagemDeRetomada(repo: string): string {
  return (
    `Voltei a rodar as tarefas automáticas de ${repo}: seu acesso de escrita no GitHub ` +
    'está de volta.'
  )
}

function mensagemDeDuvida(repo: string, tentativas: number, credencial: boolean): string {
  if (credencial) {
    return (
      `Não estou conseguindo confirmar no GitHub o seu acesso a ${repo}: sua conexão com o ` +
      'GitHub não vale mais. Abra o GitOrch e reconecte sua conta — as tarefas continuam ' +
      'rodando, mas eu sigo sem conseguir conferir.'
    )
  }
  return (
    `Não estou conseguindo confirmar no GitHub o seu acesso a ${repo} — ${tentativas} tentativas ` +
    'seguidas sem resposta. Não parei nada por isso; só não consegui conferir.'
  )
}

function diaUtc(data: Date): string {
  return data.toISOString().slice(0, 10)
}

/**
 * Está na hora de gastar uma chamada da cota do cliente com este projeto?
 *
 * Pura, e é ela que impede a reconferência de virar custo por missão: o
 * relógio bate a cada minuto, mas cada projeto só é perguntado uma vez por
 * ciclo.
 *
 * "Sempre antes do primeiro disparo do dia" é a segunda linha: as agendas
 * padrão acordam de manhã, e uma conferência de ontem à noite não pode
 * autorizar o dia inteiro de hoje. O dia é o UTC, o mesmo fuso em que o
 * relógio das agendas é lido (ver isScheduleDue).
 *
 * Conferência com data no FUTURO (relógio de máquina adiantado, restauração de
 * backup) não dispara nada: a diferença fica negativa, e nenhum dos dois
 * limites é atingido — melhor esperar do que entrar num ciclo de conferências
 * em cascata.
 */
export function precisaReconferir(
  estado: Pick<EstadoDeAcesso, 'conferidoEm' | 'falhasSeguidas'>,
  agora: Date
): boolean {
  if (!estado.conferidoEm) return true
  const desde = agora.getTime() - estado.conferidoEm.getTime()
  if (desde < 0) return false
  if (estado.falhasSeguidas > 0) return desde >= INTERVALO_DE_NOVA_TENTATIVA_MS
  if (desde >= INTERVALO_DE_RECONFERENCIA_MS) return true
  return diaUtc(estado.conferidoEm) !== diaUtc(agora)
}

/**
 * O QUE FAZER com o que a conferência apurou. Função pura: mesma entrada,
 * mesma saída, sem banco, sem rede e sem relógio próprio (o `agora` entra).
 *
 * Três regras que esta função não abre mão:
 *
 * 1. **Só "não escreve" suspende.** Dúvida (rede, 5xx, credencial recusada,
 *    até defeito nosso) NUNCA suspende: derrubar o trabalho de todo mundo por
 *    uma instabilidade do GitHub seria pior que o risco que a suspensão evita.
 * 2. **Aviso não vira ruído.** O dono é avisado na VIRADA (suspendeu, voltou)
 *    e uma única vez quando as falhas seguidas atingem o limite — nunca a cada
 *    ciclo, senão ele aprende a ignorar a mensagem que mais importa.
 * 3. **A data da suspensão não é reescrita.** Ela conta desde quando o projeto
 *    está parado; sobrescrevê-la a cada ciclo apagaria essa informação.
 */
export function decidirAcessoDoProjeto(args: {
  repo: string
  estado: EstadoDeAcesso
  prova: ProvaDeAcesso
  agora: Date
}): DecisaoDeAcesso {
  const { repo, estado, prova, agora } = args

  if (prova.tipo === 'escreve') {
    const liberou = estado.suspensoEm !== null
    return {
      estado: {
        conferidoEm: agora,
        suspensoEm: null,
        motivoDaSuspensao: null,
        falhasSeguidas: 0,
      },
      virada: liberou ? 'liberou' : null,
      avisoAoDono: liberou ? mensagemDeRetomada(repo) : null,
    }
  }

  if (prova.tipo === 'nao-escreve') {
    const jaEstavaSuspenso = estado.suspensoEm !== null
    const motivo = `o dono não tem mais acesso de escrita em ${repo}`
    return {
      estado: {
        conferidoEm: agora,
        // Mantém a data original: ela diz desde QUANDO o projeto está parado.
        suspensoEm: estado.suspensoEm ?? agora,
        motivoDaSuspensao: estado.motivoDaSuspensao ?? motivo,
        falhasSeguidas: 0,
      },
      virada: jaEstavaSuspenso ? null : 'suspendeu',
      avisoAoDono: jaEstavaSuspenso ? null : mensagemDeSuspensao(repo),
    }
  }

  // Inconclusiva: não sabemos. Nada muda de regime — o que estava rodando
  // continua rodando, o que estava suspenso continua suspenso.
  const falhasSeguidas = estado.falhasSeguidas + 1
  const avisar = falhasSeguidas === FALHAS_ATE_AVISAR
  return {
    estado: {
      conferidoEm: agora,
      suspensoEm: estado.suspensoEm,
      motivoDaSuspensao: estado.motivoDaSuspensao,
      falhasSeguidas,
    },
    virada: null,
    avisoAoDono: avisar ? mensagemDeDuvida(repo, falhasSeguidas, prova.credencial === true) : null,
  }
}

/**
 * A porta que segura o disparo: um projeto suspenso por falta de acesso não
 * gera missão nenhuma até o acesso voltar.
 *
 * Aceita o registro do banco cru de propósito — é chamada no ponto único onde
 * a missão nasce (plugins/scheduler.ts), com o projeto que acabou de ser lido.
 */
export function projetoEstaSuspensoPorAcesso(projeto: {
  accessSuspendedAt?: Date | null
}): boolean {
  return projeto.accessSuspendedAt != null
}

/** Um projeto, do jeito que a reconferência precisa dele. */
export interface ProjetoParaReconferir {
  id: string
  /** Endereço do repositório ("dono/repo"). */
  repo: string
  /** Dono do projeto. `null` só em registro legado — sem dono não há prova. */
  ownerId: string | null
  estado: EstadoDeAcesso
}

export interface DependenciasDaReconferencia {
  /** Os projetos ativos candidatos à conferência. */
  projetos: () => Promise<ProjetoParaReconferir[]>
  /**
   * A prova de escrita com a credencial do DONO. `false` = o GitHub disse que
   * ele não escreve ali; lançar = não deu para saber (ver
   * services/acesso-ao-repositorio.ts).
   */
  provarEscrita: (repo: string, ownerId: string) => Promise<boolean>
  /** Grava o estado apurado. */
  salvar: (projectId: string, estado: EstadoDeAcesso) => Promise<void>
  /** Avisa o dono daquele projeto. Ausente = ninguém vinculado; segue sem avisar. */
  avisarDono?: (projectId: string, texto: string) => Promise<void>
  agora?: Date
  onWarn?: (mensagem: string) => void
}

export interface ResumoDaReconferencia {
  conferidos: number
  suspensos: number
  liberados: number
  inconclusivos: number
}

/**
 * Roda a conferência de todos os projetos que estão na hora, aplica a decisão
 * e grava. Sequencial de propósito: são poucos projetos por ciclo, e uma
 * rajada contra o GitHub aparece como limite secundário — que voltaria aqui
 * disfarçado de "não verificável" e puniria o cliente por um excesso nosso.
 *
 * Nunca lança: uma falha de banco, de rede ou de Telegram num projeto não pode
 * impedir a conferência dos outros nem derrubar o relógio (que é um
 * setInterval — promessa rejeitada ali derruba o processo).
 *
 * A ordem GRAVAR → AVISAR não é acidental: o que decide se o produto escreve
 * ou não é o estado no banco. Se o aviso falhar, a suspensão já valeu; se
 * avisássemos antes, uma falha de gravação deixaria o dono com a mensagem de
 * um freio que não foi puxado.
 */
export async function reconferirAcessoDosProjetos(
  deps: DependenciasDaReconferencia
): Promise<ResumoDaReconferencia> {
  const agora = deps.agora ?? new Date()
  const resumo: ResumoDaReconferencia = {
    conferidos: 0,
    suspensos: 0,
    liberados: 0,
    inconclusivos: 0,
  }

  let projetos: ProjetoParaReconferir[]
  try {
    projetos = await deps.projetos()
  } catch (err) {
    deps.onWarn?.(
      `não foi possível listar os projetos para reconferir o acesso: ${textoDoErro(err)}`
    )
    return resumo
  }

  for (const projeto of projetos) {
    if (!precisaReconferir(projeto.estado, agora)) continue
    // Registro legado sem dono: não existe credencial com que perguntar, e
    // "não perguntei" jamais pode virar suspensão.
    if (!projeto.ownerId) continue

    const prova = await provar(deps, projeto)
    const decisao = decidirAcessoDoProjeto({
      repo: projeto.repo,
      estado: projeto.estado,
      prova,
      agora,
    })

    resumo.conferidos += 1
    if (decisao.virada === 'suspendeu') resumo.suspensos += 1
    if (decisao.virada === 'liberou') resumo.liberados += 1
    if (prova.tipo === 'inconclusiva') resumo.inconclusivos += 1

    try {
      await deps.salvar(projeto.id, decisao.estado)
    } catch (err) {
      deps.onWarn?.(
        `não foi possível gravar o estado de acesso do projeto ${projeto.id}: ${textoDoErro(err)}`
      )
      // Sem estado gravado, o aviso descreveria uma decisão que não vale.
      continue
    }

    if (decisao.virada === 'suspendeu') {
      deps.onWarn?.(`projeto ${projeto.id} SUSPENSO: ${decisao.estado.motivoDaSuspensao}`)
    }

    if (decisao.avisoAoDono && deps.avisarDono) {
      try {
        await deps.avisarDono(projeto.id, decisao.avisoAoDono)
      } catch (err) {
        deps.onWarn?.(
          `não foi possível avisar o dono do projeto ${projeto.id}: ${textoDoErro(err)}`
        )
      }
    }
  }

  return resumo
}

/**
 * A prova, traduzida para o vocabulário da decisão. TODO erro vira dúvida —
 * inclusive um defeito nosso: a única coisa que suspende um cliente é o GitHub
 * dizendo, com todas as letras, que ele não escreve mais ali.
 */
async function provar(
  deps: DependenciasDaReconferencia,
  projeto: ProjetoParaReconferir
): Promise<ProvaDeAcesso> {
  try {
    const escreve = await deps.provarEscrita(projeto.repo, projeto.ownerId as string)
    return escreve ? { tipo: 'escreve' } : { tipo: 'nao-escreve' }
  } catch (err) {
    if (err instanceof CredencialDoGithubInvalidaError) {
      return { tipo: 'inconclusiva', motivo: textoDoErro(err), credencial: true }
    }
    if (err instanceof AcessoNaoVerificavelError) {
      return { tipo: 'inconclusiva', motivo: textoDoErro(err) }
    }
    deps.onWarn?.(
      `erro inesperado ao conferir o acesso do projeto ${projeto.id}: ${textoDoErro(err)}`
    )
    return { tipo: 'inconclusiva', motivo: textoDoErro(err) }
  }
}

function textoDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
