import { describe, it, expect, vi } from 'vitest'
import {
  AGENT_LABEL_PREFIX,
  agentLabel,
  ehLabelDeAgente,
  aplicarLabelDoAgente,
} from './agent-label.js'

// Pedido do dono, olhando uma issue criada pelo produto: não dá para saber
// QUAL agente está com a bola. As labels existentes dizem o TIPO de trabalho
// (gitorch:incident, gitorch:task) e a prioridade (P0..P3), mas nada diz se a
// issue está com o RA, o PO, o SM, o dev assíncrono ou o QA — que é o que
// permite ler o fluxo RA → PO → SM → DEV → QA de relance, no quadro.
//
// Regra: um agente por vez. Quando outro assume, o label do anterior SAI.

describe('agentLabel', () => {
  it('usa a mesma família das labels que já existem', () => {
    expect(AGENT_LABEL_PREFIX).toBe('gitorch:agent:')
    expect(agentLabel('ra')).toBe('gitorch:agent:ra')
    expect(agentLabel('po')).toBe('gitorch:agent:po')
    expect(agentLabel('sm')).toBe('gitorch:agent:sm')
    expect(agentLabel('jules')).toBe('gitorch:agent:jules')
    expect(agentLabel('qa')).toBe('gitorch:agent:qa')
  })

  it('reconhece label de agente sem confundir com as outras', () => {
    expect(ehLabelDeAgente('gitorch:agent:po')).toBe(true)
    expect(ehLabelDeAgente('gitorch:incident')).toBe(false)
    expect(ehLabelDeAgente('gitorch:task')).toBe(false)
    expect(ehLabelDeAgente('jules')).toBe(false)
    expect(ehLabelDeAgente('P0')).toBe(false)
  })
})

describe('aplicarLabelDoAgente', () => {
  const deps = (labelsAtuais: string[]) => {
    const adicionadas: string[] = []
    const removidas: string[] = []
    return {
      repository: 'dono/repo',
      issueNumber: 21,
      lerLabels: vi.fn(async () => labelsAtuais),
      adicionarLabel: vi.fn(async (l: string) => {
        adicionadas.push(l)
      }),
      removerLabel: vi.fn(async (l: string) => {
        removidas.push(l)
      }),
      adicionadas,
      removidas,
    }
  }

  it('primeiro agente a pegar a issue: só adiciona', async () => {
    const d = deps(['gitorch:incident', 'P0'])
    await aplicarLabelDoAgente({ ...d, agente: 'po' })

    expect(d.adicionadas).toEqual(['gitorch:agent:po'])
    expect(d.removidas).toEqual([])
  })

  it('quando outro assume, o label do anterior SAI', async () => {
    const d = deps(['gitorch:incident', 'P0', 'gitorch:agent:po'])
    await aplicarLabelDoAgente({ ...d, agente: 'sm' })

    expect(d.adicionadas).toEqual(['gitorch:agent:sm'])
    expect(d.removidas).toEqual(['gitorch:agent:po'])
  })

  it('mesmo agente de novo: não mexe em nada (evita ruído no histórico)', async () => {
    const d = deps(['gitorch:agent:qa'])
    await aplicarLabelDoAgente({ ...d, agente: 'qa' })

    expect(d.adicionadas).toEqual([])
    expect(d.removidas).toEqual([])
  })

  it('nunca remove as labels de tipo ou prioridade', async () => {
    const d = deps(['gitorch:incident', 'gitorch:task', 'P0', 'jules', 'gitorch:agent:sm'])
    await aplicarLabelDoAgente({ ...d, agente: 'jules' })

    expect(d.removidas).toEqual(['gitorch:agent:sm'])
    expect(d.removidas).not.toContain('gitorch:task')
    expect(d.removidas).not.toContain('P0')
    expect(d.removidas).not.toContain('jules')
  })

  it('falha do GitHub não derruba o trabalho do agente', async () => {
    const avisos: string[] = []
    const d = deps(['gitorch:agent:po'])
    d.adicionarLabel = vi.fn(async () => {
      throw new Error('GitHub fora do ar')
    })

    await expect(
      aplicarLabelDoAgente({ ...d, agente: 'sm', onWarn: (m) => avisos.push(m) })
    ).resolves.toBeUndefined()
    expect(avisos.join(' ')).toContain('label')
  })
})
