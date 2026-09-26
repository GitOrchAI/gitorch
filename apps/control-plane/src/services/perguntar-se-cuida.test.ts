import { describe, expect, it, vi } from 'vitest'
import {
  perguntarSeCuida,
  parseDedupKeyDeCuidaDestePedido,
  DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO,
} from './perguntar-se-cuida.js'
import type { OrigemDoItem } from './origem-do-item.js'

describe('perguntar-se-cuida', () => {
  it('dedup keys', () => {
    expect(parseDedupKeyDeCuidaDestePedido('invalido')).toBeNull()
    expect(
      parseDedupKeyDeCuidaDestePedido(`${DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO}dono/repo:42`)
    ).toEqual({ repository: 'dono/repo', numeroDoPr: 42 })
  })

  it('faz fallback quando o execute falha', async () => {
    const ask = vi.fn()
    await perguntarSeCuida(
      {
        userId: 'u1',
        projectId: 'p1',
        numeroDoPr: 42,
        repository: 'dono/repo',
        origem: 'dependabot' as OrigemDoItem,
        contexto: { entrega: 'a', ciclo: 'b', decisoes: [], lacunas: [] },
        contextoPr: { titulo: 'Fix it', idadeDias: 10, estadoCi: 'success', conflitos: false },
      },
      {
        agentQuestion: { ask },
        execute: { jules: vi.fn().mockRejectedValue(new Error('fail')) } as unknown as never,
      }
    )

    expect(ask).toHaveBeenCalledWith(
      'u1',
      'p1',
      expect.objectContaining({
        text: expect.stringContaining('Pull Request #42'),
        options: expect.arrayContaining([
          { label: '✍️ Outro (respondo por texto)', value: '__gitorch_free_text__' },
        ]),
      })
    )
  })
})
