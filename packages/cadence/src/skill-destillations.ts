/**
 * @file skill-destillations.ts
 * @description Catálogo tipado e canônico das 26 skills do Gstack destiladas nos 3 pilares
 * do Cadence (Roteiro, Sensor, Executor).
 *
 * Baseado na Lei de Arquitetura: "A LLM decide, o Sistema executa".
 * Nenhuma ferramenta de mutação no agente — tudo é formulário (rail), sensor injetado ou executor determinístico.
 */

export type GstackSkillRole = 'po' | 'ra' | 'qa' | 'sm' | 'all'
export type GstackSkillType = 'rail' | 'sensor' | 'executor' | 'hybrid'

export interface GstackSkillDefinition {
  /** Nome identificador da skill */
  name: string
  /** Descrição executiva do propósito da skill */
  description: string
  /** Papel principal responsável pela skill */
  role: GstackSkillRole
  /** Tipo de destilação no Cadence */
  type: GstackSkillType
  /** Timeout padrão sugerido em milissegundos */
  timeoutMs: number
  /** Nome do schema de formulário associado (se for rail ou hybrid) */
  schemaId?: string
  /** Indica se requer execução em sandbox efêmero */
  requiresSandbox?: boolean
}

/**
 * Catálogo canônico das 26 skills do Gstack incorporadas ao GitOrch.
 */
export const GSTACK_SKILL_CATALOG: Record<string, GstackSkillDefinition> = {
  // --- PO (Product Owner) ---
  'office-hours': {
    name: 'office-hours',
    description:
      'Desafia pedidos vagos, extrai o problema real, o usuário real e a menor versão viável (MVP).',
    role: 'po',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'poOfficeHours',
  },
  'plan-ceo-review': {
    name: 'plan-ceo-review',
    description:
      'Reavalia estrategicamente o escopo da sprint (Modos: Expansão, Redução ou Manter Escopo).',
    role: 'po',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'poCeoReview',
  },
  'plan-devex-review': {
    name: 'plan-devex-review',
    description:
      'Audita e projeta a experiência do desenvolvedor (DX) e tempos de onboarding de APIs e CLIs.',
    role: 'po',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'poDevexReview',
  },
  spec: {
    name: 'spec',
    description: 'Transforma desejos e briefs técnicos em especificações executáveis completas.',
    role: 'po',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'poSpec',
  },
  autoplan: {
    name: 'autoplan',
    description:
      'Encadeador mestre que conduz o pipeline completo de planejamento e gera os 8 campos de DoD.',
    role: 'po',
    type: 'rail',
    timeoutMs: 120000,
    schemaId: 'poAutoplan',
  },

  // --- RA (Research Analyst) ---
  investigate: {
    name: 'investigate',
    description:
      'Investigação sistemática de causa-raiz (hipóteses, rastreio de fluxo e evidências no código).',
    role: 'ra',
    type: 'rail',
    timeoutMs: 120000,
    schemaId: 'raInvestigate',
  },
  cso: {
    name: 'cso',
    description:
      'Auditoria contínua de segurança (STRIDE / OWASP Top 10) e modelagem de ameaças no repositório.',
    role: 'ra',
    type: 'hybrid',
    timeoutMs: 180000,
    schemaId: 'raCsoAudit',
    requiresSandbox: true,
  },
  benchmark: {
    name: 'benchmark',
    description:
      'Sensor de performance, baselines de carregamento e medição de tempos de resposta.',
    role: 'ra',
    type: 'sensor',
    timeoutMs: 120000,
    requiresSandbox: true,
  },
  health: {
    name: 'health',
    description: 'Sensor de integridade do código, complexidade ciclomática, cobertura e linters.',
    role: 'ra',
    type: 'sensor',
    timeoutMs: 90000,
    requiresSandbox: true,
  },
  'plan-eng-review': {
    name: 'plan-eng-review',
    description:
      'Validação técnica de arquitetura, fluxo de dados e identificação de riscos de implementação.',
    role: 'ra',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'raEngReview',
  },
  'design-consultation': {
    name: 'design-consultation',
    description: 'Pesquisa e proposta arquitetural de design systems e padrões visuais do produto.',
    role: 'ra',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'raDesignConsultation',
  },
  'design-shotgun': {
    name: 'design-shotgun',
    description:
      'Exploração de múltiplas opções conceituais de interface e UX antes do compromisso de código.',
    role: 'ra',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'raDesignShotgun',
  },
  'design-html': {
    name: 'design-html',
    description:
      'Prototipação técnica em HTML dinâmico/computado para validação de layout sem dependências.',
    role: 'ra',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'raDesignHtml',
  },

  // --- QA (Quality Assurance) ---
  qa: {
    name: 'qa',
    description:
      'Execução de testes funcionais, identificação de bugs e geração de testes de regressão.',
    role: 'qa',
    type: 'hybrid',
    timeoutMs: 180000,
    schemaId: 'qaFullAudit',
    requiresSandbox: true,
  },
  'qa-only': {
    name: 'qa-only',
    description:
      'Avaliação estrita e sem alterações de código contra a lista de Verification Criteria da task.',
    role: 'qa',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'qaVerdict',
  },
  review: {
    name: 'review',
    description:
      'Code review em nível Staff Engineer: análise de segurança, SQL safety e efeitos colaterais.',
    role: 'qa',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'qaVerdict',
  },
  'design-review': {
    name: 'design-review',
    description:
      'Auditoria de fidelidade visual e consistência de UI baseada em evidências reais de browser.',
    role: 'qa',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'qaDesignReview',
  },
  'plan-design-review': {
    name: 'plan-design-review',
    description:
      'Avaliação de dimensões de design e combate a AI-slop antes do início da implementação.',
    role: 'qa',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'qaPlanDesignReview',
  },
  'devex-review': {
    name: 'devex-review',
    description:
      'Auditoria de experiência do desenvolvedor ao vivo (onboarding, CLI e documentação).',
    role: 'qa',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'qaDevexReview',
  },

  // --- SM (Scrum Master) ---
  'shrimp-task-manager': {
    name: 'shrimp-task-manager',
    description:
      'Orquestração canônica de tarefas, verificação determinística de DoD e concorrência de fluxo.',
    role: 'sm',
    type: 'executor',
    timeoutMs: 30000,
  },
  retro: {
    name: 'retro',
    description:
      'Retrospectiva de engenharia, análise de saúde da sprint e geração de melhorias contínuas.',
    role: 'sm',
    type: 'rail',
    timeoutMs: 60000,
    schemaId: 'smRetro',
  },
  ship: {
    name: 'ship',
    description:
      'Sincronização com main, validação de CI e abertura formal de PRs prontos para merge.',
    role: 'sm',
    type: 'executor',
    timeoutMs: 90000,
  },
  'land-and-deploy': {
    name: 'land-and-deploy',
    description: 'Merge de PRs aprovados, acompanhamento de CI e verificação de saúde em produção.',
    role: 'sm',
    type: 'executor',
    timeoutMs: 120000,
  },
  canary: {
    name: 'canary',
    description:
      'Sensor SRE pós-deploy: monitora erros de console, regressões de performance e integridade.',
    role: 'sm',
    type: 'sensor',
    timeoutMs: 120000,
  },
  'document-generate': {
    name: 'document-generate',
    description: 'Geração estruturada de documentação faltante baseada no framework Diataxis.',
    role: 'sm',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'smDocGenerate',
  },
  'document-release': {
    name: 'document-release',
    description:
      'Atualização e sincronização da documentação do repositório correspondente ao release entregue.',
    role: 'sm',
    type: 'rail',
    timeoutMs: 90000,
    schemaId: 'smDocRelease',
  },

  // --- Transversal / Global ---
  learn: {
    name: 'learn',
    description:
      'Persistência determinística e recuperação de aprendizados e padrões no MemPalace Vault.',
    role: 'all',
    type: 'executor',
    timeoutMs: 30000,
  },
}

/**
 * Retorna a lista de skills associadas a um papel específico (ou transversais).
 */
export function getSkillsForRole(role: GstackSkillRole): GstackSkillDefinition[] {
  return Object.values(GSTACK_SKILL_CATALOG).filter(
    (skill) => skill.role === role || skill.role === 'all'
  )
}

/**
 * Retorna a lista de skills filtradas pelo tipo de destilação no Cadence.
 */
export function getSkillsByType(type: GstackSkillType): GstackSkillDefinition[] {
  return Object.values(GSTACK_SKILL_CATALOG).filter((skill) => skill.type === type)
}
