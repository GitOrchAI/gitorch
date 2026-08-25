import { describe, it, expect } from 'vitest'
import {
  decidirQuemResolve,
  ehConflitoDeMerge,
  MAX_PEDIDOS_DE_REBASE,
} from './conflito-de-merge.js'

const CONFLITO =
  'GitHub PUT /repos/o/r/pulls/3762/merge failed (405): {"message":"Pull Request has merge conflicts"}'

describe('ehConflitoDeMerge', () => {
  // O caso real que chegou ao Telegram do dono.
  it('reconhece a mensagem que o GitHub devolve', () => {
    expect(ehConflitoDeMerge(CONFLITO)).toBe(true)
  })

  // O mesmo código 405 cobre várias recusas, e o dev não resolve nenhuma das
  // outras. Casar pelo código trataria todas como conflito.
  it.each([
    'At least 1 approving review is required',
    'Required status check "build" is expected',
    'Resource not accessible by integration',
    null,
    undefined,
  ])('não confunde outra recusa (%s) com conflito', (motivo) => {
    expect(ehConflitoDeMerge(motivo)).toBe(false)
  })
})

describe('decidirQuemResolve', () => {
  const base = { motivo: CONFLITO, temSessaoViva: true, pedidosDeRebase: 0, numeroDoPr: 3762 }

  it('conflito com sessão viva: o DEV resolve', () => {
    const d = decidirQuemResolve(base)
    expect(d.quem).toBe('dev')
    if (d.quem !== 'dev') throw new Error('esperava dev')
    expect(d.pedido).toContain('#3762')
    expect(d.pedido).toMatch(/conflito/i)
    // O pedido precisa dizer o que fazer, não só que deu errado.
    expect(d.pedido).toMatch(/rebase|base/i)
    // E precisa impedir o dev de "aproveitar" para mexer noutras coisas.
    expect(d.pedido).toMatch(/fora do escopo/i)
  })

  // Proteção de branch, permissão, check vermelho: o dev não resolve nenhum
  // deles, e insistir seria empurrar trabalho impossível.
  it('recusa que não é conflito vai direto para o dono', () => {
    const d = decidirQuemResolve({ ...base, motivo: 'At least 1 approving review is required' })
    expect(d.quem).toBe('dono')
    if (d.quem !== 'dono') throw new Error('esperava dono')
    expect(d.motivo).toMatch(/não é conflito/i)
  })

  // Pedir para o vazio deixaria a entrega parada em silêncio.
  it('sem sessão viva não há a quem pedir: o dono é chamado', () => {
    const d = decidirQuemResolve({ ...base, temSessaoViva: false })
    expect(d.quem).toBe('dono')
    if (d.quem !== 'dono') throw new Error('esperava dono')
    expect(d.motivo).toMatch(/encerrada/i)
  })

  // Se o dev não resolveu na segunda, insistir queima cota e adia o momento em
  // que o dono descobre.
  it('passado o teto de pedidos, o dono assume', () => {
    const d = decidirQuemResolve({ ...base, pedidosDeRebase: MAX_PEDIDOS_DE_REBASE })
    expect(d.quem).toBe('dono')
    if (d.quem !== 'dono') throw new Error('esperava dono')
    expect(d.motivo).toContain(String(MAX_PEDIDOS_DE_REBASE))
  })

  it('dentro do teto continua sendo o dev', () => {
    expect(decidirQuemResolve({ ...base, pedidosDeRebase: MAX_PEDIDOS_DE_REBASE - 1 }).quem).toBe(
      'dev'
    )
  })
})
