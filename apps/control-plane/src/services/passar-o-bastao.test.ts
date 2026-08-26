import { describe, it, expect } from 'vitest'
import { criarPassagemDeBastao, PROXIMO_PAPEL } from './passar-o-bastao.js'
import { origemFuraODescanso } from './descanso-apos-vazia.js'

describe('PROXIMO_PAPEL — quem recebe o bastão de quem', () => {
  it('o RA que termina passa para o PO', () => {
    expect(PROXIMO_PAPEL['ra']).toBe('po')
  })

  it('o PO que termina passa para o SM', () => {
    expect(PROXIMO_PAPEL['po']).toBe('sm')
  })

  it('o SM NÃO passa daqui: quem acorda o QA é a fila de julgamento, que já existe', () => {
    // Duas portas para o mesmo trabalho divergiriam em silêncio — e a fila do
    // julgamento tem regra própria (só entra PR sem parecer).
    expect(PROXIMO_PAPEL['sm']).toBeUndefined()
    expect(PROXIMO_PAPEL['qa']).toBeUndefined()
  })
})

describe('criarPassagemDeBastao — o trabalho não para entre um papel e o outro', () => {
  it('papel que termina enfileira o seguinte', () => {
    const fila = criarPassagemDeBastao()
    fila.passar('ra', 'proj1')
    expect(fila.proxima()).toEqual({ papel: 'po', projectId: 'proj1' })
  })

  it('papel sem seguinte não enfileira ninguém', () => {
    const fila = criarPassagemDeBastao()
    fila.passar('qa', 'proj1')
    expect(fila.proxima()).toBeUndefined()
  })

  it('a vez sai da fila quando é entregue — não volta sozinha', () => {
    const fila = criarPassagemDeBastao()
    fila.passar('ra', 'proj1')
    fila.proxima()
    expect(fila.proxima()).toBeUndefined()
  })

  it('recusa temporária DEVOLVE a vez — perder trabalho por "estou ocupado" é o defeito', () => {
    const fila = criarPassagemDeBastao()
    fila.passar('ra', 'proj1')
    const vez = fila.proxima()!
    fila.devolver(vez)
    expect(fila.proxima()).toEqual({ papel: 'po', projectId: 'proj1' })
  })

  it('dois projetos se revezam — um não afoga o outro', () => {
    const fila = criarPassagemDeBastao()
    fila.passar('ra', 'proj1')
    fila.passar('ra', 'proj2')
    expect(fila.proxima()).toEqual({ papel: 'po', projectId: 'proj1' })
    expect(fila.proxima()).toEqual({ papel: 'po', projectId: 'proj2' })
  })

  it('o mesmo papel e projeto repetido não vira fila de duplicatas', () => {
    // O RA pode terminar duas vezes antes de o PO rodar; acordar o PO duas
    // vezes para o mesmo projeto é motor gasto à toa.
    const fila = criarPassagemDeBastao()
    fila.passar('ra', 'proj1')
    fila.passar('ra', 'proj1')
    expect(fila.proxima()).toEqual({ papel: 'po', projectId: 'proj1' })
    expect(fila.proxima()).toBeUndefined()
  })

  it('tamanho conta o que está esperando', () => {
    const fila = criarPassagemDeBastao()
    expect(fila.tamanho()).toBe(0)
    fila.passar('ra', 'proj1')
    fila.passar('po', 'proj2')
    expect(fila.tamanho()).toBe(2)
  })
})

describe('a origem "esteira" fura o descanso', () => {
  it('o bastão acorda o papel mesmo que ele tenha descansado — é informação nova', () => {
    // Sem isto o conserto seria anulado justamente onde importa: o RA
    // terminou e deixou trabalho pronto, e o PO ficaria dormindo o descanso
    // de uma acordada em falso anterior.
    expect(origemFuraODescanso('esteira')).toBe(true)
  })

  it('a agenda continua respeitando o descanso — nada foi afrouxado', () => {
    expect(origemFuraODescanso('agenda')).toBe(false)
  })
})
