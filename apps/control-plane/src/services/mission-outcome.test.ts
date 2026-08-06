import { describe, it, expect } from 'vitest'
import { assertMissionDelivered, resolveMissionDelivery } from './mission-outcome.js'

describe('assertMissionDelivered', () => {
  it('rejeita a saudação de motor sem missão (o caso real que ficava verde)', () => {
    const r = assertMissionDelivered(
      'po',
      'I am ready in the sandbox environment. How can I help you today?'
    )
    expect(r.delivered).toBe(false)
    if (!r.delivered) expect(r.reason).toContain('sem entregável')
  })

  it('rejeita a segunda saudação real (pedido de esclarecimento sem --sandbox)', () => {
    const r = assertMissionDelivered(
      'po',
      'I received your request with just --sandbox. Could you please clarify what you would like me to do?'
    )
    expect(r.delivered).toBe(false)
  })

  it('rejeita saída que só narra intenção, sem entregar', () => {
    const r = assertMissionDelivered(
      'sm',
      ['I will list the contents of /workspace.', 'I will run git status.'].join('\n')
    )
    expect(r.delivered).toBe(false)
  })

  it('rejeita saída curta demais para ser entregável de qualquer papel', () => {
    expect(assertMissionDelivered('ra', 'ok').delivered).toBe(false)
  })

  it('aceita o entregável real do RA (áreas, jornadas e brief)', () => {
    const brief = [
      '## Areas',
      '- backend: control-plane em Fastify (apps/control-plane/src/index.ts)',
      '- database: Prisma sobre PostgreSQL (apps/control-plane/prisma/schema.prisma)',
      '## Journeys',
      '1. O dono registra o projeto pelo wizard e o ambiente e clonado.',
      '2. Os agentes acordam em cascata e produzem o backlog inicial.',
      '## Brief',
      'O projeto orquestra agentes sobre repositorios de terceiros.',
    ].join('\n')
    expect(assertMissionDelivered('ra', brief).delivered).toBe(true)
  })

  it('aceita a entrega do SM mesmo quando o motor narrou antes de entregar', () => {
    const saida = [
      'I will list the contents of /workspace.',
      'I will run git status.',
      '## Delegation',
      '- issue #12 rotulada para execucao',
      '## Watchdog',
      '- nenhuma PR travada',
      '## Sensor',
      '- nenhum incidente novo',
    ].join('\n')
    expect(assertMissionDelivered('sm', saida).delivered).toBe(true)
  })

  it('aceita o relatório real do SM com narração extensa seguida de entrega técnica (caso real de 7.891 caracteres)', () => {
    const narracao = Array.from(
      { length: 6 },
      (_, i) => `I will run step ${i + 1} to inspect the workspace before reporting.`
    ).join('\n')
    const corpo = [
      '## Status do repositório',
      '- branch atual: feat/onboarding-projeto-novo-100',
      '- 3 commits ainda não sincronizados com origin/main',
      '',
      '## Achados técnicos',
      '```ts',
      'export function exemploDeTrecho(a: number, b: number): number {',
      '  return a + b',
      '}',
      '```',
      'O trecho acima ilustra o padrão usado no módulo de agendamento.',
      '',
      '## Riscos identificados',
      '1. A fila de missões não tem backoff exponencial em falhas consecutivas.',
      '2. O watchdog não distingue timeout de crash do processo motor.',
      '',
      '## Perguntas de rumo para o dono',
      '- Devemos priorizar o backoff antes do próximo lançamento?',
      '- O watchdog deve reiniciar automaticamente ou apenas alertar?',
    ].join('\n')
    // Repete o corpo técnico para simular o tamanho real (~7.891 caracteres)
    // sem depender de um número mágico exato — o que importa é que é
    // narração real seguida de um relatório técnico real, bem acima do limiar.
    const relatorioTecnico = Array.from({ length: 13 }, () => corpo).join('\n\n')
    const saida = [narracao, relatorioTecnico].join('\n')

    expect(saida.length).toBeGreaterThan(7000)
    expect(assertMissionDelivered('sm', saida).delivered).toBe(true)
  })

  // Achado Importante 8: uma saudação com as perguntas de esclarecimento
  // formatadas como lista markdown tinha estrutura ("- ") e por isso passava
  // pelo contrato antigo, apesar de ser exatamente o motor ocioso do
  // Crítico 1. Estrutura FRACA (bullets soltos) não pode mais anular o
  // padrão de saudação — só estrutura FORTE (seções/numeração/código/JSON).
  it('rejeita saudação formatada como lista markdown (falso positivo do achado #8)', () => {
    const saida = [
      'I received your request with just --sandbox. Could you please clarify:',
      '- Do you want me to analyse the repository?',
      '- Do you want me to write code?',
    ].join('\n')
    const r = assertMissionDelivered('po', saida)
    expect(r.delivered).toBe(false)
  })

  // Menor: o padrão de narração não pode comer uma linha de entregável real
  // em português só porque começa com "vou "/"irei " — esse catch-all foi
  // removido por falta de evidência real (o incidente só tinha narração em
  // inglês) e por risco de falso negativo.
  it('não trata "vou "/"irei " como narração (evita comer entregável em pt-BR)', () => {
    const saida = [
      '## Relatório',
      'Vou implementar a validação da seguinte forma: valido o token antes de',
      'gravar a credencial, e irei registrar o resultado no log estruturado.',
      '- passo concluído com sucesso',
    ].join('\n')
    expect(assertMissionDelivered('ra', saida).delivered).toBe(true)
  })
})

describe('resolveMissionDelivery (Crítico 1: o contrato só vale no caminho clássico)', () => {
  // As 5 saídas reais dos trilhos que REPROVAVAM antes desta correção
  // (verificadas ao vivo contra assertMissionDelivered) — vindas do caminho
  // de trilhos, todas têm que ser aceitas, porque são entregável por
  // construção (executor determinístico, não o motor narrando).
  const saidasReaisDosTrilhos: Array<{ role: 'po' | 'sm' | 'qa'; output: string }> = [
    {
      role: 'po',
      output:
        'PO rails applied wish #7 (algo).\nSprint goal: entregar o wizard.\nTree: 1 phase, 2 epics, 4 features.\nExecutor: created issues #21, #22.',
    },
    {
      role: 'sm',
      output:
        'SM delegated 2 ready task(s): #14, #15.\nWatchdog: no stuck PRs.\nsensor: no new incidents.',
    },
    {
      role: 'qa',
      output: 'QA judged PR #12: approve (CI green). Posted review and moved the card.',
    },
    { role: 'qa', output: 'QA: no delegated PR awaiting judgment.' },
    {
      role: 'po',
      output:
        'PO: no open wishlist issue; registered AgentQuestion asking the owner for the priority.',
    },
  ]

  it.each(saidasReaisDosTrilhos)(
    'aceita a entrega real dos trilhos do $role: "$output"',
    ({ role, output }) => {
      expect(resolveMissionDelivery(role, output, 'rails')).toEqual({ delivered: true })
    }
  )

  it('confirma que essas mesmas 5 saídas REPROVARIAM sem o gate (prova do bug original)', () => {
    for (const { role, output } of saidasReaisDosTrilhos) {
      expect(assertMissionDelivered(role, output).delivered).toBe(false)
    }
  })

  it('uma saudação crua do caminho CLÁSSICO continua sendo reprovada', () => {
    const r = resolveMissionDelivery(
      'po',
      'I am ready in the sandbox environment. How can I help you today?',
      'classic'
    )
    expect(r.delivered).toBe(false)
  })

  it('no caminho clássico, uma entrega real (com estrutura) continua sendo aceita', () => {
    const brief = ['## Areas', '- backend: control-plane em Fastify'].join('\n')
    expect(resolveMissionDelivery('ra', brief, 'classic')).toEqual({ delivered: true })
  })
})
