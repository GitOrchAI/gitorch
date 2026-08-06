// Cadence Rails: os TRILHOS do modelo "LLM decide, sistema executa"
// (docs/agents/cadence-execution-model.md). Aqui vivem os FORMULÁRIOS (schemas)
// que a LLM preenche por passo de roteiro e os utilitários determinísticos que
// o control plane usa para validar. NENHUM prompt aqui instrui ação no GitHub —
// quem age é o executor do control plane.

import { loadPlaybook, type CadenceRole, ISSUE_DOD_FIELDS } from './index'

// ---------------------------------------------------------------------------
// Formulários (tipos + JSON Schema minimal — sem dependência externa)
// ---------------------------------------------------------------------------

/**
 * Padrão Shrimp — o contrato OFICIAL da issue, decidido pelo dono do produto e
 * o mesmo que a documentação do RA e do SM já exigiam.
 *
 * Antes o código publicava outro conjunto (Description/Summary/Analysis
 * Result): a issue criada pelo próprio produto não passava na conferência de
 * padrão que o SM aplica, porque documentação e runtime discordavam.
 *
 * `titulo` é o título da issue, não uma seção do corpo — por isso fica fora
 * do mapa de seções abaixo.
 */
export interface DoDFields {
  titulo: string
  goal: string
  taskDetails: string
  taskDescription: string
  implementationGuide: string
  verificationCriteria: string
  dependencies: string
  relatedFiles: string
  notes: string
}

/**
 * Fonte ÚNICA do DoD: chave camelCase do formulário ↔ cabeçalho canônico da
 * issue. Schema, validação e renderização derivam DAQUI — adicionar/renomear
 * um campo é uma edição só (evita o "campo oco" silencioso).
 */
export const DOD_FIELD_MAP: ReadonlyArray<{ key: keyof DoDFields; header: string }> = [
  { key: 'goal', header: 'Goal' },
  { key: 'taskDetails', header: 'Task Details' },
  { key: 'taskDescription', header: 'Task Description' },
  { key: 'implementationGuide', header: 'Implementation Guide' },
  { key: 'verificationCriteria', header: 'Verification Criteria' },
  { key: 'dependencies', header: 'Dependencies' },
  { key: 'relatedFiles', header: 'Related Files' },
  { key: 'notes', header: 'Notes' },
]

export interface RaAreasForm {
  areas: Array<{
    area: string
    whatExistsToday: string
    whatTheWishNeedsHere: string
    filesToRead: string[]
  }>
}

export interface RaJourneysForm {
  journeys: Array<{ title: string; actor: string; steps: string[]; insight: string }>
}

export interface RaBriefForm {
  whatThisProjectIs: string
  architectureAndStack: string
  topRisks: string[]
  improvementOpportunities: string[]
  openQuestionsForPo: string[]
}

/** Entregável completo do RA (3 passos): o que o PO recebe como contexto. */
export interface RaDeliverable {
  areas: RaAreasForm['areas']
  journeys: RaJourneysForm['journeys']
  brief: RaBriefForm
}

/**
 * Formata o entregável do RA como texto estruturado — vira memória do projeto
 * e é o que o PO lê. Formato estável: o PO referencia jornadas por índice.
 */
export function formatRaDeliverable(d: RaDeliverable): string {
  const lines: string[] = ['RA analysis (areas, journeys, brief):', '', '## Areas touched']
  for (const a of d.areas) {
    lines.push(
      `- ${a.area}: today — ${a.whatExistsToday}; the wish needs — ${a.whatTheWishNeedsHere}. Files: ${a.filesToRead.join(', ')}`
    )
  }
  lines.push('', '## Journeys (the PO must cover EVERY journey below)')
  d.journeys.forEach((j, i) => {
    lines.push(`### Journey ${i}: ${j.title} (actor: ${j.actor})`)
    j.steps.forEach((s, k) => lines.push(`${k + 1}. ${s}`))
    lines.push(`Insight: ${j.insight}`)
  })
  lines.push(
    '',
    '## Brief',
    `What this project is: ${d.brief.whatThisProjectIs}`,
    `Architecture/stack: ${d.brief.architectureAndStack}`,
    `Top risks: ${d.brief.topRisks.join('; ')}`,
    `Improvement opportunities: ${d.brief.improvementOpportunities.join('; ')}`,
    `Open questions for the PO: ${d.brief.openQuestionsForPo.join('; ')}`
  )
  return lines.join('\n')
}

export interface PoPhasesForm {
  phases: Array<{ title: string; goal: string; rationale: string }>
}

export interface PoEpicsForm {
  epics: Array<{
    phaseIndex: number
    title: string
    description: string
    /** Jornadas do RA que este épico cobre (validado por código). */
    journeyIndexes: number[]
  }>
}

export interface PoFeaturesForm {
  features: Array<{ epicIndex: number; title: string; description: string }>
}

export interface PoTasksForm {
  tasks: Array<{
    featureIndex: number
    fields: DoDFields
    blockedByTaskIndexes?: number[]
  }>
}

export interface PoRoadmapForm {
  sprintGoal: string
  assignments: Array<{ taskIndex: number; sprint: number }>
}

export interface PoTriageForm {
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  rationale: string
  /** true = fura a fila: entra na próxima sprint para o SM delegar. */
  releaseNow: boolean
}

export interface QaVerdictForm {
  verdict: 'approve' | 'request_changes'
  comment: DoDFields
}

/**
 * Fase 1 do QA (Reconhecimento) — projeto novo, sem PR para julgar ainda.
 * O baseline que ele grava na memória ANTES do primeiro PR chegar: o que
 * "correto" significa neste repositório (docs/agents/quality-assurance.md §2).
 */
export interface QaReconForm {
  ci: string
  testSuites: string[]
  coverageExpectation: string
  criticalPaths: string[]
}

/**
 * Formata o baseline de reconhecimento como texto estruturado — precisa
 * passar no contrato de entregável (assertMissionDelivered): seções `##`,
 * listas, mais de 40 caracteres úteis.
 */
export function formatQaReconDeliverable(d: QaReconForm): string {
  return [
    'QA reconnaissance baseline (Fase 1 — Reconhecimento, docs/agents/quality-assurance.md):',
    '',
    '## CI/CD',
    d.ci,
    '',
    '## Test suites',
    ...d.testSuites.map((s) => `- ${s}`),
    '',
    '## Coverage expectation',
    d.coverageExpectation,
    '',
    '## Critical paths',
    ...d.criticalPaths.map((p) => `- ${p}`),
  ].join('\n')
}

export interface SmJudgmentForm {
  impediments: string[]
  notes: string
}

// Schema minimal: subconjunto de JSON Schema que o validador local entende
// (type, required, properties, items, enum, minItems). Suficiente e sem deps.
export interface MiniSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean'
  required?: string[]
  properties?: Record<string, MiniSchema>
  items?: MiniSchema
  enum?: string[]
  /** Mínimo de itens (arrays): é como o CÓDIGO força profundidade de análise. */
  minItems?: number
}

// Derivado da fonte única (DOD_FIELD_MAP) — nunca listar as chaves de novo.
// `titulo` entra à parte: é o título da issue, não uma seção do corpo, mas
// continua obrigatório no formulário que a LLM preenche.
const DOD_FIELDS_SCHEMA: MiniSchema = {
  type: 'object',
  required: ['titulo', ...DOD_FIELD_MAP.map((f) => f.key)],
  properties: Object.fromEntries(
    [['titulo', { type: 'string' } as MiniSchema]].concat(
      DOD_FIELD_MAP.map((f) => [f.key, { type: 'string' } as MiniSchema])
    ) as Array<[string, MiniSchema]>
  ),
}

export const RAILS_SCHEMAS = {
  // RA passo 1 — ONDE o pedido toca o sistema. Cada área cita arquivos REAIS
  // do codegraph; integrações existentes são minas de oportunidade (ex.: o
  // produto já vende no marketplace → avaliações reais já existem lá).
  raAreas: {
    type: 'object',
    required: ['areas'],
    properties: {
      areas: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['area', 'whatExistsToday', 'whatTheWishNeedsHere', 'filesToRead'],
          properties: {
            area: { type: 'string' },
            whatExistsToday: { type: 'string' },
            whatTheWishNeedsHere: { type: 'string' },
            filesToRead: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
    },
  } as MiniSchema,

  // RA passo 2 — JORNADAS. O código EXIGE >=2 cenários completos (o lado do
  // usuário E o lado dos dados/integrações): pedido raso não passa daqui.
  raJourneys: {
    type: 'object',
    required: ['journeys'],
    properties: {
      journeys: {
        type: 'array',
        minItems: 2,
        items: {
          type: 'object',
          required: ['title', 'actor', 'steps', 'insight'],
          properties: {
            title: { type: 'string' },
            actor: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' }, minItems: 3 },
            insight: { type: 'string' },
          },
        },
      },
    },
  } as MiniSchema,

  raBrief: {
    type: 'object',
    required: [
      'whatThisProjectIs',
      'architectureAndStack',
      'topRisks',
      'improvementOpportunities',
      'openQuestionsForPo',
    ],
    properties: {
      whatThisProjectIs: { type: 'string' },
      architectureAndStack: { type: 'string' },
      topRisks: { type: 'array', items: { type: 'string' } },
      improvementOpportunities: { type: 'array', items: { type: 'string' } },
      openQuestionsForPo: { type: 'array', items: { type: 'string' } },
    },
  } as MiniSchema,

  poPhases: {
    type: 'object',
    required: ['phases'],
    properties: {
      phases: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'goal', 'rationale'],
          properties: {
            title: { type: 'string' },
            goal: { type: 'string' },
            rationale: { type: 'string' },
          },
        },
      },
    },
  } as MiniSchema,

  poEpics: {
    type: 'object',
    required: ['epics'],
    properties: {
      epics: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          // journeyIndexes: quais jornadas do RA este épico cobre — é o elo
          // que permite ao CÓDIGO rejeitar plano que ignora uma jornada.
          required: ['phaseIndex', 'title', 'description', 'journeyIndexes'],
          properties: {
            phaseIndex: { type: 'number' },
            title: { type: 'string' },
            description: { type: 'string' },
            journeyIndexes: { type: 'array', items: { type: 'number' } },
          },
        },
      },
    },
  } as MiniSchema,

  // Features por épico (nível próprio da hierarquia — antes achatado em items).
  poFeatures: {
    type: 'object',
    required: ['features'],
    properties: {
      features: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['epicIndex', 'title', 'description'],
          properties: {
            epicIndex: { type: 'number' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
  } as MiniSchema,

  // Tasks por feature: a unidade delegável, com o DoD completo de 8 campos.
  poTasks: {
    type: 'object',
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['featureIndex', 'fields'],
          properties: {
            featureIndex: { type: 'number' },
            fields: DOD_FIELDS_SCHEMA,
            blockedByTaskIndexes: { type: 'array', items: { type: 'number' } },
          },
        },
      },
    },
  } as MiniSchema,

  // Roadmap: TODA task ganha uma sprint numerada (1..N) — é o que deixa o
  // cliente saber em qual fase está e o que sai quando (milestones datados).
  poRoadmap: {
    type: 'object',
    required: ['sprintGoal', 'assignments'],
    properties: {
      sprintGoal: { type: 'string' },
      assignments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['taskIndex', 'sprint'],
          properties: {
            taskIndex: { type: 'number' },
            sprint: { type: 'number' },
          },
        },
      },
    },
  } as MiniSchema,

  // Triagem de INCIDENTE pelo PO: sensor detecta, PO decide a criticidade e
  // se fura a fila da sprint — nunca o sensor.
  poTriage: {
    type: 'object',
    required: ['priority', 'rationale', 'releaseNow'],
    properties: {
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
      rationale: { type: 'string' },
      releaseNow: { type: 'boolean' },
    },
  } as MiniSchema,

  qaVerdict: {
    type: 'object',
    required: ['verdict', 'comment'],
    properties: {
      verdict: { type: 'string', enum: ['approve', 'request_changes'] },
      comment: DOD_FIELDS_SCHEMA,
    },
  } as MiniSchema,

  // QA Fase 1 — Reconhecimento: sem PR para julgar, o formulário é o
  // baseline de qualidade do repositório (docs/agents/quality-assurance.md §2).
  qaRecon: {
    type: 'object',
    required: ['ci', 'testSuites', 'coverageExpectation', 'criticalPaths'],
    properties: {
      ci: { type: 'string' },
      testSuites: { type: 'array', items: { type: 'string' }, minItems: 1 },
      coverageExpectation: { type: 'string' },
      criticalPaths: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  } as MiniSchema,

  smJudgment: {
    type: 'object',
    required: ['impediments', 'notes'],
    properties: {
      impediments: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
  } as MiniSchema,
} as const

// ---------------------------------------------------------------------------
// Validação determinística
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validateForm(schema: MiniSchema, value: unknown, path = '$'): ValidationResult {
  const errors: string[] = []
  walk(schema, value, path, errors)
  return { ok: errors.length === 0, errors }
}

function walk(schema: MiniSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`)
      return
    }
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
        errors.push(`${path}.${key}: required`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined && obj[key] !== null) {
        walk(sub, obj[key], `${path}.${key}`, errors)
      }
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`)
      return
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${value.length}`)
    }
    if (schema.items) {
      value.forEach((item, i) => walk(schema.items as MiniSchema, item, `${path}[${i}]`, errors))
    }
    return
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string`)
    else if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: expected one of [${schema.enum.join(', ')}]`)
    }
    return
  }
  if (schema.type === 'number' && typeof value !== 'number') {
    errors.push(`${path}: expected number`)
    return
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: expected boolean`)
  }
}

/**
 * DoD dos 8 campos, POR CÓDIGO (decisão do owner): todo campo presente e
 * não-vazio; Verification Criteria precisa conter ao menos um critério de
 * verdade (linha com conteúdo). A LLM nunca é gasta com esta conferência.
 */
export function validateDoD(fields: DoDFields): ValidationResult {
  const errors: string[] = []
  const obrigatorios: Array<keyof DoDFields> = ['titulo', ...DOD_FIELD_MAP.map((f) => f.key)]
  for (const key of obrigatorios) {
    const value = fields[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${key}: empty (DoD requires all ${ISSUE_DOD_FIELDS.length} fields)`)
    }
  }
  if (
    typeof fields.verificationCriteria === 'string' &&
    !fields.verificationCriteria.split('\n').some((l) => l.trim().length > 3)
  ) {
    errors.push('verificationCriteria: needs at least one verifiable criterion')
  }
  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Prompt de passo
// ---------------------------------------------------------------------------

const ROLE_TITLES: Record<CadenceRole, string> = {
  ra: 'Research Analyst (technical scout — almost a tech lead)',
  po: 'Product Owner',
  sm: 'Scrum Master',
  qa: 'Quality Assurance',
}

/**
 * Prompt CURTO de um passo de roteiro: identidade+playbook resumido, contexto
 * curado pelo sistema e o schema do formulário. Deliberadamente NÃO menciona
 * ferramentas de ação — a LLM só decide; o executor do GitOrch aplica.
 */
export function buildStepPrompt(
  role: CadenceRole,
  stepId: string,
  schema: MiniSchema,
  contextBlocks: string[]
): string {
  const playbook = loadPlaybook(role)
  return [
    `You are the GitOrch ${ROLE_TITLES[role]} agent, executing ONE step of a guided SCRUM routine.`,
    `Step: ${stepId}`,
    '',
    'Your role playbook (for judgment, not for tooling):',
    playbook,
    '',
    'Context assembled by GitOrch for this step:',
    ...contextBlocks.map((b) => `---\n${b}`),
    '---',
    '',
    'Decide and reply ONLY with a single JSON object matching this schema',
    '(no prose before or after, no markdown fences):',
    JSON.stringify(schema, null, 2),
    '',
    'GitOrch will validate your JSON and apply the resulting actions itself.',
    'You do not have (and must not attempt to use) any GitHub tools.',
  ].join('\n')
}
