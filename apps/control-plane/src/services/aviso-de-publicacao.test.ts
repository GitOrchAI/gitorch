import { describe, it, expect } from 'vitest'
import { decidirSobreAviso, PREFIXO_DA_CHAVE } from './aviso-de-publicacao.js'

const AGORA = new Date('2026-08-26T10:00:00Z')

describe('decidirSobreAviso — quem publica fora do GitHub avisa o produto', () => {
  it('aviso de sucesso para uma entrega mesclada: dá o veredito de no ar', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'abc123', closedAt: null },
      commitAvisado: 'abc123',
      sucesso: true,
      agora: AGORA,
    })
    expect(d).toEqual({ acao: 'registrar', estado: 'no-ar' })
  })

  it('aviso de falha: registra que falhou, e nunca diz que está no ar', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'abc123', closedAt: null },
      commitAvisado: 'abc123',
      sucesso: false,
      agora: AGORA,
    })
    expect(d).toEqual({ acao: 'registrar', estado: 'falhou' })
  })

  it('commit que não é o da entrega: recusa — avisar da versão errada é pior que não avisar', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'abc123', closedAt: null },
      commitAvisado: 'outro999',
      sucesso: true,
      agora: AGORA,
    })
    expect(d.acao).toBe('recusar')
  })

  it('o commit é comparado inteiro, não por prefixo curto', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'abc123def456', closedAt: null },
      commitAvisado: 'abc123',
      sucesso: true,
      agora: AGORA,
    })
    expect(d.acao).toBe('recusar')
  })

  it('maiúscula/minúscula não importa: o mesmo commit é o mesmo commit', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'ABC123', closedAt: null },
      commitAvisado: 'abc123',
      sucesso: true,
      agora: AGORA,
    })
    expect(d).toEqual({ acao: 'registrar', estado: 'no-ar' })
  })

  it('entrega já encerrada: ignora sem erro — reenvio do CD do cliente é normal', () => {
    const d = decidirSobreAviso({
      entrega: { sessionName: 'sessions/1', mergeCommitSha: 'abc123', closedAt: AGORA },
      commitAvisado: 'abc123',
      sucesso: true,
      agora: AGORA,
    })
    expect(d.acao).toBe('ignorar')
  })

  it('nenhuma entrega para aquele commit: ignora, não inventa uma', () => {
    const d = decidirSobreAviso({
      entrega: null,
      commitAvisado: 'abc123',
      sucesso: true,
      agora: AGORA,
    })
    expect(d.acao).toBe('ignorar')
  })
})

describe('PREFIXO_DA_CHAVE', () => {
  it('é o prefixo real das chaves emitidas pelo wizard', () => {
    expect('gitorch_abc123def456'.startsWith(PREFIXO_DA_CHAVE)).toBe(true)
  })
})
