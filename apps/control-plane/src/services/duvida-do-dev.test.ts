import { describe, it, expect } from 'vitest'
import {
  ehRespostaUtil,
  destinoDaDuvida,
  destinoAposRa,
  resolvePoliticaDePerguntasAoDono,
  textoDaRespostaAoDev,
  MIN_CARACTERES_DE_RESPOSTA,
} from './duvida-do-dev.js'

describe('ehRespostaUtil — nada de mandar vazio para o dev', () => {
  it('resposta de verdade passa', () => {
    expect(
      ehRespostaUtil(
        'Use argon2id: o repositório já tem a dependência em package.json e o helper em src/lib/hash.ts.'
      )
    ).toBe(true)
  })

  it('vazio e só espaço não passam', () => {
    expect(ehRespostaUtil('')).toBe(false)
    expect(ehRespostaUtil('    \n  ')).toBe(false)
  })

  it('resposta curta demais não passa — "ok" não desbloqueia ninguém', () => {
    expect(ehRespostaUtil('ok')).toBe(false)
    expect(ehRespostaUtil('sim')).toBe(false)
    expect(ehRespostaUtil('a'.repeat(MIN_CARACTERES_DE_RESPOSTA - 1))).toBe(false)
  })

  it('a fuga clássica do modelo não passa por resposta', () => {
    // Um agente que não sabe tende a devolver isto. Mandar para o dev seria
    // pior que o silêncio: ele volta a perguntar e a vaga continua presa.
    expect(ehRespostaUtil('I need more information to answer this question.')).toBe(false)
    expect(ehRespostaUtil('Não sei responder.')).toBe(false)
    expect(ehRespostaUtil('I cannot determine that from the repository.')).toBe(false)
  })
})

describe('destinoDaDuvida — quem responde o quê', () => {
  it('dúvida técnica, com resposta boa: vai para o dev', () => {
    const d = destinoDaDuvida({
      precisaDoDono: false,
      resposta: 'Use argon2id, já está em package.json e o helper vive em src/lib/hash.ts.',
    })
    expect(d.tipo).toBe('responder-o-dev')
  })

  it('o agente dizendo que é decisão de negócio: vai para o DONO, não se inventa', () => {
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'Isso muda o preço cobrado do cliente final; quem decide é o dono.',
    })
    expect(d.tipo).toBe('perguntar-ao-dono')
  })

  it('dúvida técnica com resposta ruim: NÃO manda nada — vai para o RA antes do dono (T14)', () => {
    // A lei do dono: nunca inventar. Uma resposta vazia mandada ao dev é uma
    // mentira educada — ele volta a perguntar e a vaga segue presa. E como
    // isto NÃO é decisão de negócio, o RA tenta primeiro — nunca direto ao dono.
    const d = destinoDaDuvida({ precisaDoDono: false, resposta: 'Não sei.' })
    expect(d.tipo).toBe('escalar-ao-ra')
  })

  it('mesmo dizendo que não precisa do dono, resposta vazia escala ao RA, não ao dono direto', () => {
    const d = destinoDaDuvida({ precisaDoDono: false, resposta: '   ' })
    expect(d.tipo).toBe('escalar-ao-ra')
  })
})

describe('destinoAposRa — depois que o RA também tentou (T14)', () => {
  it('RA respondeu de verdade: vai para o dev', () => {
    const d = destinoAposRa('Use upsert do Prisma aqui — já é o padrão em src/lib/sync-ml.ts.')
    expect(d.tipo).toBe('responder-o-dev')
  })

  it('nem o RA soube: agora sim é o dono, sem mais nenhuma porta técnica', () => {
    const d = destinoAposRa('Não sei responder isso.')
    expect(d.tipo).toBe('perguntar-ao-dono')
  })
})

describe('resolvePoliticaDePerguntasAoDono — config por projeto (T14)', () => {
  it('sem config: default é so-executivo', () => {
    expect(resolvePoliticaDePerguntasAoDono(null)).toBe('so-executivo')
    expect(resolvePoliticaDePerguntasAoDono(undefined)).toBe('so-executivo')
    expect(resolvePoliticaDePerguntasAoDono({})).toBe('so-executivo')
  })

  it('lê o valor configurado quando é válido', () => {
    expect(
      resolvePoliticaDePerguntasAoDono({ perguntasAoDono: 'executivo-e-tecnico-bloqueante' })
    ).toBe('executivo-e-tecnico-bloqueante')
    expect(resolvePoliticaDePerguntasAoDono({ perguntasAoDono: 'tudo' })).toBe('tudo')
  })

  it('valor inválido cai no default seguro', () => {
    expect(resolvePoliticaDePerguntasAoDono({ perguntasAoDono: 'qualquer-coisa' })).toBe(
      'so-executivo'
    )
  })
})

describe('textoDaRespostaAoDev — o que chega na sessão', () => {
  it('leva a resposta inteira, sem cortar', () => {
    const resposta = 'Use argon2id. O helper está em src/lib/hash.ts e já é usado no login.'
    expect(textoDaRespostaAoDev(resposta)).toContain(resposta)
  })

  it('diz de quem veio, para o dev saber que não é o dono digitando', () => {
    expect(textoDaRespostaAoDev('qualquer resposta suficientemente longa aqui')).toMatch(/GitOrch/i)
  })

  it('manda continuar o trabalho — a resposta sozinha não tira a sessão do limbo', () => {
    expect(textoDaRespostaAoDev('qualquer resposta suficientemente longa aqui')).toMatch(
      /continue|siga|prossiga/i
    )
  })
})

describe('a rendição EDUCADA também não passa — foi o buraco da revisão', () => {
  it('"seria preciso testar" não vira resposta, por mais bem escrito que esteja', () => {
    expect(
      ehRespostaUtil(
        'Isso não é algo que dá para confirmar só pelo código disponível; seria preciso testar para ter certeza.'
      )
    ).toBe(false)
  })

  it('"falta contexto" e "depende de" também não', () => {
    expect(
      ehRespostaUtil('A escolha depende de qual banco vocês pretendem usar em produção mais tarde.')
    ).toBe(false)
    expect(
      ehRespostaUtil('Sem mais contexto sobre o ambiente eu não conseguiria indicar um caminho.')
    ).toBe(false)
  })

  it('opinião genérica bem escrita, sem citar NADA do repositório, não passa', () => {
    // Passa no tamanho e não bate em rendição nenhuma — e mesmo assim não move
    // o dev um centímetro.
    expect(
      ehRespostaUtil(
        'Recomendo seguir a abordagem mais moderna e amplamente adotada pela comunidade nesse tipo de caso.'
      )
    ).toBe(false)
  })

  it('resposta que aponta para arquivo, pacote ou símbolo REAL passa', () => {
    expect(
      ehRespostaUtil('Use argon2id — o helper já existe em src/lib/hash.ts e é usado no login.')
    ).toBe(true)
    expect(
      ehRespostaUtil('Chame `hashSenha()` em vez de bcrypt direto; ele já trata o salt por você.')
    ).toBe(true)
  })
})
