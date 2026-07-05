// Cadence Rails: os TRILHOS do modelo "LLM decide, sistema executa"
// (docs/agents/cadence-execution-model.md). Aqui vivem os FORMULÁRIOS (schemas)
// que a LLM preenche por passo de roteiro e os utilitários determinísticos que
// o control plane usa para validar. NENHUM prompt aqui instrui ação no GitHub —
// quem age é o executor do control plane.

import { loadPlaybook, type CadenceRole, ISSUE_DOD_FIELDS } from './index'

// ---------------------------------------------------------------------------
// Formulários (tipos + JSON Schema minimal — sem dependência externa)
// ---------------------------------------------------------------------------

export interface DoDFields {
  titulo: string
  description: string
  notes: string
  implementationGuide: string
  verificationCriteria: string
  summary: string
  analysisResult: string
  relatedFiles: string
}

export interface RaBriefForm {
  whatThisProjectIs: string
  architectureAndStack: string
  topRisks: string[]
  improvementOpportunities: string[]
  openQuestionsForPo: string[]
}

export interface PoPhasesForm {
  phases: Array<{ title: string; goal: string; rationale: string }>
}

export interface PoEpicsForm {
  epics: Array<{ phaseIndex: number; title: string; description: string }>
}

export interface PoBacklogItem {
  epicIndex: number
  kind: 'feature' | 'task'
  /** Task pertencente a uma feature deste mesmo formulário (índice em items). */
  parentFeatureIndex?: number
  fields: DoDFields
}

export interface PoBacklogForm {
  items: PoBacklogItem[]
}

export interface PoSprintForm {
  sprintGoal: string
  selectedItemIndexes: number[]
}

export interface QaVerdictForm {
  verdict: 'approve' | 'request_changes'
  comment: DoDFields
}

export interface SmJudgmentForm {
  impediments: string[]
  notes: string
}

// Schema minimal: subconjunto de JSON Schema que o validador local entende
// (type, required, properties, items, enum). Suficiente e sem deps.
export interface MiniSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean'
  required?: string[]
  properties?: Record<string, MiniSchema>
  items?: MiniSchema
  enum?: string[]
}

const DOD_FIELDS_SCHEMA: MiniSchema = {
  type: 'object',
  required: [
    'titulo',
    'description',
    'notes',
    'implementationGuide',
    'verificationCriteria',
    'summary',
    'analysisResult',
    'relatedFiles',
  ],
  properties: Object.fromEntries(
    [
      'titulo',
      'description',
      'notes',
      'implementationGuide',
      'verificationCriteria',
      'summary',
      'analysisResult',
      'relatedFiles',
    ].map((k) => [k, { type: 'string' } as MiniSchema])
  ),
}

export const RAILS_SCHEMAS = {
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
        items: {
          type: 'object',
          required: ['phaseIndex', 'title', 'description'],
          properties: {
            phaseIndex: { type: 'number' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
  } as MiniSchema,

  poBacklog: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['epicIndex', 'kind', 'fields'],
          properties: {
            epicIndex: { type: 'number' },
            kind: { type: 'string', enum: ['feature', 'task'] },
            parentFeatureIndex: { type: 'number' },
            fields: DOD_FIELDS_SCHEMA,
          },
        },
      },
    },
  } as MiniSchema,

  poSprint: {
    type: 'object',
    required: ['sprintGoal', 'selectedItemIndexes'],
    properties: {
      sprintGoal: { type: 'string' },
      selectedItemIndexes: { type: 'array', items: { type: 'number' } },
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
  const entries: Array<[keyof DoDFields, string]> = [
    ['titulo', fields.titulo],
    ['description', fields.description],
    ['notes', fields.notes],
    ['implementationGuide', fields.implementationGuide],
    ['verificationCriteria', fields.verificationCriteria],
    ['summary', fields.summary],
    ['analysisResult', fields.analysisResult],
    ['relatedFiles', fields.relatedFiles],
  ]
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${name}: empty (DoD requires all ${ISSUE_DOD_FIELDS.length} fields)`)
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
