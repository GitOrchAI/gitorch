import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  type RaAvaliacaoDeLogicaAlternativaForm,
  type PoViabilidadeDeLogicaAlternativaForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import { textoDaRespostaAoDev, type DestinoDaDuvida } from './duvida-do-dev.js'
import {
  montarContextoExecutivoDaPergunta,
  type ContextoExecutivoDaPergunta,
  type DepsDoContextoExecutivo,
  type ArgsDoContextoExecutivo,
} from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { StepExecutor } from './role-rails.js'
import type { DuvidaRailsMissionResult } from './duvida-rails-mission.js'

/**
 * DJ-T9 (D76, 14/09) — palavras do dono: "Jules tem dúvida? é o GitOrch que
 * responde. Se o Jules pensou numa lógica alternativa que muda o cenário, PO
 * e RA analisam se é viável; se não for, mantém a lógica inicial; se fizer
 * sentido, tira dúvida comigo."
 *
 * Este módulo é o degrau ENTRE `duvida-rails-mission.ts` (onde o Jules pode
 * sinalizar `mudaCenarioDeNegocio=true` ao responder uma dúvida — ver
 * `RAILS_SCHEMAS.devQuestion`) e a decisão final:
 *
 *   1. `avaliarViabilidadeDaLogicaAlternativa` — RA entende o impacto
 *      técnico, PO decide viável/inviável. MESMO padrão de dois passos de
 *      `analise-causa-de-infra.ts` (RA analisa, PO decide) — nunca inventado
 *      aqui. `execute` é o MESMO `StepExecutor` de todo passo de trilhos: se
 *      o motor não tiver cota, `runFormStep`/`execute` lança e a exceção
 *      SOBE sem ser capturada por este módulo — o MESMO
 *      `executeMissionWithFailover` (scheduler.ts) que já trata cota para
 *      qualquer missão (DJ-T4/D75) cuida de dormir a missão até o motor
 *      voltar. Nada de mecanismo de espera novo: reaproveitar É não
 *      capturar.
 *   2. Inviável: `respostaMantendoLogicaOriginal` devolve o MESMO caminho de
 *      resposta ao dev que `duvida-rails-mission.ts` já usa
 *      (`textoDaRespostaAoDev`) — a lógica original segue valendo, o motivo
 *      fica só no comentário/log, o dono nunca é acordado (mesma disciplina
 *      de `escalarDuvidaAoDono`, D75: falha/decisão do time nunca vira
 *      `agent_question`).
 *   3. Viável: `montarPerguntaSobreLogicaAlternativa` monta a pergunta ao
 *      dono no MESMO formato executivo de D73
 *      (`montarContextoExecutivoDaPergunta`) com 3 opções objetivas + "Vou
 *      escrever" (D71/D72, `aviso-de-custo-da-ordem.ts`) — NUNCA um formato
 *      novo. O disparo real (`perguntarAoDonoSobreLogicaAlternativa`, que
 *      chama `agentQuestion.ask`) é uma função à parte: PORTÃO 5B, item 7.6
 *      (side effect externo só com autorização explícita de quem despacha) —
 *      este módulo apenas CONSTRÓI o fluxo; nenhuma chamada de produção o
 *      invoca ainda.
 */

export interface AvaliarViabilidadeArgs {
  /** O resumo que o Jules (via QA) escreveu da lógica alternativa. */
  resumoDaProposta: string
  /** A pergunta original do dev, para dar contexto ao RA/PO. */
  pergunta: string
  repository: string
  issueNumber: number
  execute: StepExecutor
  contextBlocks: string[]
}

export interface AvaliarViabilidadeResult {
  viavel: boolean
  motivo: string
  analiseDoRa: RaAvaliacaoDeLogicaAlternativaForm
}

/**
 * Passo 1 (RA) + passo 2 (PO) — decide viável/inviável.
 *
 * NUNCA captura erro de `execute`/`runFormStep`: uma falha de motor (cota
 * esgotada, crash) tem que subir intacta para o failover de scheduler.ts
 * decidir (DJ-T4/D75) — capturar aqui esconderia a cota esgotada atrás de um
 * "inviável" ou de uma pergunta ao dono, exatamente o que D76 proíbe ("não
 * tem cota? aguarda... nunca escala").
 */
export async function avaliarViabilidadeDaLogicaAlternativa(
  args: AvaliarViabilidadeArgs
): Promise<AvaliarViabilidadeResult> {
  const base = [
    ...args.contextBlocks,
    `Dúvida original do dev assíncrono (tarefa #${args.issueNumber} de ${args.repository}):`,
    args.pergunta,
    '',
    `Lógica alternativa proposta (resumo): ${args.resumoDaProposta}`,
  ]

  const analiseDoRa = (await runFormStep({
    schema: RAILS_SCHEMAS.raAvaliacaoDeLogicaAlternativa,
    prompt: buildStepPrompt(
      'ra',
      'ra-avaliacao-logica-alternativa',
      RAILS_SCHEMAS.raAvaliacaoDeLogicaAlternativa,
      [
        ...base,
        'O dev assíncrono, respondendo a uma dúvida, propôs uma lógica ALTERNATIVA que mudaria o ' +
          'que o produto entrega (não é mais só "como resolver a dúvida técnica"). Avalie o IMPACTO ' +
          'TÉCNICO real desta proposta lendo o repositório — nunca invente. `riscoOuGanho` é o que se ' +
          'perde ou se ganha adotando a proposta em vez da lógica original.',
      ]
    ),
    execute: args.execute,
  })) as RaAvaliacaoDeLogicaAlternativaForm

  const decisaoDoPo = (await runFormStep({
    schema: RAILS_SCHEMAS.poViabilidadeDeLogicaAlternativa,
    prompt: buildStepPrompt(
      'po',
      'po-viabilidade-logica-alternativa',
      RAILS_SCHEMAS.poViabilidadeDeLogicaAlternativa,
      [
        ...base,
        `Análise do RA — impacto técnico: ${analiseDoRa.impactoTecnico}`,
        `Análise do RA — risco/ganho: ${analiseDoRa.riscoOuGanho}`,
        'Decida: esta lógica alternativa é VIÁVEL (vale a pena levar ao dono como decisão de ' +
          'negócio) ou INVIÁVEL (a lógica original do produto já resolve melhor, ou o ganho não ' +
          'compensa o risco)? `motivo` explica a decisão em uma frase objetiva.',
      ]
    ),
    execute: args.execute,
  })) as PoViabilidadeDeLogicaAlternativaForm

  return {
    viavel: decisaoDoPo.decisao === 'viavel',
    motivo: decisaoDoPo.motivo,
    analiseDoRa,
  }
}

export interface RespostaMantendoLogicaOriginal {
  /** Pronto para `responderSessaoJules` — o MESMO texto que já existia. */
  mensagemParaODev: string
  /** Texto para log/comentário — NUNCA chega ao dono (D76: inviável não escala). */
  comentario: string
}

/**
 * Caminho INVIÁVEL — reaproveita `textoDaRespostaAoDev`
 * (duvida-do-dev.ts, o MESMO texto que `duvida-rails-mission.ts` já manda
 * para a sessão do dev), mantendo a lógica original. `comentario` registra o
 * motivo só para quem olhar o log depois — SEM chegar ao dono, mesma
 * disciplina de `escalarDuvidaAoDono` (D75).
 */
export function respostaMantendoLogicaOriginal(args: {
  respostaOriginal: string
  motivoDaInviabilidade: string
}): RespostaMantendoLogicaOriginal {
  return {
    mensagemParaODev: textoDaRespostaAoDev(args.respostaOriginal),
    comentario:
      'GitOrch: lógica alternativa proposta pelo dev avaliada pelo PO+RA e considerada inviável — ' +
      `mantida a lógica original (${args.motivoDaInviabilidade})`,
  }
}

export type ResultadoDaLogicaAlternativa =
  | ({ tipo: 'mantida-logica-original' } & RespostaMantendoLogicaOriginal)
  | { tipo: 'pronta-para-o-dono'; motivoDaViabilidade: string; resumoDaProposta: string }

/**
 * Junta os dois passos (avaliação + desfecho) — o que quem processa a dúvida
 * do Jules chama quando `mudaCenarioDeNegocio=true`
 * (`duvida-rails-mission.ts`).
 *
 * NUNCA captura erro de `avaliarViabilidadeDaLogicaAlternativa` (ver o
 * comentário lá): sem cota, a exceção sobe intacta — o desfecho
 * 'pronta-para-o-dono'/'mantida-logica-original' só existe quando a
 * viabilidade de fato rodou até o fim.
 */
export async function resolverLogicaAlternativaDoJules(
  args: AvaliarViabilidadeArgs & { respostaOriginal: string }
): Promise<ResultadoDaLogicaAlternativa> {
  const avaliacao = await avaliarViabilidadeDaLogicaAlternativa(args)

  if (!avaliacao.viavel) {
    return {
      tipo: 'mantida-logica-original',
      ...respostaMantendoLogicaOriginal({
        respostaOriginal: args.respostaOriginal,
        motivoDaInviabilidade: avaliacao.motivo,
      }),
    }
  }

  return {
    tipo: 'pronta-para-o-dono',
    motivoDaViabilidade: avaliacao.motivo,
    resumoDaProposta: args.resumoDaProposta,
  }
}

export interface DecidirDestinoAposLogicaAlternativaArgs {
  /** O resultado bruto de `runDuvidaMissionViaRails` (duvida-rails-mission.ts). */
  resultadoDaDuvida: DuvidaRailsMissionResult
  /** A pergunta original do dev — repassada ao RA/PO para dar contexto. */
  pergunta: string
  repository: string
  issueNumber: number
  execute: StepExecutor
  contextBlocks: string[]
  /** Injetável para teste; produção nunca passa nada — cai no
   *  `resolverLogicaAlternativaDoJules` real (mesmo padrão de
   *  `buscarConversa` em `escalar-duvida-ao-dono.ts`). */
  resolver?: typeof resolverLogicaAlternativaDoJules
}

export interface DestinoFinalDaDuvida {
  destino: DestinoDaDuvida
  mensagemParaODev: string | null
}

/**
 * DJ-T9 (D76, 14/09) — o degrau que FECHA o gap encontrado nesta tarefa: até
 * aqui, `resolverLogicaAlternativaDoJules`/`avaliarViabilidadeDaLogicaAlternativa`
 * existiam prontos mas não eram chamados de lugar nenhum em produção — o
 * critério de aceite ("nenhuma dúvida do dev muda o cenário de negócio sem
 * passar por PO+RA com viabilidade registrada") ficava sem encanamento real.
 *
 * `scheduler.ts` (`responderDuvidaPendente`) chama esta função logo após
 * `runDuvidaMissionViaRails`, ANTES de decidir o destino final da dúvida:
 *
 *  - `mudaCenarioDeNegocio=false` (o caso comum, e o único que existia antes
 *    desta tarefa): devolve `destino`/`mensagemParaODev` de
 *    `resultadoDaDuvida` SEM TOCAR em nada — zero chamada extra, zero custo
 *    de motor a mais. É o mesmo comportamento de sempre.
 *  - `mudaCenarioDeNegocio=true`: chama `resolverLogicaAlternativaDoJules`
 *    (RA analisa, PO decide) e usa o desfecho dela para decidir o destino
 *    FINAL, substituindo o que `resultadoDaDuvida` trazia:
 *      - inviável: mantém a lógica original — a mensagem final é a que
 *        `respostaMantendoLogicaOriginal` formou (mesmo texto de sempre,
 *        via `textoDaRespostaAoDev`); o destino original é preservado
 *        (nunca vira `perguntar-ao-dono`, nunca chega em
 *        `escalarDuvidaAoDono`).
 *      - viável: o destino final passa a ser `perguntar-ao-dono` — o MESMO
 *        caminho que `scheduler.ts` já usa para chamar `escalarDuvidaAoDono`
 *        (D75, já sujeito à autorização de side effect existente lá).
 *        Nenhum envio novo é inventado aqui.
 *
 * NÃO duplica a checagem de cota: `resolverLogicaAlternativaDoJules` (e
 * `avaliarViabilidadeDaLogicaAlternativa` por trás dela) NUNCA captura erro
 * de `execute`/`runFormStep` — uma falha de motor sobe intacta através desta
 * função também, para o MESMO `executeMissionWithFailover` (scheduler.ts)
 * que já cuida de cota para qualquer papel (DJ-T4/D75) assumir.
 *
 * `respostaOriginal` (o que `resolverLogicaAlternativaDoJules` precisa para
 * formar a resposta do caminho inviável) só existe de verdade quando o QA
 * conseguiu responder tecnicamente (`destino.tipo === 'responder-o-dev'`) —
 * é o cenário comum descrito pelo dono ("o Jules, respondendo a uma dúvida,
 * propôs uma lógica alternativa"). Quando o destino original é outro (QA não
 * soube responder, ou já era decisão de negócio), não existe resposta
 * original para "manter" — passa string vazia, nunca inventa texto.
 */
export async function decidirDestinoAposLogicaAlternativa(
  args: DecidirDestinoAposLogicaAlternativaArgs
): Promise<DestinoFinalDaDuvida> {
  const { resultadoDaDuvida } = args

  if (!resultadoDaDuvida.mudaCenarioDeNegocio) {
    return {
      destino: resultadoDaDuvida.destino,
      mensagemParaODev: resultadoDaDuvida.mensagemParaODev,
    }
  }

  const resolver = args.resolver ?? resolverLogicaAlternativaDoJules
  const respostaOriginal =
    resultadoDaDuvida.destino.tipo === 'responder-o-dev' ? resultadoDaDuvida.destino.resposta : ''

  const resultado = await resolver({
    resumoDaProposta: resultadoDaDuvida.resumoDaProposta as string,
    pergunta: args.pergunta,
    repository: args.repository,
    issueNumber: args.issueNumber,
    execute: args.execute,
    contextBlocks: args.contextBlocks,
    respostaOriginal,
  })

  if (resultado.tipo === 'mantida-logica-original') {
    return {
      destino: resultadoDaDuvida.destino,
      mensagemParaODev: resultado.mensagemParaODev,
    }
  }

  return {
    destino: {
      tipo: 'perguntar-ao-dono',
      motivo:
        'o time encontrou uma lógica alternativa avaliada como viável pelo PO+RA: ' +
        resultado.motivoDaViabilidade,
    },
    mensagemParaODev: null,
  }
}

// --- Caminho VIÁVEL: montar (e, só com autorização explícita, enviar) a pergunta ao dono ---

/** Mesmo padrão de `DEDUP_PREFIXO_CUSTO_DA_ORDEM`/`PREFIXO_DUVIDA_DEV`. */
export const DEDUP_PREFIXO_LOGICA_ALTERNATIVA = 'logica-alternativa:'

/** Monta `logica-alternativa:<repo>:<issueNumber>` — mesmo padrão de
 *  `dedupKeyDeCustoDaOrdem` (aviso-de-custo-da-ordem.ts). */
export function dedupKeyDeLogicaAlternativa(repository: string, issueNumber: number): string {
  return `${DEDUP_PREFIXO_LOGICA_ALTERNATIVA}${repository}:${issueNumber}`
}

export interface OpcaoDeLogicaAlternativa {
  label: string
  value: string
}

export const VALOR_APROVAR_LOGICA_ALTERNATIVA = 'aprovar-logica-alternativa'
export const VALOR_MANTER_LOGICA_ORIGINAL = 'manter-logica-original'
export const VALOR_VER_PROPOSTA_COMPLETA = 'ver-proposta-completa'

/** D71/D72: 3 opções objetivas — o botão de escrever entra à parte (mesmo
 *  padrão de `OPCOES_DE_CUSTO_DA_ORDEM`, aviso-de-custo-da-ordem.ts). */
export const OPCOES_DE_LOGICA_ALTERNATIVA: OpcaoDeLogicaAlternativa[] = [
  { label: 'Aprovar a proposta alternativa', value: VALOR_APROVAR_LOGICA_ALTERNATIVA },
  { label: 'Manter a lógica original', value: VALOR_MANTER_LOGICA_ORIGINAL },
  { label: 'Ver a proposta completa antes de decidir', value: VALOR_VER_PROPOSTA_COMPLETA },
]

/**
 * O texto da pergunta ao dono — MESMA estrutura executiva de D73 (ciclo,
 * entrega, decisões já tomadas, nesta ordem — `texto-de-escalada.ts`) mais a
 * proposta em si e o motivo do PO/RA acharem que vale consultar. Nunca um
 * formato inventado.
 */
export function textoDaPerguntaSobreLogicaAlternativa(args: {
  issueNumber: number
  repository: string
  contexto: ContextoExecutivoDaPergunta
  resumoDaProposta: string
  motivoDaViabilidade: string
}): string {
  const partes: string[] = []
  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)
  if (args.contexto.decisoes.length > 0) {
    partes.push(`A equipe já resolveu sozinha: ${args.contexto.decisoes.join('; ')}.`)
  }
  partes.push(
    `O time encontrou uma lógica alternativa que muda o que a tarefa #${args.issueNumber} de ` +
      `${args.repository} entrega, e o PO/RA avaliaram que vale a pena te consultar: ` +
      `${args.resumoDaProposta}`
  )
  partes.push(`Por que vale consultar: ${args.motivoDaViabilidade}`)
  return partes.join('\n\n')
}

export interface MontarPerguntaSobreLogicaAlternativaResult {
  text: string
  options: OpcaoDeLogicaAlternativa[]
  dedupKey: string
}

/** Monta o payload da pergunta — PURA, sem I/O, testável sem fake de rede. */
export function montarPerguntaSobreLogicaAlternativa(args: {
  issueNumber: number
  repository: string
  contexto: ContextoExecutivoDaPergunta
  resumoDaProposta: string
  motivoDaViabilidade: string
}): MontarPerguntaSobreLogicaAlternativaResult {
  return {
    text: textoDaPerguntaSobreLogicaAlternativa(args),
    options: OPCOES_DE_LOGICA_ALTERNATIVA,
    dedupKey: dedupKeyDeLogicaAlternativa(args.repository, args.issueNumber),
  }
}

/** Só o que `perguntarAoDonoSobreLogicaAlternativa` precisa de
 *  `AgentQuestionService.ask` — mesmo padrão de
 *  `AgentQuestionAskerDeCustoDaOrdem`. */
export interface AgentQuestionAskerDeLogicaAlternativa {
  ask: (
    userId: string,
    projectId: string,
    input: { text: string; options?: OpcaoDeLogicaAlternativa[]; dedupKey?: string }
  ) => Promise<unknown>
}

export interface PerguntarAoDonoSobreLogicaAlternativaArgs {
  userId: string
  projectId: string
  issueNumber: number
  repository: string
  resumoDaProposta: string
  motivoDaViabilidade: string
  contextoArgs: ArgsDoContextoExecutivo
}

/**
 * Função/fluxo COMPLETO do caminho VIÁVEL — monta o contexto executivo
 * (D73), monta a pergunta (D71/D72) e chama `agentQuestion.ask`.
 *
 * PORTÃO 5B, item 7.6 (03/09/2026): side effect externo (mensagem real ao
 * dono) só com autorização explícita de quem despacha a tarefa. Este módulo
 * apenas CONSTRÓI o fluxo — nenhuma chamada de produção invoca esta função
 * ainda; ela existe pronta para a tarefa que ligar o disparo real ao
 * scheduler, com `deps.agentQuestion`/`deps.montarContextoExecutivo`
 * injetáveis (mesmo padrão de `perguntarSobreCustoDaOrdem`,
 * aviso-de-custo-da-ordem.ts).
 */
export async function perguntarAoDonoSobreLogicaAlternativa(
  args: PerguntarAoDonoSobreLogicaAlternativaArgs,
  deps: {
    agentQuestion: AgentQuestionAskerDeLogicaAlternativa
    montarContextoExecutivo: typeof montarContextoExecutivoDaPergunta
    depsDoContexto: DepsDoContextoExecutivo
  }
): Promise<void> {
  const contexto = await deps.montarContextoExecutivo(args.contextoArgs, deps.depsDoContexto)
  const pergunta = montarPerguntaSobreLogicaAlternativa({
    issueNumber: args.issueNumber,
    repository: args.repository,
    contexto,
    resumoDaProposta: args.resumoDaProposta,
    motivoDaViabilidade: args.motivoDaViabilidade,
  })
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: pergunta.text,
    options: [...pergunta.options, buildFreeTextOption()],
    dedupKey: pergunta.dedupKey,
  })
}
