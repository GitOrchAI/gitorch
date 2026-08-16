import { describe, expect, it } from 'vitest'
import { decidirFechamento, fecharTarefaEntregue } from './fechar-tarefa.js'

describe('decidirFechamento', () => {
  it('mesclado e a tarefa continua aberta: fecha', () => {
    expect(decidirFechamento({ mesclado: true, tarefaAberta: true, delegado: true }).fechar).toBe(
      true
    )
  })

  it('não mesclado: não fecha', () => {
    expect(decidirFechamento({ mesclado: false, tarefaAberta: true, delegado: true }).fechar).toBe(
      false
    )
  })

  it('o GitHub já fechou sozinho: não faz nada', () => {
    expect(decidirFechamento({ mesclado: true, tarefaAberta: false, delegado: true }).fechar).toBe(
      false
    )
  })

  it('entrega de humano: o produto não fecha tarefa de gente', () => {
    expect(decidirFechamento({ mesclado: true, tarefaAberta: true, delegado: false }).fechar).toBe(
      false
    )
  })
})

describe('fecharTarefaEntregue', () => {
  function deps(over: {
    mesclado?: boolean
    delegado?: boolean
    estado?: 'open' | 'closed'
    comentarLanca?: boolean
    fecharLanca?: boolean
  }) {
    const chamadas: string[] = []
    const comentarios: string[] = []
    return {
      chamadas,
      comentarios,
      d: {
        numeroDoPr: 63,
        mesclado: over.mesclado ?? true,
        delegado: over.delegado ?? true,
        lerEstadoDaTarefa: async () => {
          chamadas.push('ler')
          return over.estado ?? 'open'
        },
        comentar: async (texto: string) => {
          if (over.comentarLanca) throw new Error('GitHub recusou o comentário (403)')
          chamadas.push('comentar')
          comentarios.push(texto)
        },
        fechar: async () => {
          if (over.fecharLanca) throw new Error('GitHub recusou o fechamento (403)')
          chamadas.push('fechar')
        },
      },
    }
  }

  it('mesclado, delegado, tarefa aberta: lê o estado, comenta e fecha, nesta ordem', async () => {
    const { d, chamadas, comentarios } = deps({})
    await fecharTarefaEntregue(d)
    expect(chamadas).toEqual(['ler', 'comentar', 'fechar'])
    // Auditável: o comentário cita o PR que resolveu a tarefa.
    expect(comentarios[0]).toContain('#63')
  })

  it('não mesclado: nem lê o estado da tarefa (a decisão já está resolvida sem rede)', async () => {
    const { d, chamadas } = deps({ mesclado: false })
    await fecharTarefaEntregue(d)
    expect(chamadas).toEqual([])
  })

  it('entrega de humano: nem lê o estado da tarefa — o produto não administra tarefa de gente', async () => {
    const { d, chamadas } = deps({ delegado: false })
    await fecharTarefaEntregue(d)
    expect(chamadas).toEqual([])
  })

  it('a tarefa já está fechada (o GitHub fechou sozinho): lê o estado, mas não comenta nem fecha de novo', async () => {
    const { d, chamadas } = deps({ estado: 'closed' })
    await fecharTarefaEntregue(d)
    expect(chamadas).toEqual(['ler'])
  })

  it('falha ao comentar: sobe a exceção, não fecha a tarefa por cima de um comentário que não saiu', async () => {
    const { d, chamadas } = deps({ comentarLanca: true })
    await expect(fecharTarefaEntregue(d)).rejects.toThrow(/recusou o comentário/)
    expect(chamadas).toEqual(['ler'])
  })

  it('falha ao fechar: sobe a exceção — quem chama decide como isso fica visível', async () => {
    const { d, chamadas } = deps({ fecharLanca: true })
    await expect(fecharTarefaEntregue(d)).rejects.toThrow(/recusou o fechamento/)
    expect(chamadas).toEqual(['ler', 'comentar'])
  })
})
