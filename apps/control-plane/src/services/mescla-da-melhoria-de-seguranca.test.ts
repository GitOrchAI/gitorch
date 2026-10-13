import { describe, expect, it } from 'vitest'
import {
  ehVerificacaoDeSegredos,
  modoDaSeguranca,
  NOMES_PADRAO_DE_VERIFICACAO_DE_SEGREDOS,
  textoDaPerguntaDeMescla,
  textoDoAlertaDeSegredo,
  textoDoAvisoDeMesclada,
  VARIAVEL_DOS_NOMES_DE_VERIFICACAO_DE_SEGREDOS,
} from './mescla-da-melhoria-de-seguranca.js'

describe('verificação de segredos pelo nome do check', () => {
  it.each([
    'gitleaks',
    'Gitleaks scan',
    'Secret scan (GitOrch)',
    'trufflehog',
    'detect-secrets',
    'Segurança — Secrets + Audit',
  ])('%s é de segredos', (nome) => {
    expect(ehVerificacaoDeSegredos(nome)).toBe(true)
  })

  it.each(['test', 'build', 'lint', 'Testes Backend — Vitest', 'CodeQL'])(
    '%s não é de segredos',
    (nome) => {
      expect(ehVerificacaoDeSegredos(nome)).toBe(false)
    }
  )

  it('a lista é configurável: o valor da variável substitui a padrão', () => {
    const env = { [VARIAVEL_DOS_NOMES_DE_VERIFICACAO_DE_SEGREDOS]: ' Cofre , scan-chaves ' }
    expect(ehVerificacaoDeSegredos('scan-chaves do time', env)).toBe(true)
    expect(ehVerificacaoDeSegredos('Cofre', env)).toBe(true)
    expect(ehVerificacaoDeSegredos('gitleaks', env)).toBe(false)
  })

  it('variável vazia volta para a lista padrão (nunca desliga a trava)', () => {
    const env = { [VARIAVEL_DOS_NOMES_DE_VERIFICACAO_DE_SEGREDOS]: ' , ' }
    expect(ehVerificacaoDeSegredos('gitleaks', env)).toBe(true)
    expect(NOMES_PADRAO_DE_VERIFICACAO_DE_SEGREDOS.length).toBeGreaterThan(0)
  })
})

describe('modo da segurança: vale o mais restrito dos dois campos', () => {
  it.each([
    ['cuidar', 'cuidar', 'cuidar'],
    ['cuidar', 'sugerir', 'sugerir'],
    ['sugerir', 'cuidar', 'sugerir'],
    ['cuidar', 'so_olhar', 'so_olhar'],
    ['sugerir', 'sugerir', 'sugerir'],
    [null, 'cuidar', 'so_olhar'],
    ['qualquer-coisa', 'cuidar', 'so_olhar'],
  ] as const)('%s + %s = %s', (autonomia, seguranca, esperado) => {
    expect(modoDaSeguranca({ autonomia, autonomiaDeSeguranca: seguranca })).toBe(esperado)
  })
})

describe('textos ao dono', () => {
  it('o aviso de mesclada diz o que mudou, onde e como desfazer', () => {
    const t = textoDoAvisoDeMesclada({
      repositorio: 'acme/api',
      numero: 7,
      nome: 'permissões mínimas do workflow',
      url: 'https://github.com/acme/api/pull/7',
    })
    expect(t).toContain('acme/api')
    expect(t).toContain('#7')
    expect(t).toMatch(/reverta o pull request #7/)
  })

  it('o alerta de segredo manda trocar o segredo, leva o link e não traz valor', () => {
    const t = textoDoAlertaDeSegredo({
      repositorio: 'acme/api',
      numero: 7,
      checks: ['gitleaks'],
      url: 'https://github.com/acme/api/runs/9',
    })
    expect(t).toMatch(/Troque esse segredo/)
    expect(t).toContain('https://github.com/acme/api/runs/9')
    expect(t).toContain('Não mesclei nada')
  })

  it('a pergunta traz o que muda, por que é mais seguro, risco e como desfazer', () => {
    const t = textoDaPerguntaDeMescla({
      repositorio: 'acme/api',
      numero: 7,
      idBase: 'permissoes-minimas-dos-workflows',
      nome: 'permissões mínimas do workflow',
    })
    for (const parte of ['O que muda', 'Por que é mais seguro', 'Risco', 'Como desfazer']) {
      expect(t).toContain(parte)
    }
  })
})
