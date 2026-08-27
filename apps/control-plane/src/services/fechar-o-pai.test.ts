import { describe, expect, it } from 'vitest'
import {
  decidirSobreOPai,
  NIVEIS_DE_BAIXO_PARA_CIMA,
  recadoDeFechamentoDoPai,
  varrerArvoreDoPlano,
} from './fechar-o-pai.js'

const fechado = (number: number) => ({ number, aberto: false })
const aberto = (number: number) => ({ number, aberto: true })

describe('fechar o pai quando os filhos acabam', () => {
  it('todos os filhos fechados: o pai fecha', () => {
    expect(decidirSobreOPai({ paiAberto: true, filhos: [fechado(1), fechado(2)] })).toEqual({
      fechar: true,
      filhos: 2,
    })
  })

  it('um filho aberto segura o pai, e o motivo diz QUAL', () => {
    const d = decidirSobreOPai({ paiAberto: true, filhos: [fechado(1), aberto(2)] })
    expect(d.fechar).toBe(false)
    if (!d.fechar) expect(d.motivo).toContain('#2')
  })

  it('SEM filho nenhum NUNCA fecha — a guarda que impede apagar o plano recém-nascido', () => {
    // Um épico criado antes de o PO pendurar as features tem zero filhos, e
    // "zero filhos abertos" é trivialmente verdadeiro. Sem esta guarda a
    // varredura encerraria o plano do cliente no minuto em que ele nascesse.
    const d = decidirSobreOPai({ paiAberto: true, filhos: [] })
    expect(d.fechar).toBe(false)
    if (!d.fechar) expect(d.motivo).toContain('nenhum item pendurado')
  })

  it('pai já fechado não fecha de novo — nada de ruído no histórico do cliente', () => {
    const d = decidirSobreOPai({ paiAberto: false, filhos: [fechado(1)] })
    expect(d.fechar).toBe(false)
    if (!d.fechar) expect(d.motivo).toContain('já está fechado')
  })

  it('o recado cita os números para a pessoa poder conferir', () => {
    const texto = recadoDeFechamentoDoPai([fechado(10), fechado(11)])
    expect(texto).toContain('#10')
    expect(texto).toContain('#11')
    expect(texto).toContain('reabra')
  })

  it('a varredura vai de BAIXO para cima — a árvore inteira fecha numa passada', () => {
    // Na ordem inversa, cada nível levaria um ciclo e uma árvore de quatro
    // níveis demoraria quatro varreduras para se encerrar.
    expect([...NIVEIS_DE_BAIXO_PARA_CIMA]).toEqual(['feature', 'epic', 'phase'])
  })

  it('cem filhos, um só aberto: ainda segura', () => {
    const filhos = [...Array.from({ length: 99 }, (_, i) => fechado(i)), aberto(999)]
    expect(decidirSobreOPai({ paiAberto: true, filhos }).fechar).toBe(false)
  })
})

describe('varredura da árvore', () => {
  const portaFalsa = (
    arvore: Record<string, Array<{ number: number; aberto: boolean }>>,
    pais: Record<string, Array<{ number: number; nodeId: string }>>
  ) => {
    const fechados: Array<{ numero: number; recado: string }> = []
    return {
      fechados,
      porta: {
        listarPaisAbertos: async (nivel: string) => pais[nivel] ?? [],
        filhosDe: async (nodeId: string) => arvore[nodeId] ?? [],
        fechar: async (numero: number, recado: string) => {
          fechados.push({ numero, recado })
        },
      },
    }
  }

  it('fecha a árvore inteira numa passada só, de baixo para cima', async () => {
    const { porta, fechados } = portaFalsa(
      {
        'n-feature': [{ number: 10, aberto: false }],
        'n-epic': [{ number: 20, aberto: false }],
        'n-phase': [{ number: 30, aberto: false }],
      },
      {
        feature: [{ number: 20, nodeId: 'n-feature' }],
        epic: [{ number: 30, nodeId: 'n-epic' }],
        phase: [{ number: 40, nodeId: 'n-phase' }],
      }
    )
    const r = await varrerArvoreDoPlano({ porta })
    expect(r.fechados).toEqual([20, 30, 40])
    expect(fechados[0]?.recado).toContain('#10')
  })

  it('um nó com problema não derruba a varredura do resto', async () => {
    const avisos: string[] = []
    const r = await varrerArvoreDoPlano({
      porta: {
        listarPaisAbertos: async (nivel) =>
          nivel === 'feature'
            ? [
                { number: 1, nodeId: 'explode' },
                { number: 2, nodeId: 'ok' },
              ]
            : [],
        filhosDe: async (nodeId) => {
          if (nodeId === 'explode') throw new Error('issue apagada')
          return [{ number: 9, aberto: false }]
        },
        fechar: async () => undefined,
      },
      log: { info: () => undefined, warn: (m) => avisos.push(m) },
    })
    expect(r.fechados).toEqual([2])
    expect(avisos.join()).toContain('issue apagada')
  })

  it('nada para fechar: não toca em nada e conta o que manteve', async () => {
    const { porta, fechados } = portaFalsa(
      { 'n-1': [{ number: 5, aberto: true }] },
      { feature: [{ number: 1, nodeId: 'n-1' }] }
    )
    const r = await varrerArvoreDoPlano({ porta })
    expect(r.fechados).toEqual([])
    expect(r.mantidos).toBe(1)
    expect(r.primeiroMotivo).toContain('#5')
    expect(fechados).toHaveLength(0)
  })
})
