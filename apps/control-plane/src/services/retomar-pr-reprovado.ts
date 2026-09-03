// Quando o QA REPROVA um pull request do dev assíncrono e a sessão que abriu
// esse PR já está TERMINAL (COMPLETED/FAILED — o Jules não vai empurrar
// commit novo sozinho), a esteira NÃO pode simplesmente fechar a linha e
// devolver a issue para a fila: sem `startingBranch`/`workingBranch`
// apontando para o PR existente, a próxima delegação abre um PULL REQUEST
// NOVO do zero — a MESMA tarefa acumulando sessões e PRs.
//
// Medido: issue #3884 do Jardim (02/09/2026), 5 sessões e 3 pull requests
// (#3907 31/08, #3913 01/09, #3917 02/09) para UMA task. Toda madrugada o SM
// delegava de novo porque a sessão anterior tinha fechado como
// `pr-rejeitado-sem-retomada`, e a nova sessão abria um PR novo em vez de
// continuar o PR reprovado — #3907 e #3917 ficaram os DOIS abertos para a
// mesma issue.
//
// A retomada certa é no MESMO PR: sessão nova, mas `startingBranch` e
// `workingBranch` apontando para a branch que o PR já usa — o Jules empurra
// na branch existente em vez de inventar uma nova, e o pull request que já
// existe recebe o commit novo. Contrato conferido AO VIVO em 31/08/2026
// contra `jules.googleapis.com` (ver `criarSessaoDev`/`CriarSessaoDeps` em
// jules-client.ts): sem `workingBranch`, `automationMode: 'AUTO_CREATE_PR'`
// cria um pull request NOVO.
//
// PURO NA DECISÃO, INJETADO NA AÇÃO — mesma disciplina de `vigia-do-pr.ts` e
// `sessao-terminal.ts`: o teto de retomadas por PR é testável sem rede, e
// quem fala com o dev externo, o banco e o dono é sempre injeção.

import type { ResultadoDoAcionamentoDoDev } from './sm-delegation.js'

/**
 * Quantas vezes a esteira tenta retomar o MESMO pull request reprovado antes
 * de parar e perguntar ao dono.
 *
 * TRÊS, o mesmo raciocínio (e quase o mesmo número) de `MAX_ACOES_DO_VIGIA`
 * (vigia-do-pr.ts) e `MAX_PEDIDOS_DE_REBASE` (conflito-de-merge.ts): se o dev
 * não resolveu em três tentativas na MESMA branch, ou o pedido não está
 * claro, ou o defeito é maior do que ele alcança sozinho. Cada tentativa é
 * uma sessão nova gastando cota real da conta do dev — insistir sem teto
 * queima cota e adia o momento em que o dono descobre.
 */
export const TETO_DE_RETOMADAS_POR_PR = 3

/**
 * O que fazer sabendo só quantas vezes ESTE pull request já foi retomado —
 * sem rede, sem banco.
 */
export function decidirRetomadaDoPr(args: {
  retomadasAnteriores: number
}): { acao: 'retomar' } | { acao: 'escalar' } {
  return args.retomadasAnteriores >= TETO_DE_RETOMADAS_POR_PR
    ? { acao: 'escalar' }
    : { acao: 'retomar' }
}

/**
 * O prompt que o dev recebe ao retomar: o parecer do QA + a instrução
 * explícita de NÃO abrir outro pull request.
 *
 * Sem a instrução, nada garante que o dev entenda "continue aqui" — e o
 * histórico medido (#3907/#3913/#3917) é exatamente o comportamento padrão
 * quando ninguém pede o contrário.
 */
export function montarPromptDeRetomada(args: { numeroDoPr: number; parecerDoQa: string }): string {
  return [
    args.parecerDoQa.trim(),
    '',
    `Continue neste pull request #${args.numeroDoPr}, nesta mesma branch — a entrega já existe, ` +
      'só precisa do conserto acima. NÃO abra outro pull request: isso deixaria duas entregas ' +
      'abertas para a mesma tarefa.',
  ].join('\n')
}

/** O que basta saber do PR reprovado para retomar nele. */
export interface PrParaRetomada {
  number: number
  /** `head.ref` do GitHub — o ramo onde o trabalho do dev já está. */
  headRef: string
}

export interface SessaoAnteriorParaRetomada {
  sessionName: string
}

export interface DepsDeRetomadaDoPr {
  /**
   * Quantas sessões anteriores JÁ tentaram retomar este MESMO pull request
   * (contagem por `pullRequestNumber`, dev-session-store.ts) — nunca conta a
   * sessão ORIGINAL que abriu o PR, só as retomadas depois dela.
   */
  contarRetomadasAnteriores: (args: { projectId: string; prNumber: number }) => Promise<number>
  /** Aciona o dev de verdade — mesma família de `criarSessaoJules`. */
  criarSessaoDev: (args: {
    repository: string
    startingBranch: string
    workingBranch: string
    titulo: string
    prompt: string
  }) => Promise<ResultadoDoAcionamentoDoDev>
  /** Grava a linha nova ligada à MESMA issue e ao MESMO pull request. */
  registrarSessaoRetomada: (args: {
    issueNumber: number
    sessionName: string
    prNumber: number
  }) => Promise<void>
  /**
   * D71: escala ao dono com 3 opções objetivas + a livre — reutiliza
   * `agentQuestionService.ask` (ver `escalar-duvida-ao-dono.ts` para o
   * mesmo padrão). Nunca um aviso de texto solto.
   */
  perguntarAoDono: (args: {
    issueNumber: number
    numeroDoPr: number
    retomadasAnteriores: number
  }) => Promise<void>
  onWarn?: (m: string) => void
  onInfo?: (m: string) => void
}

export type ResultadoDeRetomada =
  | { acao: 'retomou'; sessionName: string }
  | { acao: 'escalou' }
  | { acao: 'nao-retomou'; motivo: string }

/**
 * Retoma um pull request reprovado — ou escala ao dono quando o teto de
 * tentativas na MESMA branch já foi atingido.
 */
export async function retomarPrReprovado(
  args: {
    projectId: string
    repository: string
    issueNumber: number
    pr: PrParaRetomada
    /** O texto do parecer do QA — vai inteiro para o prompt do dev. */
    parecerDoQa: string
    /** A sessão terminal que está sendo fechada — só para o log. */
    sessaoAnterior: SessaoAnteriorParaRetomada
  },
  deps: DepsDeRetomadaDoPr
): Promise<ResultadoDeRetomada> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  const retomadasAnteriores = await deps.contarRetomadasAnteriores({
    projectId: args.projectId,
    prNumber: args.pr.number,
  })
  const decisao = decidirRetomadaDoPr({ retomadasAnteriores })

  if (decisao.acao === 'escalar') {
    await deps.perguntarAoDono({
      issueNumber: args.issueNumber,
      numeroDoPr: args.pr.number,
      retomadasAnteriores,
    })
    info(
      `[retomada] PR #${args.pr.number} (issue #${args.issueNumber}) já foi retomado ` +
        `${retomadasAnteriores}× e continua reprovado — escalado ao dono`
    )
    return { acao: 'escalou' }
  }

  const resultado = await deps.criarSessaoDev({
    repository: args.repository,
    startingBranch: args.pr.headRef,
    workingBranch: args.pr.headRef,
    titulo: `Retomada do PR #${args.pr.number} (issue #${args.issueNumber})`,
    prompt: montarPromptDeRetomada({ numeroDoPr: args.pr.number, parecerDoQa: args.parecerDoQa }),
  })

  if (resultado.situacao !== 'criada') {
    const motivo = resultado.situacao === 'falhou' ? resultado.motivo : 'recurso do dev desligado'
    warn(`[retomada] não deu para retomar o PR #${args.pr.number}: ${motivo}`)
    return { acao: 'nao-retomou', motivo }
  }

  await deps.registrarSessaoRetomada({
    issueNumber: args.issueNumber,
    sessionName: resultado.sessionName,
    prNumber: args.pr.number,
  })
  info(
    `[retomada] sessão ${args.sessaoAnterior.sessionName} fechada; PR #${args.pr.number} ` +
      `(issue #${args.issueNumber}) retomado na sessão ${resultado.sessionName} — mesma branch`
  )
  return { acao: 'retomou', sessionName: resultado.sessionName }
}
