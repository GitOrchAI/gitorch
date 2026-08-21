import { describe, expect, it } from 'vitest'
import { nomeDeRepositorioValido } from './nome-de-repositorio.js'

// A guarda da PORTA: este valor vai colado numa URL que carrega credencial
// (`https://api.github.com/repos/${repo}/...`). Se ele puder ser qualquer
// texto, quem escolhe o texto escolhe o endpoint que o produto chama com o
// token na mão. Por isso o teste cobre o formato exato, não "parece um repo".

describe('nomeDeRepositorioValido', () => {
  it('aceita o caso feliz "dono/repositorio"', () => {
    expect(nomeDeRepositorioValido('dono/loja')).toBe(true)
  })

  it('aceita nome legítimo com ponto, hífen e underscore', () => {
    expect(nomeDeRepositorioValido('acme-corp/minha_loja.js')).toBe(true)
  })

  it('recusa travessia de diretório', () => {
    // A normalização de URL come o ".." ANTES de a requisição sair: veja o
    // teste de desejo-no-github que prova o endereço final.
    expect(nomeDeRepositorioValido('a/b/../../../user/repos')).toBe(false)
    expect(nomeDeRepositorioValido('../user/repos')).toBe(false)
    expect(nomeDeRepositorioValido('a/..')).toBe(false)
    expect(nomeDeRepositorioValido('a/.')).toBe(false)
  })

  it('recusa barra a mais', () => {
    expect(nomeDeRepositorioValido('a/b/c')).toBe(false)
  })

  it('recusa segmento vazio', () => {
    expect(nomeDeRepositorioValido('/b')).toBe(false)
    expect(nomeDeRepositorioValido('a/')).toBe(false)
    expect(nomeDeRepositorioValido('/')).toBe(false)
    expect(nomeDeRepositorioValido('')).toBe(false)
  })

  it('recusa espaço', () => {
    expect(nomeDeRepositorioValido('a b/c')).toBe(false)
    expect(nomeDeRepositorioValido('a/b c')).toBe(false)
    expect(nomeDeRepositorioValido(' dono/loja')).toBe(false)
  })

  it('recusa esquema de URL', () => {
    expect(nomeDeRepositorioValido('https://x/y')).toBe(false)
  })

  it('recusa arroba (credencial embutida ou host alternativo)', () => {
    expect(nomeDeRepositorioValido('a@b/c')).toBe(false)
    expect(nomeDeRepositorioValido('git@github.com/x')).toBe(false)
  })

  it('recusa nome com 300 caracteres', () => {
    expect(nomeDeRepositorioValido(`dono/${'r'.repeat(300)}`)).toBe(false)
    expect(nomeDeRepositorioValido(`${'d'.repeat(300)}/loja`)).toBe(false)
  })

  it('recusa o que truncaria a URL por query, fragmento ou codificação', () => {
    // "../user/repos?" vira exatamente POST https://api.github.com/user/repos
    // — criar repositório na conta do App, com o token junto.
    expect(nomeDeRepositorioValido('../user/repos?')).toBe(false)
    expect(nomeDeRepositorioValido('a/b?x=')).toBe(false)
    expect(nomeDeRepositorioValido('a/b#')).toBe(false)
    expect(nomeDeRepositorioValido('a/%2e%2e')).toBe(false)
    expect(nomeDeRepositorioValido('a\\b/c')).toBe(false)
    expect(nomeDeRepositorioValido('a/b\nc')).toBe(false)
  })

  it('recusa hífen no começo ou no fim do dono (login inválido no GitHub)', () => {
    expect(nomeDeRepositorioValido('-dono/loja')).toBe(false)
    expect(nomeDeRepositorioValido('dono-/loja')).toBe(false)
    expect(nomeDeRepositorioValido('dono.x/loja')).toBe(false)
  })

  it('recusa o que não é texto', () => {
    expect(nomeDeRepositorioValido(undefined as unknown as string)).toBe(false)
    expect(nomeDeRepositorioValido(null as unknown as string)).toBe(false)
    expect(nomeDeRepositorioValido(123 as unknown as string)).toBe(false)
  })
})
