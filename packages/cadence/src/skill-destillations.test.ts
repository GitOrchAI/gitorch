import { describe, expect, it } from 'vitest'
import { GSTACK_SKILL_CATALOG, getSkillsForRole, getSkillsByType } from './skill-destillations'

describe('Gstack Skill Distillations Catalog', () => {
  it('should export a catalog containing all 26 canonical skills', () => {
    expect(GSTACK_SKILL_CATALOG).toBeDefined()
    expect(Object.keys(GSTACK_SKILL_CATALOG).length).toBeGreaterThanOrEqual(26)
  })

  it('should accurately classify skills by responsible role', () => {
    const poSkills = getSkillsForRole('po')
    expect(poSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['office-hours', 'plan-ceo-review', 'spec', 'autoplan'])
    )

    const raSkills = getSkillsForRole('ra')
    expect(raSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['investigate', 'cso', 'benchmark', 'design-consultation'])
    )

    const qaSkills = getSkillsForRole('qa')
    expect(qaSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['qa', 'qa-only', 'review', 'design-review'])
    )

    const smSkills = getSkillsForRole('sm')
    expect(smSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['shrimp-task-manager', 'retro', 'ship', 'canary'])
    )
  })

  it('should correctly filter skills by distillation type (rail, sensor, executor)', () => {
    const rails = getSkillsByType('rail')
    expect(rails.length).toBeGreaterThan(0)
    expect(rails.some((s) => s.name === 'investigate')).toBe(true)

    const sensors = getSkillsByType('sensor')
    expect(sensors.length).toBeGreaterThan(0)
    expect(sensors.some((s) => s.name === 'benchmark')).toBe(true)

    const executors = getSkillsByType('executor')
    expect(executors.length).toBeGreaterThan(0)
    expect(executors.some((s) => s.name === 'shrimp-task-manager')).toBe(true)
  })

  it('should guarantee every skill definition has description, role, type, and timeoutMs', () => {
    for (const [key, skill] of Object.entries(GSTACK_SKILL_CATALOG)) {
      expect(skill.name).toBe(key)
      expect(skill.description).toBeTruthy()
      expect(['po', 'ra', 'qa', 'sm', 'all']).toContain(skill.role)
      expect(['rail', 'sensor', 'executor', 'hybrid']).toContain(skill.type)
      expect(typeof skill.timeoutMs).toBe('number')
      expect(skill.timeoutMs).toBeGreaterThan(0)
    }
  })
})
