import { describe, it, expect } from 'vitest'
import { runRaRails, runPoRails, type StepExecutor } from './role-rails.js'

const RA_REPLY = JSON.stringify({
  whatThisProjectIs: 'E-commerce de produtos 3D.',
  architectureAndStack: 'React+Vite front; Express+Prisma back.',
  topRisks: ['auth híbrida'],
  improvementOpportunities: ['estruturar material no banco'],
  openQuestionsForPo: ['manter filtro por regex?'],
})

const PO_REPLIES: Record<string, string> = {
  phases: JSON.stringify({
    phases: [{ title: 'Fase 1 — Dados', goal: 'estruturar', rationale: 'base' }],
  }),
  epics: JSON.stringify({
    epics: [{ phaseIndex: 0, title: 'Épico: material', description: 'd' }],
  }),
  backlog: JSON.stringify({
    items: [
      {
        epicIndex: 0,
        kind: 'task',
        fields: {
          titulo: '[Task] coluna material',
          description: 'd',
          notes: 'n',
          implementationGuide: '1;2;3',
          verificationCriteria: '- GET filtra\n- teste verde',
          summary: 's',
          analysisResult: 'a',
          relatedFiles: 'schema.sql',
        },
      },
    ],
  }),
  sprint: JSON.stringify({ sprintGoal: 'Filtrar por material', selectedItemIndexes: [0] }),
}

describe('runRaRails', () => {
  it('um passo: devolve o brief estruturado validado', async () => {
    const prompts: string[] = []
    const execute: StepExecutor = async (p) => {
      prompts.push(p)
      return RA_REPLY
    }
    const brief = await runRaRails(execute, ['codegraph resumo', 'memória'])
    expect(brief.improvementOpportunities).toContain('estruturar material no banco')
    expect(prompts[0]).toContain('codegraph resumo')
    // Lei: prompt não menciona tooling de ação
    expect(prompts[0]).not.toMatch(/`gh`|gh api/)
  })
})

describe('runPoRails', () => {
  it('quatro passos encadeados: fases → épicos → backlog → sprint viram BacklogPlan', async () => {
    const stepsSeen: string[] = []
    const execute: StepExecutor = async (prompt) => {
      const step = prompt.match(/Step: po-(\w+)/)?.[1] ?? '?'
      stepsSeen.push(step)
      return PO_REPLIES[step] ?? '{}'
    }

    const plan = await runPoRails(execute, {
      wish: { number: 100, nodeId: 'I_wish' },
      wishText: 'Filtro por material',
      contextBlocks: ['RA brief: material é regex hoje'],
    })

    expect(stepsSeen).toEqual(['phases', 'epics', 'backlog', 'sprint'])
    expect(plan.phases).toHaveLength(1)
    expect(plan.epics).toHaveLength(1)
    expect(plan.items).toHaveLength(1)
    expect(plan.sprint?.sprintGoal).toBe('Filtrar por material')
    expect(plan.wish.number).toBe(100)
  })

  it('cada passo recebe as decisões dos passos anteriores no contexto', async () => {
    const prompts: string[] = []
    const execute: StepExecutor = async (prompt) => {
      prompts.push(prompt)
      const step = prompt.match(/Step: po-(\w+)/)?.[1] ?? '?'
      return PO_REPLIES[step] ?? '{}'
    }
    await runPoRails(execute, {
      wish: { number: 100, nodeId: 'I_wish' },
      wishText: 'Filtro por material',
      contextBlocks: [],
    })
    // o passo de épicos vê as fases; o de backlog vê os épicos; o sprint vê o backlog
    expect(prompts[1]).toContain('Fase 1 — Dados')
    expect(prompts[2]).toContain('Épico: material')
    expect(prompts[3]).toContain('[Task] coluna material')
  })
})
