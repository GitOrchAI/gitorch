import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Cadence: a fonte única do MÉTODO dos agentes GitOrch (playbooks SCRUM por
// papel e por evento). Quem consome: o priming das missões (packages/agents),
// o plugin do motor (imagem do agente) e o scheduler (cerimônias). Editar um
// playbook aqui muda o comportamento dos 4 agentes em todos os motores.
// Módulo CJS (padrão dos packages do monorepo): __dirname aponta para dist/ no
// build e para src/ nos testes; playbooks/ fica um nível acima em ambos.

const PLAYBOOKS_DIR = join(__dirname, '..', 'playbooks')

export type CadenceRole = 'ra' | 'po' | 'sm' | 'qa'
export type CadenceEvent = 'sprint-planning' | 'daily' | 'sprint-review' | 'sprint-retro'

export const CADENCE_VERSION = '0.1.0'

/**
 * Definition of Done de toda issue de Task: os 8 campos canônicos, na ordem
 * (decisão do owner, 2026-07-04). O PO gera; o SM valida e bloqueia delegação
 * sem eles; o QA reprova PRs citando-os no comentário @jules.
 */
export const ISSUE_DOD_FIELDS = [
  'Título',
  'Description',
  'Notes',
  'Implementation Guide',
  'Verification Criteria',
  'Summary',
  'Analysis Result',
  'Related Files',
] as const

/** Playbook do papel (markdown, em inglês — vai direto ao motor). */
export function loadPlaybook(role: CadenceRole): string {
  return readFileSync(join(PLAYBOOKS_DIR, `${role}.md`), 'utf8')
}

/** Playbook de evento SCRUM (missões de cerimônia agendadas pelo scheduler). */
export function loadEventPlaybook(event: CadenceEvent): string {
  return readFileSync(join(PLAYBOOKS_DIR, 'events', `${event}.md`), 'utf8')
}
