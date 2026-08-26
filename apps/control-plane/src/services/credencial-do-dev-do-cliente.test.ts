import { describe, it, expect } from 'vitest'
import {
  identidadeDaConta,
  resolverCredencialDoDev,
  ERRO_CREDENCIAL_ILEGIVEL,
} from './credencial-do-dev-do-cliente.js'
import { CONTA_DA_INSTANCIA } from './conta-do-dev-externo.js'

describe('identidadeDaConta', () => {
  it('a mesma chave dá sempre a mesma identidade — é o que faz dois projetos do mesmo cliente somarem cota', () => {
    expect(identidadeDaConta('chave-do-cliente')).toBe(identidadeDaConta('chave-do-cliente'))
  })

  it('chaves diferentes dão contas diferentes — um cliente nunca consome o teto do outro', () => {
    expect(identidadeDaConta('cliente-a')).not.toBe(identidadeDaConta('cliente-b'))
  })

  it('a identidade NÃO carrega a chave dentro: ela vai para log e para o banco', () => {
    const segredo = 'jules-key-super-secreta-123'
    const id = identidadeDaConta(segredo)
    expect(id).not.toContain(segredo)
    expect(id).not.toContain('secreta')
    // Curta o bastante para caber num log sem virar parede de texto.
    expect(id.length).toBeLessThanOrEqual(24)
  })
})

describe('resolverCredencialDoDev', () => {
  it('sem credencial própria, cai na conta da instância (o dono continua funcionando)', () => {
    const r = resolverCredencialDoDev({
      credencialCifrada: null,
      chaveDaInstancia: 'chave-do-dono',
      decifrar: () => {
        throw new Error('não devia ser chamado')
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chave).toBe('chave-do-dono')
    expect(r.conta).toBe(CONTA_DA_INSTANCIA)
  })

  it('com credencial própria, usa a chave DO CLIENTE e uma conta própria', () => {
    const r = resolverCredencialDoDev({
      credencialCifrada: 'envelope',
      chaveDaInstancia: 'chave-do-dono',
      decifrar: () => 'chave-do-cliente',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chave).toBe('chave-do-cliente')
    expect(r.conta).toBe(identidadeDaConta('chave-do-cliente'))
    expect(r.conta).not.toBe(CONTA_DA_INSTANCIA)
  })

  it('dois projetos do MESMO cliente caem na mesma conta mesmo com envelopes diferentes', () => {
    const um = resolverCredencialDoDev({
      credencialCifrada: 'envelope-1',
      chaveDaInstancia: 'x',
      decifrar: () => 'mesma-chave',
    })
    const dois = resolverCredencialDoDev({
      credencialCifrada: 'envelope-2-outro-iv',
      chaveDaInstancia: 'x',
      decifrar: () => 'mesma-chave',
    })
    expect(um.ok && dois.ok && um.conta === dois.conta).toBe(true)
  })

  it('credencial ilegível RECUSA — nunca cai calada na conta do dono, que é dinheiro dele', () => {
    const r = resolverCredencialDoDev({
      credencialCifrada: 'envelope-corrompido',
      chaveDaInstancia: 'chave-do-dono',
      decifrar: () => {
        throw new Error('bad decrypt')
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe(ERRO_CREDENCIAL_ILEGIVEL)
  })

  it('credencial que decifra para vazio também recusa', () => {
    const r = resolverCredencialDoDev({
      credencialCifrada: 'envelope',
      chaveDaInstancia: 'chave-do-dono',
      decifrar: () => '   ',
    })
    expect(r.ok).toBe(false)
  })

  it('sem credencial própria E sem chave da instância, recusa em vez de chamar a API sem chave', () => {
    const r = resolverCredencialDoDev({
      credencialCifrada: null,
      chaveDaInstancia: undefined,
      decifrar: () => 'nunca',
    })
    expect(r.ok).toBe(false)
  })
})

describe('a etiqueta da conta não leva de volta à chave', () => {
  it('muda quando a chave do servidor muda — etiqueta velha não sobrevive a giro de chave', () => {
    const original = process.env['GITORCH_CREDENTIAL_KEY']
    try {
      process.env['GITORCH_CREDENTIAL_KEY'] = 'a'.repeat(64)
      const comUmaChave = identidadeDaConta('mesma-chave-do-cliente')
      process.env['GITORCH_CREDENTIAL_KEY'] = 'b'.repeat(64)
      const comOutra = identidadeDaConta('mesma-chave-do-cliente')
      expect(comUmaChave).not.toBe(comOutra)
    } finally {
      if (original === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
      else process.env['GITORCH_CREDENTIAL_KEY'] = original
    }
  })

  it('NÃO é um resumo simples da chave: quem só tem a etiqueta não consegue recalculá-la sozinho', async () => {
    const { createHash } = await import('node:crypto')
    const chave = 'chave-do-cliente-abc'
    const resumoSimples = `conta-${createHash('sha256').update(chave).digest('hex').slice(0, 16)}`
    expect(identidadeDaConta(chave)).not.toBe(resumoSimples)
  })
})
