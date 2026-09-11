import { tetosDoPlanoDoDev, planoEfetivoDaConta, type TetosDoDev } from './plano-do-dev.js'
import { ocupaVaga } from './estados-de-sessao.js'

// VISIBILIDADE da cota do dev assíncrono (Jules) — pedido do dono (01/09/2026):
// "precisa saber o que está sendo enviado, quando foi enviado". Até aqui o
// número existia só DENTRO da decisão de delegar (sm-delegation.ts via
// montarOpcoesDeDelegacao, scheduler.ts) e nunca saía para o dono ver — ele
// tinha que confiar que a esteira estava usando a cota, sem como conferir.
//
// Função PURA, pelo mesmo motivo de montarOpcoesDeDelegacao: sem rede, sem
// banco, testável sem subir nada. A rota (routes/painel.ts) só busca as linhas
// e chama isto.
//
// POR CONTA, NUNCA POR PROJETO — mesmo achado de 29/08 (sm-delegation.ts): o
// teto de simultâneas e o teto diário são do Jules e são por CONTA (BYOK,
// D34); contar por projeto fez dois projetos "pro" se acharem com 200/dia e
// 30 simultâneas contra um teto real de 100 e 15.

export interface ProjetoParaResumo {
  id: string
  nome: string
  devPlan: string | null
  /** Nulo = conta padrão da instância (sem BYOK configurado para este projeto). */
  devAccountId: string | null
}

export interface SessaoParaResumo {
  projectId: string
  devAccountId: string | null
  issueNumber: number
  sessionName: string
  state: string
  createdAt: Date
  closedAt: Date | null
}

export interface SessaoNoResumo {
  projeto: string
  issueNumber: number
  sessionName: string
  estado: string
  /** ISO 8601 — quando a sessão foi de fato aberta no Jules. */
  enviadaEm: string
  /** Ocupa uma das vagas simultâneas da conta AGORA (estados-de-sessao.ts). */
  ocupaVaga: boolean
}

export interface ContaNoResumo {
  /** Nulo = conta padrão da instância. */
  contaId: string | null
  /** Nomes (owner/repo) dos projetos que dividem esta conta. */
  projetos: string[]
  /** O plano mais restritivo entre os projetos da conta — nunca superestima a folga. */
  plano: string
  tetoConcorrentes: number
  tetoDiario: number
  /** Quantas sessões ocupam vaga simultânea AGORA. */
  simultaneas: number
  /** max(0, tetoConcorrentes - simultaneas) — nunca negativo. */
  vagasRestantes: number
  /** Sessões abertas nas últimas 24h — JANELA ROLANTE, não dia de calendário. */
  enviadas24h: number
  /** max(0, tetoDiario - enviadas24h) — nunca negativo. */
  vagasDiariasRestantes: number
  /** As sessões das últimas 24h, mais recente primeiro — "o que foi enviado, quando". */
  sessoes24h: SessaoNoResumo[]
  /**
   * DJ-T5 — pedido do dono: "quantas [vagas] estão sendo usadas pra próximas
   * tarefas ficarem na esteira". ISO 8601 do instante em que a JANELA ROLANTE
   * de 24h libera a próxima vaga diária — `createdAt` da sessão mais antiga
   * dentro das últimas 24h, mais 24h. `null` quando `enviadas24h < tetoDiario`
   * — já há vaga AGORA, não faz sentido prometer uma "próxima".
   */
  proximaVagaDiariaEm: string | null
  /**
   * DJ-T5: quantas tarefas prontas (sem bloqueador, sem sessão viva, sem PR
   * aberto) o Scrum Master viu na ÚLTIMA acordada de cada projeto desta
   * conta e não delegou por falta de vaga/cota ou colisão de arquivo — soma
   * entre os projetos da conta. `0` tanto quando não há nenhuma esperando
   * quanto quando NENHUM projeto da conta ainda teve uma acordada do SM lida
   * (ver `leituraDoSm`, que distingue os dois casos).
   */
  prontasEsperandoVaga: number
  /**
   * 'sem_leitura' quando NENHUM projeto desta conta ainda tem uma missão
   * agent-run-sm concluída para ler — `prontasEsperandoVaga` é 0 por falta
   * de dado, não porque a fila está vazia. 'ok' quando ao menos um projeto
   * já foi lido (os demais, sem leitura própria, entram como 0 na soma).
   */
  leituraDoSm: 'ok' | 'sem_leitura'
}

export interface ResumoDeCota {
  /** ISO 8601 — o instante do cálculo, para o cliente não confiar no próprio relógio. */
  agora: string
  contas: ContaNoResumo[]
}

const JANELA_24H_MS = 24 * 60 * 60 * 1000

const nuncaNegativo = (n: number): number => Math.max(0, n)

/**
 * O plano EFETIVO da conta — mais restritivo entre os DECLARADOS
 * (`planoEfetivoDaConta`, plano-do-dev.ts). DJ-T5b: nulo/vazio é IGNORADO,
 * não tratado como 'free' — projeto sem `devPlan` não pode arrastar a conta
 * inteira para o teto gratuito quando outro projeto da mesma conta é 'pro'.
 */
function tetoMaisRestritivo(planos: readonly (string | null)[]): {
  plano: string
  tetos: TetosDoDev
} {
  const plano = planoEfetivoDaConta(planos)
  return { plano, tetos: tetosDoPlanoDoDev(plano) }
}

export interface LeituraDeSmParaResumo {
  projectId: string
  /** `prontasNaoDelegadas` da ÚLTIMA missão agent-run-sm concluída deste projeto. */
  prontasNaoDelegadas: number
}

export function resumoDeCotaDoDev(args: {
  projetos: readonly ProjetoParaResumo[]
  sessoes: readonly SessaoParaResumo[]
  agora: Date
  /**
   * DJ-T5: a última leitura do SM por projeto (ver rota GET
   * /api/v1/painel/dev-cota, que busca a missão agent-run-sm mais recente
   * concluída de cada projeto). Projeto ausente daqui = "sem leitura ainda"
   * — nunca inventamos um número para ele.
   */
  leiturasDoSm?: readonly LeituraDeSmParaResumo[]
}): ResumoDeCota {
  const corteDe24h = args.agora.getTime() - JANELA_24H_MS

  const projetosPorConta = new Map<string | null, ProjetoParaResumo[]>()
  for (const p of args.projetos) {
    const lista = projetosPorConta.get(p.devAccountId) ?? []
    lista.push(p)
    projetosPorConta.set(p.devAccountId, lista)
  }

  const leituraPorProjeto = new Map(
    (args.leiturasDoSm ?? []).map((l) => [l.projectId, l.prontasNaoDelegadas] as const)
  )

  const contas: ContaNoResumo[] = [...projetosPorConta.entries()]
    .map(([contaId, projetos]) => {
      const sessoesDaConta = args.sessoes.filter((s) => s.devAccountId === contaId)
      const { plano, tetos } = tetoMaisRestritivo(projetos.map((p) => p.devPlan))
      const idParaNome = new Map(projetos.map((p) => [p.id, p.nome] as const))

      const simultaneas = sessoesDaConta.filter(
        (s) => s.closedAt === null && ocupaVaga(s.state)
      ).length

      const sessoesRecentes = sessoesDaConta
        .filter((s) => s.createdAt.getTime() >= corteDe24h)
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      const enviadas24h = sessoesRecentes.length

      const sessoes24h: SessaoNoResumo[] = sessoesRecentes.map((s) => ({
        projeto: idParaNome.get(s.projectId) ?? s.projectId,
        issueNumber: s.issueNumber,
        sessionName: s.sessionName,
        estado: s.state,
        enviadaEm: s.createdAt.toISOString(),
        ocupaVaga: s.closedAt === null && ocupaVaga(s.state),
      }))

      // Teto diário CHEIO (enviadas24h >= teto): a próxima vaga só libera
      // quando a sessão mais ANTIGA das últimas 24h completar sua janela —
      // `sessoesRecentes` está ordenada da mais recente para a mais antiga,
      // então a mais antiga é a última do array. Com folga (enviadas24h <
      // teto) há vaga AGORA — prometer uma "próxima" seria enganoso.
      const proximaVagaDiariaEm: string | null =
        enviadas24h >= tetos.tetoDiario && sessoesRecentes.length > 0
          ? new Date(
              sessoesRecentes[sessoesRecentes.length - 1]!.createdAt.getTime() + JANELA_24H_MS
            ).toISOString()
          : null

      const idsDosProjetos = projetos.map((p) => p.id)
      const leiturasDaConta = idsDosProjetos
        .map((id) => leituraPorProjeto.get(id))
        .filter((v): v is number => v !== undefined)
      const prontasEsperandoVaga = leiturasDaConta.reduce((soma, n) => soma + n, 0)
      const leituraDoSm: 'ok' | 'sem_leitura' = leiturasDaConta.length > 0 ? 'ok' : 'sem_leitura'

      return {
        contaId,
        projetos: projetos.map((p) => p.nome),
        plano,
        tetoConcorrentes: tetos.tetoConcorrentes,
        tetoDiario: tetos.tetoDiario,
        simultaneas,
        vagasRestantes: nuncaNegativo(tetos.tetoConcorrentes - simultaneas),
        enviadas24h,
        vagasDiariasRestantes: nuncaNegativo(tetos.tetoDiario - enviadas24h),
        sessoes24h,
        proximaVagaDiariaEm,
        prontasEsperandoVaga,
        leituraDoSm,
      }
    })
    // Conta com mais uso primeiro — é a que o dono mais precisa olhar.
    .sort((a, b) => b.enviadas24h - a.enviadas24h)

  return { agora: args.agora.toISOString(), contas }
}
