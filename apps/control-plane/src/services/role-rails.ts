import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  formatRaDeliverable,
  wrapClientRequest,
  type RaAreasForm,
  type RaJourneysForm,
  type RaBriefForm,
  type RaDeliverable,
  type PoPhasesForm,
  type PoEpicsForm,
  type PoFeaturesForm,
  type PoTasksForm,
  type PoRoadmapForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { BacklogPlan, IssueRef } from './backlog-executor.js'

// Role-rails: os ROTEIROS por papel da Lei "LLM decide, sistema executa".
// Cada roteiro é uma sequência de passos pequenos; o executor de motor
// (StepExecutor) é injetado — em produção é o RuntimeAdapter containerizado,
// nos testes é um fake. Nenhum passo age no GitHub: os formulários validados
// viram um BacklogPlan que o backlog-executor aplica.

/** Executa o motor com um prompt e devolve o texto cru da resposta. */
export type StepExecutor = (prompt: string) => Promise<string>

/**
 * Roteiro do RA: 3 passos encadeados — áreas → jornadas → brief. A profundidade
 * é FORÇADA por schema (>=2 jornadas com >=3 passos cada; toda área cita
 * arquivos reais): o RA pensa como quem conhece o produto, não como um dev
 * genérico. O entregável formatado vira memória e é o contexto do PO.
 */
export async function runRaRails(
  execute: StepExecutor,
  contextBlocks: string[]
): Promise<{ deliverable: RaDeliverable; text: string }> {
  const areas = (await runFormStep({
    schema: RAILS_SCHEMAS.raAreas,
    prompt: buildStepPrompt('ra', 'ra-areas', RAILS_SCHEMAS.raAreas, [
      ...contextBlocks,
      'Map WHERE this project/wish touches the system. For EACH area that applies (frontend, backend, database, integrations, infra...): what exists today, what the wish needs there, and the REAL file paths to read (verbatim from the codegraph above — never invent). Do not skip integrations: existing integrations are opportunity goldmines.',
    ]),
    execute,
  })) as RaAreasForm

  const areasBlock = `Areas you mapped:\n${areas.areas
    .map((a) => `- ${a.area}: ${a.whatTheWishNeedsHere} (files: ${a.filesToRead.join(', ')})`)
    .join('\n')}`

  const journeys = (await runFormStep({
    schema: RAILS_SCHEMAS.raJourneys,
    prompt: buildStepPrompt('ra', 'ra-journeys', RAILS_SCHEMAS.raJourneys, [
      ...contextBlocks,
      areasBlock,
      'Think like the OWNER of this product, not a generic dev. Write AT LEAST 2 complete step-by-step journeys: (1) the end-user side — how a real person lives this wish end to end (browsing, email, login, posting, edge moments); (2) the data/integrations side — what existing systems or marketplaces the codebase ALREADY touches that this wish can leverage (e.g. reviews that already exist on connected platforms). Each journey: actor, ordered steps, and the insight/opportunity it reveals. More journeys are welcome when the wish deserves them.',
    ]),
    execute,
  })) as RaJourneysForm

  const journeysBlock = `Journeys you wrote:\n${journeys.journeys
    .map((j, i) => `${i}. ${j.title} — insight: ${j.insight}`)
    .join('\n')}`

  const brief = (await runFormStep({
    schema: RAILS_SCHEMAS.raBrief,
    prompt: buildStepPrompt('ra', 'ra-brief', RAILS_SCHEMAS.raBrief, [
      ...contextBlocks,
      areasBlock,
      journeysBlock,
      'Write the final Research Brief for the PO, grounded in the areas and journeys above.',
    ]),
    execute,
  })) as RaBriefForm

  const deliverable: RaDeliverable = { areas: areas.areas, journeys: journeys.journeys, brief }
  return { deliverable, text: formatRaDeliverable(deliverable) }
}

export interface PoRailsInput {
  wish: IssueRef
  wishText: string
  contextBlocks: string[]
  /** Quantas jornadas o RA escreveu (para exigir cobertura); 0 = sem RA ainda. */
  journeysCount?: number
}

// Exigências de escrita para o dev assíncrono (Jules e similares): o corpo da
// issue é TUDO que ele tem — padrões do jules-awesome-list + reuse-first.
const TASK_WRITING_RULES = [
  'These tasks will be executed by an async dev agent that has NO context beyond the issue body. Write for that reader:',
  '- Related Files: REAL repository paths copied verbatim from the codegraph context above — never invent a path. If no listed file fits, name the directory to explore and say why.',
  '- Implementation Guide: numbered steps at file level, each stating the from→to change (e.g. "in src/cart.ts, extract the shipping rule into..."), naming the stack/framework involved.',
  '- REUSE FIRST: name the existing helper/module/pattern to extend. Only propose a new file when nothing existing fits, and justify that in Notes.',
  '- ONE focused change per task — never mix unrelated work. Prefer FEWER, denser tasks over many vague ones.',
  '- Verification Criteria: concrete checks a reviewer can execute (commands, URLs, expected behavior) — not restatements of the title.',
].join('\n')

/**
 * Roteiro do PO: 5 passos encadeados (fases → épicos → features → tasks →
 * roadmap). Cada passo vê as decisões anteriores como contexto — a LLM nunca
 * segura o plano inteiro numa resposta só (modelos fracos aguentam). A
 * hierarquia completa (fase/épico/feature/task) + sprints numeradas é o que
 * deixa o cliente saber em qual fase está e o que sai quando — SCRUM de
 * verdade, não um saco de tasks.
 */
export async function runPoRails(execute: StepExecutor, input: PoRailsInput): Promise<BacklogPlan> {
  // Item 6 (leva B2): `input.wishText` carrega o texto livre do cliente
  // (título+corpo da issue do desejo) — nunca uma instrução ao PO.
  // `wrapClientRequest` marca isso explicitamente, no MESMO bloco que todo
  // passo do PO recebe (`base`, abaixo).
  const base = [
    `Wish (the client's desire): ${wrapClientRequest(input.wishText)}`,
    ...input.contextBlocks,
  ]

  const phases = (await runFormStep({
    schema: RAILS_SCHEMAS.poPhases,
    prompt: buildStepPrompt('po', 'po-phases', RAILS_SCHEMAS.poPhases, [
      ...base,
      'Decide the PHASES (major delivery milestones) that turn this wish into reality, in order. Each phase is something the client can SEE finished. Cover the whole scope the RA journeys reveal — a wish that touches user experience AND data/integrations rarely fits one phase.',
    ]),
    execute,
  })) as PoPhasesForm

  const phasesBlock = `Phases you decided:\n${phases.phases
    .map((p, i) => `${i}. ${p.title} — goal: ${p.goal}`)
    .join('\n')}`

  const journeysNote =
    input.journeysCount && input.journeysCount > 0
      ? `The RA wrote ${input.journeysCount} journey(s) (indexes 0..${input.journeysCount - 1} in the context above). EVERY journey must be covered by at least one epic (journeyIndexes) — plans that ignore a journey are rejected by code.`
      : 'No RA journeys available: set journeyIndexes to [] on every epic.'

  const epics = (await runFormStep({
    schema: RAILS_SCHEMAS.poEpics,
    prompt: buildStepPrompt('po', 'po-epics', RAILS_SCHEMAS.poEpics, [
      ...base,
      phasesBlock,
      `Break each phase into EPICS (phaseIndex refers to the list above). ${journeysNote}`,
    ]),
    execute,
  })) as PoEpicsForm

  const epicsBlock = `Epics you decided:\n${epics.epics
    .map((e, i) => `${i}. [phase ${e.phaseIndex}] ${e.title}`)
    .join('\n')}`

  const features = (await runFormStep({
    schema: RAILS_SCHEMAS.poFeatures,
    prompt: buildStepPrompt('po', 'po-features', RAILS_SCHEMAS.poFeatures, [
      ...base,
      phasesBlock,
      epicsBlock,
      'Break each epic into FEATURES (epicIndex refers to the list above): a feature is a capability the user/system gains, not a code chore. Every epic needs at least one feature.',
    ]),
    execute,
  })) as PoFeaturesForm

  const featuresBlock = `Features you decided:\n${features.features
    .map((f, i) => `${i}. [epic ${f.epicIndex}] ${f.title}`)
    .join('\n')}`

  const tasks = (await runFormStep({
    schema: RAILS_SCHEMAS.poTasks,
    prompt: buildStepPrompt('po', 'po-tasks', RAILS_SCHEMAS.poTasks, [
      ...base,
      phasesBlock,
      epicsBlock,
      featuresBlock,
      'Write the TASKS for every feature (featureIndex refers to the list above). Every feature needs at least one task; every task MUST carry the complete 8-field DoD — incomplete tasks are rejected by code. Use blockedByTaskIndexes for real dependencies (earlier tasks only).',
      TASK_WRITING_RULES,
    ]),
    execute,
  })) as PoTasksForm

  // O PESO entra no bloco que alimenta o roadmap: distribuir sprint sem saber
  // o tamanho de cada task é chutar. Coletar o peso e não usar seria pior que
  // não coletar.
  const tasksBlock = `Tasks you decided:\n${tasks.tasks
    .map((t, i) => `${i}. [feature ${t.featureIndex}] (weight ${t.weight}) ${t.fields.titulo}`)
    .join('\n')}`

  const roadmap = (await runFormStep({
    schema: RAILS_SCHEMAS.poRoadmap,
    prompt: buildStepPrompt('po', 'po-roadmap', RAILS_SCHEMAS.poRoadmap, [
      ...base,
      phasesBlock,
      tasksBlock,
      'ROADMAP: assign EVERY task above to a numbered sprint (1..N) respecting dependencies (a task never lands before its blockers) AND the weight shown next to each task — do not stack a sprint with far more weight than the others. Sprint 1 is what starts now — write its Sprint Goal as ONE sentence of client-visible outcome. The client will see this as dated milestones.',
    ]),
    execute,
  })) as PoRoadmapForm

  return {
    wish: input.wish,
    journeysCount: input.journeysCount ?? 0,
    phases: phases.phases,
    epics: epics.epics,
    features: features.features,
    tasks: tasks.tasks,
    roadmap,
  }
}
