import { describe, it, expect } from 'vitest'
import { licencasProblematicas, achadosDePii } from './conformidade-do-repositorio.js'

describe('licencasProblematicas', () => {
  it('marca licenças copyleft fortes (GPL) como problemáticas; MIT/Apache/BSD não', () => {
    const r = licencasProblematicas(
      [
        { nome: 'left-pad', licenca: 'MIT' },
        { nome: 'algo-gpl', licenca: 'GPL-3.0' },
        { nome: 'algo-agpl', licenca: 'AGPL-3.0' },
      ],
      ['GPL-3.0', 'AGPL-3.0', 'AGPL-1.0']
    )
    expect(r.map((l) => l.nome)).toEqual(['algo-gpl', 'algo-agpl'])
  })
})

describe('achadosDePii', () => {
  it('acha padrão de CPF em migração/schema', () => {
    const achados = achadosDePii('CREATE TABLE clientes (cpf TEXT, telefone TEXT)')
    expect(achados.some((a) => a.includes('cpf'))).toBe(true)
  })
  it('schema sem sinal de PII: lista vazia', () => {
    expect(achadosDePii('CREATE TABLE eventos (id TEXT, payload JSONB)')).toEqual([])
  })
})

import { conferirConformidade } from './conformidade-do-repositorio.js'

describe('conferirConformidade', () => {
  it('junta licenças, PII e os achados de documento/Actions injetados', async () => {
    const resultado = await conferirConformidade({
      listarLicencas: async () => [{ nome: 'pacote-gpl', licenca: 'GPL-3.0' }],
      listaNegraDeLicenca: ['GPL-3.0'],
      conteudoDeSchemaEMigracoes: 'CREATE TABLE x (email TEXT)',
      codeownersAusente: true,
      securityMdAusente: false,
      actionsSemSha: true,
    })
    expect(resultado.licencasProblematicas).toEqual([{ nome: 'pacote-gpl', licenca: 'GPL-3.0' }])
    expect(resultado.achadosDePii.length).toBeGreaterThan(0)
    expect(resultado.codeownersAusente).toBe(true)
  })
})
