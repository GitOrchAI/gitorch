import { describe, it, expect } from 'vitest'
import {
  CHAVE_PROJETO,
  TODOS,
  lerProjeto,
  salvarProjeto,
  filtroDeProjeto,
  rotuloDoProjeto,
  projetoNoServidor,
} from './painel-projeto'

/** Storage de mentira, com a opção de estourar como o modo privado estoura. */
function storeFake(inicial: Record<string, string> = {}, quebra = false) {
  const dados = { ...inicial }
  return {
    getItem: (k: string) => {
      if (quebra) throw new Error('sem storage')
      return dados[k] ?? null
    },
    setItem: (k: string, v: string) => {
      if (quebra) throw new Error('quota')
      dados[k] = v
    },
    dados,
  }
}

describe('projeto escolhido no painel', () => {
  it('sem nada guardado, mostra todos os projetos', () => {
    expect(lerProjeto(storeFake())).toBeNull()
  })

  it('lê o projeto que o dono escolheu', () => {
    expect(lerProjeto(storeFake({ [CHAVE_PROJETO]: 'GitOrchAI/gitorch' }))).toBe(
      'GitOrchAI/gitorch'
    )
  })

  it('a escolha explícita por "todos" também vira todos', () => {
    expect(lerProjeto(storeFake({ [CHAVE_PROJETO]: TODOS }))).toBeNull()
  })

  it('projeto que não existe mais cai em todos — e não filtra por fantasma', () => {
    // Caso real: o dono escolhe um projeto e depois o remove do GitOrch. Sem
    // esta conferência o painel filtraria por um nome morto e mostraria vazio
    // para sempre, sem ele entender por quê.
    const guardado = storeFake({ [CHAVE_PROJETO]: 'loureng/projeto-removido' })
    expect(lerProjeto(guardado, ['GitOrchAI/gitorch'])).toBeNull()
    expect(lerProjeto(guardado, ['GitOrchAI/gitorch', 'loureng/projeto-removido'])).toBe(
      'loureng/projeto-removido'
    )
  })

  it('grava a escolha, inclusive a de ver todos', () => {
    const s = storeFake()
    salvarProjeto(s, 'GitOrchAI/gitorch')
    expect(s.dados[CHAVE_PROJETO]).toBe('GitOrchAI/gitorch')
    salvarProjeto(s, null)
    expect(s.dados[CHAVE_PROJETO]).toBe(TODOS)
  })

  it('storage indisponível não derruba o painel', () => {
    expect(lerProjeto(storeFake({}, true))).toBeNull()
    expect(() => salvarProjeto(storeFake({}, true), 'x')).not.toThrow()
    expect(lerProjeto(null)).toBeNull()
    expect(() => salvarProjeto(null, 'x')).not.toThrow()
  })

  it('o filtro da rota: todos NÃO manda a chave vazia', () => {
    // `?projeto=` faria a rota receber filtro por nome em branco.
    expect(filtroDeProjeto(null)).toBe('')
    expect(filtroDeProjeto('GitOrchAI/gitorch')).toBe('?projeto=GitOrchAI%2Fgitorch')
  })

  it('nome com barra e espaço é escapado no filtro', () => {
    expect(filtroDeProjeto('acme/api de vendas')).toBe('?projeto=acme%2Fapi%20de%20vendas')
  })

  it('o rótulo do seletor', () => {
    expect(rotuloDoProjeto(null)).toBe('Todos os projetos')
    expect(rotuloDoProjeto('GitOrchAI/gitorch')).toBe('GitOrchAI/gitorch')
  })

  it('no servidor começa em todos, e o client corrige na hidratação', () => {
    expect(projetoNoServidor()).toBeNull()
  })
})
