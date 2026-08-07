import { describe, it, expect } from 'vitest'
import { decidirMerge, ultimoVeredito, ehRotinaDeDependencia } from './merge-gate.js'

// Visto em produção, num PR escrito pelo dev assíncrono:
//
//   review de gitorch-ai · CHANGES_REQUESTED · 13:34:57
//   merge   por app/github-actions              · 13:36:20
//
// O QA leu o PR, reprovou e publicou o motivo. Oitenta e três segundos depois a
// automação aprovou o mesmo PR em nome do sistema e mandou para a linha
// principal, porque só olhava os testes. Um produto que vende julgamento não
// pode mesclar o que o próprio julgamento recusou.

// O login CRU do App, com o sufixo. Ele importa: o GitHub não aceita colchetes
// em nome de usuário, então `gitorch-ai[bot]` é impossível de registrar por uma
// pessoa — enquanto `gitorch-ai`, sem o sufixo, está livre para quem quiser.
const QA = 'gitorch-ai[bot]'
const SHA = 'abc123'

describe('ultimoVeredito', () => {
  it('vale a última revisão do QA, não a primeira', () => {
    const v = ultimoVeredito(
      [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T10:00:00Z' },
        { autor: QA, estado: 'APPROVED', commitId: SHA, em: '2026-01-01T11:00:00Z' },
      ],
      QA
    )
    expect(v?.estado).toBe('APPROVED')
  })

  it('ignora revisão de quem não é o QA', () => {
    const v = ultimoVeredito(
      [
        {
          autor: 'app/github-actions',
          estado: 'APPROVED',
          commitId: SHA,
          em: '2026-01-01T10:00:00Z',
        },
      ],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('comentário sem veredito não vira veredito', () => {
    const v = ultimoVeredito(
      [{ autor: QA, estado: 'COMMENTED', commitId: SHA, em: '2026-01-01T10:00:00Z' }],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('revisão descartada deixa de contar', () => {
    const v = ultimoVeredito(
      [{ autor: QA, estado: 'DISMISSED', commitId: SHA, em: '2026-01-01T10:00:00Z' }],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('sem revisão nenhuma não há veredito', () => {
    expect(ultimoVeredito([], QA)).toBeUndefined()
  })
})

describe('decidirMerge', () => {
  it('o caso real: reprovado pelo QA não entra na linha principal', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T13:34:57Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('reprov')
  })

  it('aprovado pelo QA sobre a versão atual: pode mesclar', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [{ autor: QA, estado: 'APPROVED', commitId: SHA, em: '2026-01-01T13:40:00Z' }],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(true)
  })

  // Sem isto, bastaria enviar qualquer commit depois da reprovação para o
  // veredito virar "de outra versão" e o merge passar sem ninguém reler nada.
  it('correção enviada depois do veredito exige novo julgamento', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'APPROVED', commitId: 'versao-velha', em: '2026-01-01T13:40:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('outra versão')
  })

  it('reprovação de versão anterior também segura o merge', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        {
          autor: QA,
          estado: 'CHANGES_REQUESTED',
          commitId: 'versao-velha',
          em: '2026-01-01T13:34:57Z',
        },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('PR do dev sem nenhum veredito espera o QA em vez de entrar', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('aguardando')
  })

  // Bump de dependência não passa pelo QA do produto: exigir aprovação dele
  // travaria a automação de segurança inteira, que é justamente o que não pode
  // ficar parado.
  it('rotina de dependência sem veredito continua entrando', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(true)
  })

  it('rotina de dependência com aprovação de versão anterior segue entrando', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'APPROVED', commitId: 'versao-velha', em: '2026-01-01T13:40:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(true)
  })

  it('mas rotina de dependência reprovada pelo QA para', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T13:34:57Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(false)
  })

  // A automação dava `--approve` em nome do sistema antes de mesclar. Se essa
  // aprovação contasse, o portão se abriria sozinho.
  it('a aprovação da própria automação não conta como julgamento', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        {
          autor: 'app/github-actions',
          estado: 'APPROVED',
          commitId: SHA,
          em: '2026-01-01T13:36:00Z',
        },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  // O teste acima passa porque, na configuração de hoje, o QA é outra
  // identidade. Isso é sorte, não garantia: quem configura o revisor pode
  // apontá-lo, por engano, para a identidade que a própria automação usa — e aí
  // o portão volta a se auto-aprovar, calado. A recusa tem que estar no código.
  it('nem que configurem o revisor como a própria automação: o sistema não julga a si mesmo', () => {
    for (const identidadeDoSistema of [
      'github-actions',
      'github-actions[bot]',
      'app/github-actions',
    ]) {
      const d = decidirMerge({
        revisorDeQualidade: identidadeDoSistema,
        revisoes: [
          {
            autor: identidadeDoSistema,
            estado: 'APPROVED',
            commitId: SHA,
            em: '2026-01-01T13:36:20Z',
          },
        ],
        commitAtual: SHA,
        exigeAprovacao: true,
      })
      expect(d.pode, `${identidadeDoSistema} não pode valer como veredito`).toBe(false)
    }
  })

  // O QA é um App e revisa como `gitorch-ai[bot]`. Enquanto isso, o login
  // `gitorch-ai` — sem o sufixo — está livre no GitHub para qualquer pessoa
  // registrar. Num repositório público qualquer um pode aprovar um pull
  // request. Se o portão tratar os dois como a mesma identidade, o veredito do
  // QA passa a ser assinável por um estranho ao custo de criar uma conta.
  it('um homônimo sem o sufixo de robô não assina pelo QA', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: 'gitorch-ai', estado: 'APPROVED', commitId: SHA, em: '2026-01-01T14:00:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('e nem consegue derrubar uma reprovação verdadeira do QA', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T13:34:57Z' },
        { autor: 'gitorch-ai', estado: 'APPROVED', commitId: SHA, em: '2026-01-01T14:00:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  // Reforço de identidade: mesmo com o login idêntico, uma conta de pessoa não
  // pode assinar por um revisor declarado como robô.
  it('conta de pessoa não vale como veredito de um revisor que é robô', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        {
          autor: QA,
          tipoDeConta: 'User',
          estado: 'APPROVED',
          commitId: SHA,
          em: '2026-01-01T14:00:00Z',
        },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  // Descartar uma revisão é o gesto de dizer "esse julgamento não vale mais".
  // Se o portão simplesmente ignora o descarte, um julgamento ANTERIOR volta a
  // valer sozinho — e "aprovado" ressuscita depois de ter sido revogado.
  it('descartar a aprovação não faz o pull request voltar a estar aprovado', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'APPROVED', commitId: SHA, em: '2026-01-01T10:00:00Z' },
        { autor: QA, estado: 'DISMISSED', commitId: SHA, em: '2026-01-01T11:00:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('descartar a reprovação também não vale como aprovação', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T10:00:00Z' },
        { autor: QA, estado: 'DISMISSED', commitId: SHA, em: '2026-01-01T11:00:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  // Revisão antiga do GitHub pode não trazer o commit julgado; tratar ausência
  // como "serve para qualquer versão" reabriria a porta que este portão fecha.
  it('veredito sem versão registrada não é aceito como atual', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [{ autor: QA, estado: 'APPROVED', commitId: null, em: '2026-01-01T13:40:00Z' }],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('o motivo sempre explica o que fazer para destravar', () => {
    // (mantido abaixo)
    for (const caso of [
      { revisoes: [], exigeAprovacao: true },
      {
        revisoes: [
          {
            autor: QA,
            estado: 'CHANGES_REQUESTED' as const,
            commitId: SHA,
            em: '2026-01-01T13:34:57Z',
          },
        ],
        exigeAprovacao: true,
      },
    ]) {
      const d = decidirMerge({ revisorDeQualidade: QA, commitAtual: SHA, ...caso })
      expect(d.motivo.length).toBeGreaterThan(20)
    }
  })
})

// Quem dispensa o julgamento do QA é a natureza do CÓDIGO, não a identidade de
// quem abriu o pull request. Bump de dependência é código gerado por rotina e
// não tem o que julgar; mas o autor do pull request continua sendo o robô de
// dependências mesmo depois que outra pessoa empurra um commit no mesmo ramo —
// e aí o que entra na linha principal já não é rotina nenhuma.
describe('ehRotinaDeDependencia', () => {
  const ROBO = 'dependabot[bot]'
  const ABERTO_PELO_ROBO = { login: ROBO, tipoDeConta: 'Bot' }

  it('pull request do robô cujos commits são todos dele', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: ROBO, enviadoPor: 'web-flow' }],
      })
    ).toBe(true)
  })

  it('um único commit de outra pessoa já exige o julgamento do QA', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: ROBO, enviadoPor: 'web-flow' }, { autor: 'alguem' }],
      })
    ).toBe(false)
  })

  it('commit assinado pelo robô mas enviado por outra pessoa também exige', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: ROBO, enviadoPor: 'alguem' }],
      })
    ).toBe(false)
  })

  // Conferido contra um bump real: o robô cria os commits pela API do GitHub, e
  // a plataforma registra `web-flow` como enviador. Exigir o próprio robô ali
  // travaria toda atualização de dependência do repositório — e o teste existe
  // para que ninguém "endureça" essa regra de novo sem olhar um pull request de
  // verdade.
  it('o enviador que a plataforma usa nos commits criados por ela conta como rotina', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: ROBO, enviadoPor: 'web-flow' }],
      })
    ).toBe(true)
  })

  it('sem commits conhecidos, não presume rotina', () => {
    expect(ehRotinaDeDependencia({ autorDoPr: ABERTO_PELO_ROBO, commits: [] })).toBe(false)
  })

  // O NOME que vem dentro do commit é escolhido por quem comita — `git -c
  // user.name=...` aceita qualquer coisa. Quando o e-mail do commit não está
  // ligado a nenhuma conta, a plataforma devolve autoria vazia, e é esse o caso
  // NORMAL dos commits que saem das máquinas deste projeto. Confiar no nome
  // seria deixar a dispensa do QA a um campo que o atacante preenche.
  it('autoria não reconhecida pela plataforma nunca dispensa o QA', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: null, enviadoPor: 'web-flow' }],
      })
    ).toBe(false)
  })

  it('enviador não reconhecido também não dispensa', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: ABERTO_PELO_ROBO,
        commits: [{ autor: ROBO, enviadoPor: null }],
      })
    ).toBe(false)
  })

  // A outra metade da trava: mesmo com todos os commits em ordem, quem ABRIU o
  // pull request precisa ser a conta do robô. Um pull request aberto por outra
  // pessoa contendo commits que dizem ser do robô não é rotina nenhuma.
  it('pull request aberto por outra conta não é rotina, mesmo com commits do robô', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: { login: 'alguem', tipoDeConta: 'User' },
        commits: [{ autor: ROBO, enviadoPor: 'web-flow' }],
      })
    ).toBe(false)
  })

  it('conta de pessoa com o nome do robô não passa como robô', () => {
    expect(
      ehRotinaDeDependencia({
        autorDoPr: { login: ROBO, tipoDeConta: 'User' },
        commits: [{ autor: ROBO, enviadoPor: 'web-flow' }],
      })
    ).toBe(false)
  })
})
