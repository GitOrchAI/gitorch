import type { F6AgentRole, F6AgentRuntime } from '@gitorch/agents'
import { esforcoValidoNoMotor, COMO_O_MOTOR_EXPRESSA_ESFORCO } from './esforco-por-motor.js'

/**
 * O PADRÃO DE QUEM NUNCA ESCOLHEU — escrito, justificado, e resolvido contra o
 * catálogo vivo.
 *
 * O QUE HAVIA ANTES, e por que era errado de duas maneiras ao mesmo tempo:
 * `MODEL_BY_ROLE` (scheduler.ts) era `po: Pro, ra/sm/qa: Flash` — dois níveis
 * para quatro papéis, e os nomes eram literais do Antigravity aplicados a
 * QUALQUER motor. Medido ao vivo em 01/09/2026: rodando o resolvedor com esses
 * padrões, os três degraus da cadeia vinham com `Gemini 3.7 Flash (Medium)`, e
 * `claude --model "Gemini 3.7 Flash (Medium)"` responde "There's an issue with
 * the selected model". O degrau de reserva estava morto na chegada.
 *
 * ── A EXIGÊNCIA É DO PAPEL, e cada papel pede coisa diferente ───────────────
 * O trabalho dos quatro agentes não tem o mesmo peso, então cobrar o mesmo
 * modelo dos quatro é errar dos dois lados: paga-se caro onde não precisa e
 * entrega-se julgamento a modelo fraco.
 *
 *   po    → FORTE.  Decide o roadmap e escreve a issue que vira o trabalho de
 *                   todo mundo. Um erro dele se multiplica pelos outros três.
 *   ra    → MÉDIO.  Analisa repositório e desejo e produz o diagnóstico. É o
 *                   papel de maior VOLUME, e a saída dele ainda passa pelo PO
 *                   e pelo QA — tem quem corrija.
 *   sm    → BARATO. Move card, abre e fecha PR, cutuca o dev assíncrono. Não
 *                   julga nada; erro aqui é visível na hora e barato de
 *                   desfazer.
 *   qa    → FORTE.  JULGA: aprova ou reprova o PR, dá a nota. É o último
 *                   portão antes do merge, e um julgamento fraco deixa defeito
 *                   passar para produção. Era exatamente o papel que rodava no
 *                   mesmo modelo barato do sm.
 *
 * ── POR QUE FAMÍLIA, E NUNCA GERAÇÃO ───────────────────────────────────────
 * O padrão nomeia a FAMÍLIA (`opus`, `haiku`, `pro`, `flash`, `mini`), nunca a
 * geração (`Opus 5`, `Gemini 3.7`). A geração é justamente a parte que o
 * provedor derruba sem avisar — a `Gemini 3.5 Flash` morreu em menos de sete
 * horas no meio do dia 31/08 e levou 24 missões junto. A família sobrevive às
 * trocas: "opus é o grande, haiku é o pequeno" continua valendo depois de cada
 * lançamento. Escrever a geração aqui seria plantar o próximo literal morto.
 *
 * Por isso a família é resolvida contra o CATÁLOGO VIVO daquele cliente, e o
 * candidato escolhido é o do topo da lista — os três coletores entregam do
 * mais novo para o mais velho (`agy models`, `/v1/models` da Anthropic,
 * `models_cache.json` do Codex).
 *
 * ── E QUANDO NÃO DÁ PARA SABER ─────────────────────────────────────────────
 * Sem catálogo, ou com um catálogo onde nenhuma família conhecida aparece, o
 * padrão devolve modelo `undefined` — que neste produto quer dizer "rode sem
 * `--model`, com o modelo padrão do próprio motor". Nunca um palpite nosso.
 */

export type ExigenciaDoPapel = 'forte' | 'medio' | 'barato'

export const EXIGENCIA_DO_PAPEL: Readonly<Record<F6AgentRole, ExigenciaDoPapel>> = Object.freeze({
  po: 'forte',
  ra: 'medio',
  sm: 'barato',
  qa: 'forte',
})

/** O esforço que cada exigência pede, nos motores onde ele é separável. */
const ESFORCO_DA_EXIGENCIA: Readonly<Record<ExigenciaDoPapel, string>> = Object.freeze({
  forte: 'high',
  medio: 'medium',
  barato: 'low',
})

/**
 * As FAMÍLIAS de cada motor, por exigência, em ordem de preferência. Casadas
 * por trecho do nome, em minúsculas — é o que sobrevive à troca de geração.
 *
 * No antigravity a lista casa o nome COM o sufixo de esforço, porque lá o
 * esforço não é separável (ver esforco-por-motor.ts: `--effort` junto de
 * `--model` é erro duro do CLI). Escolher a exigência ali É escolher a
 * variante do nome.
 */
const FAMILIAS_DO_MOTOR: Readonly<
  Record<F6AgentRuntime, Readonly<Record<ExigenciaDoPapel, readonly string[]>>>
> = Object.freeze({
  claude: Object.freeze({
    forte: Object.freeze(['opus']),
    medio: Object.freeze(['sonnet']),
    barato: Object.freeze(['haiku']),
  }),
  codex: Object.freeze({
    // O Codex tem só dois modelos de trabalho: o cheio e o Mini. 'forte' e
    // 'medio' caem no mesmo, e está certo — inventar um terceiro nível onde o
    // motor tem dois seria fingir escolha que não existe.
    forte: Object.freeze(['gpt-5', 'gpt']),
    medio: Object.freeze(['gpt-5', 'gpt']),
    barato: Object.freeze(['mini']),
  }),
  antigravity: Object.freeze({
    forte: Object.freeze(['pro (high)']),
    medio: Object.freeze(['flash (medium)']),
    barato: Object.freeze(['flash (low)']),
  }),
})

/**
 * O Codex publica um modelo que NÃO é para rodar missão: `Codex Auto Review` é
 * o revisor automático do produto deles. Ele aparece no catálogo (e portanto
 * na tela), mas escolhê-lo como padrão de um papel seria mandar o agente
 * trabalhar dentro de outra ferramenta.
 */
const NAO_SERVE_DE_PADRAO = /auto review/i

export interface DegrauPadrao {
  /** `undefined` = rode sem `--model`, com o modelo padrão do próprio motor. */
  model?: string
  /** `undefined` nos motores sem esforço separável (ver antigravity). */
  effort?: string
}

export function padraoDoDegrau(args: {
  role: F6AgentRole
  runtime: string
  catalogo: readonly string[]
}): DegrauPadrao {
  const exigencia = EXIGENCIA_DO_PAPEL[args.role]
  const familiasPorExigencia = (
    FAMILIAS_DO_MOTOR as Record<
      string,
      Readonly<Record<ExigenciaDoPapel, readonly string[]>> | undefined
    >
  )[args.runtime]
  if (!familiasPorExigencia) return {}

  const candidatos = args.catalogo.filter(
    (m) => typeof m === 'string' && m.trim().length > 0 && !NAO_SERVE_DE_PADRAO.test(m)
  )

  let model: string | undefined
  for (const familia of familiasPorExigencia[exigencia]) {
    const achado = candidatos.find((m) => m.toLowerCase().includes(familia))
    if (achado) {
      model = achado
      break
    }
  }

  // O esforço só entra onde o motor de fato o separa do modelo. No antigravity
  // ele já está dentro do nome escolhido acima.
  const nivel = ESFORCO_DA_EXIGENCIA[exigencia]
  const separavel =
    (COMO_O_MOTOR_EXPRESSA_ESFORCO as Record<string, string | undefined>)[args.runtime] !==
    'no-nome-do-modelo'
  const effort = separavel && esforcoValidoNoMotor(args.runtime, nivel) ? nivel : undefined

  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  }
}
