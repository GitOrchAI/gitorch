import { describe, expect, it } from 'vitest'
import {
  INTERRUPTOR_GERAL_DA_SEGURANCA,
  INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA,
  INTERRUPTOR_POR_MELHORIA,
  MELHORIAS_DE_SEGURANCA,
  melhoriaDeSegurancaLigada,
  projetoNaAllowlistDaSeguranca,
  idBaseDaMelhoria,
} from './interruptores-de-seguranca.js'

describe('interruptores da aplicação de segurança', () => {
  it('cada peça tem a sua variável, todas com o prefixo combinado e sem repetição', () => {
    const nomes = Object.values(INTERRUPTOR_POR_MELHORIA)
    expect(new Set(nomes).size).toBe(nomes.length)
    for (const nome of nomes) expect(nome).toMatch(/^GITORCH_APLICAR_SEGURANCA_[A-Z_]+$/)
    expect(Object.keys(INTERRUPTOR_POR_MELHORIA).sort()).toEqual([...MELHORIAS_DE_SEGURANCA].sort())
    expect(INTERRUPTOR_GERAL_DA_SEGURANCA).toBe('GITORCH_APLICAR_SEGURANCA')
    expect(INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA).toBe('GITORCH_APLICAR_SEGURANCA_EM')
  })

  it('sem nenhuma variável tudo vem LIGADO (decisão do dono)', () => {
    for (const melhoria of MELHORIAS_DE_SEGURANCA) {
      expect(melhoriaDeSegurancaLigada(melhoria, {})).toBe(true)
    }
  })

  it.each(['0', 'false', 'off', 'nao', 'não', 'desligado', ' FALSE ', 'Off'])(
    'o valor explícito "%s" no interruptor geral desliga todas as peças',
    (valor) => {
      for (const melhoria of MELHORIAS_DE_SEGURANCA) {
        expect(
          melhoriaDeSegurancaLigada(melhoria, { [INTERRUPTOR_GERAL_DA_SEGURANCA]: valor })
        ).toBe(false)
      }
    }
  )

  it('desligar UMA peça não desliga as outras', () => {
    for (const desligada of MELHORIAS_DE_SEGURANCA) {
      const env = { [INTERRUPTOR_POR_MELHORIA[desligada]]: 'off' }
      for (const melhoria of MELHORIAS_DE_SEGURANCA) {
        expect(melhoriaDeSegurancaLigada(melhoria, env)).toBe(melhoria !== desligada)
      }
    }
  })

  it('texto vazio ou desconhecido não desliga nada por engano', () => {
    for (const valor of ['', '   ', 'talvez', 'sim', '1', 'true', 'on']) {
      expect(
        melhoriaDeSegurancaLigada('alertas-de-dependencias', {
          [INTERRUPTOR_GERAL_DA_SEGURANCA]: valor,
          [INTERRUPTOR_POR_MELHORIA['alertas-de-dependencias']]: valor,
        })
      ).toBe(true)
    }
  })

  it('a instância de uma peça por arquivo ("permissoes-minimas:caminho") usa o interruptor da peça-mãe', () => {
    const env = { [INTERRUPTOR_POR_MELHORIA['permissoes-minimas-dos-workflows']]: 'off' }
    expect(melhoriaDeSegurancaLigada('permissoes-minimas-dos-workflows', env)).toBe(false)
    expect(idBaseDaMelhoria('permissoes-minimas-dos-workflows:.github/workflows/ci.yml')).toBe(
      'permissoes-minimas-dos-workflows'
    )
    expect(idBaseDaMelhoria('alertas-de-dependencias')).toBe('alertas-de-dependencias')
    expect(idBaseDaMelhoria('qualquer-coisa')).toBeNull()
  })
})

describe('allowlist de projetos da aplicação de segurança', () => {
  const projeto = { id: 'cm123', wingId: 'GitOrchAI/gitorch' }

  it('sem a variável, vale "todos"', () => {
    expect(projetoNaAllowlistDaSeguranca(projeto, {})).toBe(true)
  })

  it('"todos" (em qualquer caixa) libera todos', () => {
    expect(
      projetoNaAllowlistDaSeguranca(projeto, { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: ' TODOS ' })
    ).toBe(true)
  })

  it('lista por repositório, sem diferenciar caixa nem espaços', () => {
    const env = {
      [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'outra/coisa , gitorchai/GitOrch',
    }
    expect(projetoNaAllowlistDaSeguranca(projeto, env)).toBe(true)
    expect(projetoNaAllowlistDaSeguranca({ id: 'x', wingId: 'acme/api' }, env)).toBe(false)
  })

  it('lista por id do projeto', () => {
    const env = { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'cm123' }
    expect(projetoNaAllowlistDaSeguranca(projeto, env)).toBe(true)
    expect(projetoNaAllowlistDaSeguranca({ id: 'cm999', wingId: 'acme/api' }, env)).toBe(false)
  })

  it('variável definida e VAZIA não libera ninguém (falha fechada)', () => {
    for (const valor of ['', '   ', ' , ,']) {
      expect(
        projetoNaAllowlistDaSeguranca(projeto, { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: valor })
      ).toBe(false)
    }
  })

  it('um nome parecido não vale: a comparação é exata', () => {
    const env = { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'gitorchai/gitorch-outro' }
    expect(projetoNaAllowlistDaSeguranca(projeto, env)).toBe(false)
  })
})
