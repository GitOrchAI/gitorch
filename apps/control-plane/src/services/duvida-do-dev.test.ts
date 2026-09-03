import { describe, it, expect } from 'vitest'
import {
  ehRespostaUtil,
  citaAlgoConcreto,
  destinoDaDuvida,
  destinoAposRa,
  resolvePoliticaDePerguntasAoDono,
  devoAvisarDonoDeBloqueioResolvido,
  textoDaRespostaAoDev,
  pareceTrabalhoJaFeito,
  classificarMensagemDoDev,
  textoParaRelatorioDeConclusao,
  textoParaPedidoDeAprovacaoDePlano,
  MIN_CARACTERES_DE_RESPOSTA,
} from './duvida-do-dev.js'

// L4-T4 (D64): exportada para `suporSemODono` (duvida-rails-mission.ts)
// aplicar o MESMO freio de concretude à suposição do RA. Estes testes
// provam que a extração não mudou o comportamento — `ehRespostaUtil` reusa
// esta mesma função (ver os testes de "cita algo concreto" mais abaixo).
describe('citaAlgoConcreto — a suposição/resposta aponta para algo real do repositório?', () => {
  it('arquivo com extensão real passa', () => {
    expect(citaAlgoConcreto('veja src/lib/hash.ts')).toBe(true)
  })

  it('crase com código passa', () => {
    expect(citaAlgoConcreto('chame `hashSenha()`')).toBe(true)
  })

  it('função() sem crase passa', () => {
    expect(citaAlgoConcreto('chame hashSenha() direto')).toBe(true)
  })

  it('caminho src/apps/packages/lib/scripts passa', () => {
    expect(citaAlgoConcreto('está em packages/cadence/src/rails.ts')).toBe(true)
  })

  it('opinião genérica sem nada concreto não passa', () => {
    expect(citaAlgoConcreto('acho que dá para usar qualquer biblioteca de hash conhecida')).toBe(
      false
    )
  })
})

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

  // D14, 01/09 — CASO REAL: tarefa #46 de GitOrchAI/gitorch. O dev perguntou
  // (em inglês, cru) se o /wishlist já implementado no commit d175cb70 devia
  // virar PR vazio ou se faltava registrar via setMyCommands — o modelo
  // marcou precisaDoDono=true e acordou o dono à toa. Isto é decisão
  // técnica/de processo, nunca decisão de negócio.
  it('D14: pergunta "já está feito, o que faço" NÃO vai para o dono mesmo com precisaDoDono=true', () => {
    const perguntaReal =
      'I have explored the codebase and the task is to "Register the `/wishlist` command in the ' +
      'Telegram plugin to respond with a basic usage message." However, looking at the code in ' +
      '`apps/control-plane/src/plugins/telegram.ts`, the exact implementation for `/wishlist` to ' +
      'respond with `Use /wishlist add <item>` is already present, as it was added in commit ' +
      '`d175cb705b2b132fc11b1e175f9914a7916f12f2`. Could you advise on what exactly needs to be ' +
      'done? Should I just verify the functionality and open an empty or formatting PR to close ' +
      'the issue, or is there another file or specific registration method I am supposed to add?'
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'não sei se é decisão de negócio ou não',
      pergunta: perguntaReal,
    })
    expect(d.tipo).toBe('escalar-ao-ra')
    expect(d.tipo === 'escalar-ao-ra' && d.motivo).toContain('trabalho já feito')
  })

  it('D14: "já está feito" em português também é pego pelo freio', () => {
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'x',
      pergunta: 'Essa funcionalidade já está implementada no commit abc123, o que eu faço agora?',
    })
    expect(d.tipo).toBe('escalar-ao-ra')
  })

  it('D14: decisão de negócio DE VERDADE (sem sinal de "já feito") continua indo para o dono', () => {
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'Isso muda o preço cobrado do cliente final; quem decide é o dono.',
      pergunta: 'Should the wishlist feature be free for all users or only for paying customers?',
    })
    expect(d.tipo).toBe('perguntar-ao-dono')
  })

  it('D14: carrega perguntaExecutiva e opções quando o modelo já traduziu', () => {
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'y',
      pergunta: 'Should this feature be free or paid?',
      perguntaExecutiva: 'A funcionalidade X deve ser grátis ou paga?',
      opcoes: [
        { label: 'Grátis para todos', value: 'gratis' },
        { label: 'Só para pagantes', value: 'pago' },
      ],
    })
    expect(d.tipo).toBe('perguntar-ao-dono')
    if (d.tipo === 'perguntar-ao-dono') {
      expect(d.perguntaExecutiva).toBe('A funcionalidade X deve ser grátis ou paga?')
      expect(d.opcoes).toHaveLength(2)
    }
  })

  it('D14: sem perguntaExecutiva/opções do modelo, o destino não inventa nenhuma', () => {
    const d = destinoDaDuvida({
      precisaDoDono: true,
      resposta: 'y',
      pergunta: 'Should this feature be free or paid?',
    })
    expect(d.tipo).toBe('perguntar-ao-dono')
    if (d.tipo === 'perguntar-ao-dono') {
      expect(d.perguntaExecutiva).toBeUndefined()
      expect(d.opcoes).toBeUndefined()
    }
  })
})

describe('pareceTrabalhoJaFeito', () => {
  it('pega variações comuns em inglês', () => {
    expect(pareceTrabalhoJaFeito('this is already implemented in commit abc')).toBe(true)
    expect(pareceTrabalhoJaFeito('the bug has already been fixed')).toBe(true)
    expect(pareceTrabalhoJaFeito('this feature is already done')).toBe(true)
  })

  it('pega variações em português', () => {
    expect(pareceTrabalhoJaFeito('isso já está implementado, o que eu faço?')).toBe(true)
    expect(pareceTrabalhoJaFeito('já foi corrigido no commit anterior')).toBe(true)
  })

  it('não dispara em pergunta de negócio sem sinal de trabalho pronto', () => {
    expect(pareceTrabalhoJaFeito('should this be free or paid for customers?')).toBe(false)
    expect(pareceTrabalhoJaFeito('qual preço devo cobrar do cliente final?')).toBe(false)
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

describe('devoAvisarDonoDeBloqueioResolvido — quem fica sabendo depois que o time resolveu sozinho (revisão pós-D72)', () => {
  it('so-executivo: nunca avisa — é a política de quem só quer ver decisão de negócio', () => {
    expect(devoAvisarDonoDeBloqueioResolvido('so-executivo')).toBe(false)
  })

  it('executivo-e-tecnico-bloqueante: avisa — é a política que existe PARA isto (defeito real: virava idêntica a so-executivo)', () => {
    expect(devoAvisarDonoDeBloqueioResolvido('executivo-e-tecnico-bloqueante')).toBe(true)
  })

  it('tudo: avisa — visibilidade total', () => {
    expect(devoAvisarDonoDeBloqueioResolvido('tudo')).toBe(true)
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

// D72 (02/09) — o dono recebeu 4 "Esperando você" no painel/Telegram que NÃO
// eram perguntas: relatório de conclusão do dev tratado como se fosse uma
// dúvida técnica sem resposta. `responderDuvidaPendente` (scheduler.ts) lia a
// ÚLTIMA MENSAGEM da sessão AWAITING_USER_FEEDBACK e mandava direto para a
// missão de QA "responda esta pergunta" — mesmo quando não havia pergunta
// nenhuma. Esta porta roda ANTES das 3 portas de `destinoDaDuvida` (que
// continuam do jeito que estão) e intercepta o caso comum: o dev não
// perguntou nada, só avisou que terminou (ou pediu aprovação de plano).
describe('classificarMensagemDoDev — a mensagem do dev É uma pergunta?', () => {
  it('relatório de conclusão real (tarefa #309, GitOrchAI/gitorch) — texto EXATO que chegou ao dono', () => {
    const mensagem =
      'I have successfully modified the code and verified the tests are passing. ' +
      '1. In packages/github-sync/src/webhook-normalizer.ts, I mapped wishCreatedAt to ' +
      'optionalString(issue, created_at). 2. In packages/cadence/src/incremento.ts, I added ' +
      'wishCreatedAt and mergedAt to the FatosDaEntrega interface. 3. In ' +
      'packages/github-sync/src/sync-engine.ts, I updated OperationPlan to include the new fields.'
    expect(classificarMensagemDoDev(mensagem)).toBe('relatorio-de-conclusao')
  })

  it('verbos de conclusão em PT-BR também contam', () => {
    expect(classificarMensagemDoDev('Implementado com sucesso, todos os testes passando.')).toBe(
      'relatorio-de-conclusao'
    )
    expect(classificarMensagemDoDev('Tarefa concluída, aguardando revisão.')).toBe(
      'relatorio-de-conclusao'
    )
  })

  it('presença de "?" NUNCA é relatório de conclusão, mesmo citando "successfully"', () => {
    expect(
      classificarMensagemDoDev(
        'I successfully implemented most of it, but should I also update the docs?'
      )
    ).toBe('pergunta')
  })

  it('pedido de aprovação de plano — linguagem explícita de aprovação', () => {
    expect(
      classificarMensagemDoDev('The plan is ready. Waiting for approval before I proceed.')
    ).toBe('pedido-de-aprovacao-de-plano')
    expect(classificarMensagemDoDev('Estou aguardando aprovação do plano para continuar.')).toBe(
      'pedido-de-aprovacao-de-plano'
    )
  })

  it('mencionar "plan" sem ser sobre aprovação NÃO vira pedido de aprovação — é pergunta de verdade (tarefa #309, 2ª dúvida)', () => {
    // Texto real do segundo print do dono: o dev menciona "the plan" (feedback
    // de review), mas a pergunta de verdade é sobre ignorar uma restrição de
    // memória — isto tem que seguir pela porta normal de pergunta técnica,
    // nunca ser confundido com "pedido de aprovação de plano".
    const mensagem =
      "The review feedback told me: 'The plan completely omits the required changes for " +
      'packages/github-sync/src/sync-engine.ts and apps/control-plane/src/plugins/prisma.ts ' +
      'requested in the issue… remembering that explicit user instructions supersede memory ' +
      "constraints.' Wait, I asked for clarification on whether I should ignore the memory " +
      'constraints about prisma.ts, and the automated response e...'
    expect(classificarMensagemDoDev(mensagem)).toBe('pergunta')
  })

  it('pergunta técnica comum continua "pergunta"', () => {
    expect(classificarMensagemDoDev('Should I use bcrypt or argon2 for password hashing?')).toBe(
      'pergunta'
    )
  })

  it('vazio/whitespace é tratado como pergunta (deixa o resto do pipeline decidir)', () => {
    expect(classificarMensagemDoDev('')).toBe('pergunta')
    expect(classificarMensagemDoDev('   ')).toBe('pergunta')
  })
})

describe('textoParaRelatorioDeConclusao — resposta direta ao dev, sem gastar QA/RA/dono', () => {
  it('instrui a finalizar a entrega, em PT-BR', () => {
    const texto = textoParaRelatorioDeConclusao()
    expect(texto).toContain('pull request')
    expect(texto).not.toMatch(/successfully|please|thank you/i)
  })
})

describe('textoParaPedidoDeAprovacaoDePlano — nunca vira pergunta ao dono', () => {
  it('instrui o dev a seguir, em PT-BR', () => {
    const texto = textoParaPedidoDeAprovacaoDePlano()
    expect(texto.length).toBeGreaterThan(0)
    expect(texto).not.toMatch(/successfully|please|thank you/i)
  })
})
