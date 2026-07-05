import { describe, it, expect } from 'vitest'
import { runRaRails, runPoRails, type StepExecutor } from './role-rails.js'

const RA_REPLIES: Record<string, string> = {
  areas: JSON.stringify({
    areas: [
      {
        area: 'backend',
        whatExistsToday: 'Produtos sem campo de material.',
        whatTheWishNeedsHere: 'Coluna material + endpoint de filtro.',
        filesToRead: ['backend/src/app.ts'],
      },
    ],
  }),
  journeys: JSON.stringify({
    journeys: [
      {
        title: 'Cliente filtra por material',
        actor: 'comprador',
        steps: ['abre catálogo', 'escolhe PLA', 'vê só produtos PLA'],
        insight: 'Filtro reduz abandono.',
      },
      {
        title: 'Dados já existentes no marketplace',
        actor: 'sistema',
        steps: ['lê integração MLB', 'coleta atributos', 'preenche material'],
        insight: 'Marketplace já tem o dado — reutilizar.',
      },
    ],
  }),
  brief: JSON.stringify({
    whatThisProjectIs: 'E-commerce de produtos 3D.',
    architectureAndStack: 'React+Vite front; Express+Prisma back.',
    topRisks: ['auth híbrida'],
    improvementOpportunities: ['estruturar material no banco'],
    openQuestionsForPo: ['manter filtro por regex?'],
  }),
}

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
  it('três passos encadeados: áreas → jornadas → brief viram o entregável do PO', async () => {
    const prompts: string[] = []
    const execute: StepExecutor = async (p) => {
      prompts.push(p)
      const step = p.match(/Step: ra-(\w+)/)?.[1] ?? '?'
      return RA_REPLIES[step] ?? '{}'
    }
    const { deliverable, text } = await runRaRails(execute, ['codegraph resumo', 'memória'])
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('codegraph resumo')
    // o passo de jornadas vê as áreas; o brief vê as jornadas
    expect(prompts[1]).toContain('backend/src/app.ts')
    expect(prompts[2]).toContain('Marketplace já tem o dado')
    // Lei: prompt não menciona tooling de ação
    expect(prompts[0]).not.toMatch(/`gh`|gh api/)
    expect(deliverable.journeys).toHaveLength(2)
    // o texto formatado (memória do PO) manda cobrir TODAS as jornadas
    expect(text).toContain('must cover EVERY journey')
    expect(text).toContain('Journey 1: Dados já existentes no marketplace')
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
    // o passo de backlog exige issue densa p/ dev assíncrono sem contexto:
    // caminhos reais (verbatim do codegraph), reuse-first, uma mudança por task
    expect(prompts[2]).toContain('copied verbatim from the codegraph')
    expect(prompts[2]).toContain('REUSE FIRST')
    expect(prompts[2]).toContain('ONE focused change per task')
  })
})
