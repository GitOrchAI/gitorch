import { describe, it, expect } from 'vitest'
import {
  comoPublicaDeclarado,
  configuracaoAPartirDaResposta,
  desfechoDaPublicacao,
  RESPOSTAS_DE_COMO_PUBLICA,
} from './como-o-projeto-publica.js'
import { chaveDaDuvida } from './duvidas-do-projeto.js'

describe('comoPublicaDeclarado', () => {
  it('lê a resposta que o dono deu à pergunta "como este projeto vai ao ar?"', () => {
    expect(comoPublicaDeclarado({ publicacao: { como: 'publica-em-vm-propria' } })).toBe(
      'publica-em-vm-propria'
    )
  })

  it('resposta desconhecida vira "não sei" — nunca um chute', () => {
    expect(comoPublicaDeclarado({ publicacao: { como: 'sei-la' } })).toBeNull()
    expect(comoPublicaDeclarado({ publicacao: { como: 42 } })).toBeNull()
    expect(comoPublicaDeclarado(null)).toBeNull()
    expect(comoPublicaDeclarado({})).toBeNull()
  })

  it('as quatro respostas do catálogo de dúvidas são todas reconhecidas', () => {
    for (const resposta of RESPOSTAS_DE_COMO_PUBLICA) {
      expect(comoPublicaDeclarado({ publicacao: { como: resposta } })).toBe(resposta)
    }
  })
})

describe('desfechoDaPublicacao — os cinco cenários do dono', () => {
  it('(c) tem CI e CD no GitHub: acompanha lá, como sempre', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-por-workflow',
      mecanismo: { tipo: 'workflow', arquivo: 'cd.yml', nome: 'CD' },
    })
    expect(d.tipo).toBe('acompanhar-no-github')
  })

  it('(d) serviço externo que registra no GitHub: acompanha o registro', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-em-servico-externo',
      mecanismo: { tipo: 'deployment', ambientes: ['production'] },
    })
    expect(d.tipo).toBe('acompanhar-no-github')
  })

  it('(d) serviço externo que NÃO registra nada no GitHub: espera o aviso do próprio serviço', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-em-servico-externo',
      mecanismo: { tipo: 'nenhum' },
    })
    expect(d.tipo).toBe('esperar-aviso')
  })

  it('(e) VM própria: o GitHub nunca vai saber — espera o aviso do CD do cliente', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-em-vm-propria',
      mecanismo: { tipo: 'deployment', ambientes: ['production'] },
    })
    // Mesmo havendo ambiente no GitHub: quem declarou VM própria publica FORA,
    // e o ambiente de lá é de outra coisa (foi exatamente o caso do `copilot`).
    expect(d.tipo).toBe('esperar-aviso')
  })

  it('(a) publica na mão: a entrega termina no merge, e isso é dito com todas as letras', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-manualmente',
      mecanismo: { tipo: 'nenhum' },
    })
    expect(d.tipo).toBe('encerrar-sem-rastreio')
    if (d.tipo !== 'encerrar-sem-rastreio') return
    expect(d.motivo).toMatch(/mão|manual/i)
    // Nunca dizer "no ar" sem prova.
    expect(d.motivo).not.toMatch(/está no ar/i)
  })

  it('(b) tem CI mas não tem CD: encerra dizendo que não há publicação automática', () => {
    const d = desfechoDaPublicacao({
      declarado: 'publica-por-workflow',
      mecanismo: { tipo: 'nenhum' },
    })
    expect(d.tipo).toBe('encerrar-sem-rastreio')
    if (d.tipo !== 'encerrar-sem-rastreio') return
    expect(d.motivo).toMatch(/não encontrei|nenhum/i)
  })

  it('sem resposta do dono e sem mecanismo nenhum: PERGUNTA, não adivinha (D47)', () => {
    const d = desfechoDaPublicacao({ declarado: null, mecanismo: { tipo: 'nenhum' } })
    expect(d.tipo).toBe('perguntar')
  })

  it('sem resposta do dono mas com mecanismo real no GitHub: acompanha, sem incomodar ninguém', () => {
    const d = desfechoDaPublicacao({
      declarado: null,
      mecanismo: { tipo: 'deployment', ambientes: ['github-pages'] },
    })
    expect(d.tipo).toBe('acompanhar-no-github')
  })
})

describe('configuracaoAPartirDaResposta — a resposta do dono vira comportamento', () => {
  const REPO = 'loureng/patinhas-3d-crafts'

  it('a resposta da pergunta certa vira a declaração do projeto', () => {
    expect(
      configuracaoAPartirDaResposta({
        dedupKey: chaveDaDuvida('como-publica', REPO),
        repositorio: REPO,
        resposta: 'publica-em-vm-propria',
      })
    ).toEqual({ publicacao: { como: 'publica-em-vm-propria' } })
  })

  it('o que sai daqui é lido de volta por quem decide — as duas pontas se encontram', () => {
    const config = configuracaoAPartirDaResposta({
      dedupKey: chaveDaDuvida('como-publica', REPO),
      repositorio: REPO,
      resposta: 'publica-manualmente',
    })
    expect(comoPublicaDeclarado(config)).toBe('publica-manualmente')
  })

  it('resposta de OUTRA dúvida não mexe na publicação', () => {
    expect(
      configuracaoAPartirDaResposta({
        dedupKey: chaveDaDuvida('sem-verificacao', REPO),
        repositorio: REPO,
        resposta: 'publica-em-vm-propria',
      })
    ).toBeNull()
  })

  it('a dúvida de OUTRO repositório não vale para este', () => {
    expect(
      configuracaoAPartirDaResposta({
        dedupKey: chaveDaDuvida('como-publica', 'outro/repo'),
        repositorio: REPO,
        resposta: 'publica-em-vm-propria',
      })
    ).toBeNull()
  })

  it('resposta fora do catálogo não vira configuração nenhuma', () => {
    expect(
      configuracaoAPartirDaResposta({
        dedupKey: chaveDaDuvida('como-publica', REPO),
        repositorio: REPO,
        resposta: 'sei-la-onde',
      })
    ).toBeNull()
  })
})
