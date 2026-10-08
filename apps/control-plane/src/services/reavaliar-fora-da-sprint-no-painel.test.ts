import { describe, it, expect, vi } from 'vitest'
import type { PedidoNaFila } from '@gitorch/cadence'
import {
  TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA,
  registrarTarefasForaDaSprint,
} from './reavaliar-fora-da-sprint-no-painel.js'
import { reavaliarForaDaSprint } from './reavaliar-fora-da-sprint.js'

// Fila de pesos onde o 501 (peso 13) está na frente dos pequenos: a ordem custa caro.
const FILA: PedidoNaFila[] = [
  { pedido: 501, peso: 13 },
  { pedido: 502, peso: 1 },
  { pedido: 503, peso: 2 },
  { pedido: 504, peso: 3 },
]

function montar(foraDaSprint: number[], jaRegistradas: Set<string> = new Set()) {
  const eventos: Array<{ chave: string; texto: string }> = []
  const registrarNoPainel = vi.fn(async (e: { chave: string; texto: string }) => {
    if (jaRegistradas.has(e.chave)) return false
    jaRegistradas.add(e.chave)
    eventos.push(e)
    return true
  })
  const deps = {
    repo: 'acme/api',
    listarForaDaSprint: vi.fn(async () => foraDaSprint),
    registrarNoPainel,
  }
  return { deps, eventos }
}

describe('registrarTarefasForaDaSprint (4.3: só evento de painel)', () => {
  it('registra o motivo da peça, com peso e posição na fila, e deixa claro que nada foi alterado', async () => {
    const { deps, eventos } = montar([502])
    const r = await registrarTarefasForaDaSprint(deps, FILA)
    expect(r.registradas).toEqual([502])
    expect(eventos).toHaveLength(1)
    const outros = FILA.filter((p) => p.pedido !== 502)
    const esperado = reavaliarForaDaSprint({ pedido: { pedido: 502, peso: 1 }, fila: outros })
    expect(esperado.entraAgora).toBe(false)
    expect(eventos[0]?.texto).toContain('#502')
    expect(eventos[0]?.texto).toContain(esperado.motivo)
    expect(eventos[0]?.texto).toContain('peso 1')
    expect(eventos[0]?.texto).toContain('posição 2 de 4')
    expect(eventos[0]?.texto).toContain('nada foi alterado')
  })

  it('a tarefa fora da sprint que não está na fila (sem peso ou fora do quadro) é ignorada', async () => {
    const { deps, eventos } = montar([999])
    const r = await registrarTarefasForaDaSprint(deps, FILA)
    expect(r.registradas).toEqual([])
    expect(eventos).toEqual([])
  })

  it('a chave é estável: a mesma situação na passada seguinte não repete o evento', async () => {
    const vistas = new Set<string>()
    const um = montar([502, 503], vistas)
    const r1 = await registrarTarefasForaDaSprint(um.deps, FILA)
    const dois = montar([502, 503], vistas)
    const r2 = await registrarTarefasForaDaSprint(dois.deps, FILA)
    expect(r1.registradas).toEqual([502, 503])
    expect(r2.registradas).toEqual([])
    expect(um.eventos[0]?.chave).toMatch(/^fora-da-sprint:acme\/api:502:/)
  })

  it('a ordem de registro segue a fila, não a ordem da lista de entrada', async () => {
    const { deps } = montar([504, 502])
    const r = await registrarTarefasForaDaSprint(deps, FILA)
    expect(r.registradas).toEqual([502, 504])
  })

  it('teto de eventos NOVOS por passada: o resto fica para a próxima, sem estourar a linha do tempo', async () => {
    const fila: PedidoNaFila[] = Array.from({ length: 25 }, (_, i) => ({
      pedido: 600 + i,
      peso: 3,
    }))
    const vistas = new Set<string>()
    const numeros = fila.map((p) => p.pedido)
    const um = await registrarTarefasForaDaSprint(montar(numeros, vistas).deps, fila)
    expect(um.registradas).toHaveLength(TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA)
    const dois = await registrarTarefasForaDaSprint(montar(numeros, vistas).deps, fila)
    expect(dois.registradas).toHaveLength(TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA)
    expect(new Set([...um.registradas, ...dois.registradas]).size).toBe(
      2 * TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA
    )
  })

  it('as dependências não têm nenhuma capacidade de escrita na sprint, no quadro ou no GitHub', () => {
    const { deps } = montar([502])
    expect(Object.keys(deps).sort()).toEqual(['listarForaDaSprint', 'registrarNoPainel', 'repo'])
  })
})
