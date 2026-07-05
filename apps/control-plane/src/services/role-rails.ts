import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  type RaBriefForm,
  type PoPhasesForm,
  type PoEpicsForm,
  type PoBacklogForm,
  type PoSprintForm,
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

/** Roteiro do RA: um passo — o Research Brief estruturado. */
export async function runRaRails(
  execute: StepExecutor,
  contextBlocks: string[]
): Promise<RaBriefForm> {
  const prompt = buildStepPrompt('ra', 'ra-brief', RAILS_SCHEMAS.raBrief, contextBlocks)
  return (await runFormStep({ schema: RAILS_SCHEMAS.raBrief, prompt, execute })) as RaBriefForm
}

export interface PoRailsInput {
  wish: IssueRef
  wishText: string
  contextBlocks: string[]
}

/**
 * Roteiro do PO: 4 passos encadeados (fases → épicos → backlog → sprint).
 * Cada passo vê as decisões anteriores como contexto — a LLM nunca precisa
 * segurar o plano inteiro numa resposta só (modelos fracos aguentam).
 */
export async function runPoRails(execute: StepExecutor, input: PoRailsInput): Promise<BacklogPlan> {
  const base = [`Wish (the client's desire): ${input.wishText}`, ...input.contextBlocks]

  const phases = (await runFormStep({
    schema: RAILS_SCHEMAS.poPhases,
    prompt: buildStepPrompt('po', 'po-phases', RAILS_SCHEMAS.poPhases, [
      ...base,
      'Decide the PHASES (major milestones) that turn this wish into reality. Few and well-justified.',
    ]),
    execute,
  })) as PoPhasesForm

  const phasesBlock = `Phases you decided:\n${phases.phases
    .map((p, i) => `${i}. ${p.title} — goal: ${p.goal}`)
    .join('\n')}`

  const epics = (await runFormStep({
    schema: RAILS_SCHEMAS.poEpics,
    prompt: buildStepPrompt('po', 'po-epics', RAILS_SCHEMAS.poEpics, [
      ...base,
      phasesBlock,
      'Break each phase into EPICS (phaseIndex refers to the list above).',
    ]),
    execute,
  })) as PoEpicsForm

  const epicsBlock = `Epics you decided:\n${epics.epics
    .map((e, i) => `${i}. [phase ${e.phaseIndex}] ${e.title}`)
    .join('\n')}`

  const backlog = (await runFormStep({
    schema: RAILS_SCHEMAS.poBacklog,
    prompt: buildStepPrompt('po', 'po-backlog', RAILS_SCHEMAS.poBacklog, [
      ...base,
      phasesBlock,
      epicsBlock,
      'Write the FEATURES and TASKS (epicIndex refers to the list above; tasks may set parentFeatureIndex). Every item MUST carry the complete 8-field DoD — incomplete items are rejected by code.',
      // O leitor destas issues é um dev assíncrono SEM nosso contexto (Jules e
      // similares): o corpo da issue é tudo que ele tem. Padrões do
      // jules-awesome-list + reuse-first (não sair criando: reutilizar).
      [
        'These items will be executed by an async dev agent that has NO context beyond the issue body. Write for that reader:',
        '- Related Files: REAL repository paths copied verbatim from the codegraph context above — never invent a path. If no listed file fits, name the directory to explore and say why.',
        '- Implementation Guide: numbered steps at file level, each stating the from→to change (e.g. "in src/cart.ts, extract the shipping rule into..."), naming the stack/framework involved.',
        '- REUSE FIRST: name the existing helper/module/pattern to extend. Only propose a new file when nothing existing fits, and justify that in Notes.',
        '- ONE focused change per task — never mix unrelated work. Prefer FEWER, denser tasks over many vague ones.',
        '- Verification Criteria: concrete checks a reviewer can execute (commands, URLs, expected behavior) — not restatements of the title.',
      ].join('\n'),
    ]),
    execute,
  })) as PoBacklogForm

  const backlogBlock = `Backlog items you decided:\n${backlog.items
    .map((it, i) => `${i}. [${it.kind}] ${it.fields.titulo}`)
    .join('\n')}`

  const sprint = (await runFormStep({
    schema: RAILS_SCHEMAS.poSprint,
    prompt: buildStepPrompt('po', 'po-sprint', RAILS_SCHEMAS.poSprint, [
      ...base,
      backlogBlock,
      'Sprint Planning: select the item indexes that are truly ready and write ONE Sprint Goal (a single sentence of outcome).',
    ]),
    execute,
  })) as PoSprintForm

  return {
    wish: input.wish,
    phases: phases.phases,
    epics: epics.epics,
    items: backlog.items,
    sprint,
  }
}
