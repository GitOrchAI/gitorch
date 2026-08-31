import { describe, it, expect } from 'vitest'
import type { Octokit as OctokitParaTeste } from '@octokit/rest'
import { decidirAcaoNoPR, hasActiveJulesSession, isSecurityAutomationPR } from './pr-eligibility.js'
import {
  CORPO_PR_347_DONO,
  CORPO_PR_360_DEPENDABOT,
  CORPO_PR_361_DONO,
  CORPO_PR_388_DEV,
  CORPO_PR_393_DEV,
} from './__fixtures__/corpos-reais-de-pr.js'

describe('hasActiveJulesSession', () => {
  it('true para PR aberto pelo Jules (tem o marcador no corpo)', () => {
    expect(
      hasActiveJulesSession({
        body: 'Corrige X.\n\n---\n*PR created automatically by Jules for task 123 started by @loureng*',
      })
    ).toBe(true)
  })
  it('false para PR puro do Dependabot (caso real do #213 - bump de @types/node)', () => {
    expect(
      hasActiveJulesSession({
        body: 'Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) from 20.10.0 to 26.1.0.',
      })
    ).toBe(false)
  })
  it('false quando o corpo apenas CITA o rodapé em bloco de código (PR do dono sobre a automação)', () => {
    expect(
      hasActiveJulesSession({
        body:
          'Documenta o rodapé:\n\n```\n' +
          '*PR created automatically by Jules for task 123 started by @loureng*\n```\n',
      })
    ).toBe(false)
  })
  it('false para corpo vazio/nulo', () => {
    expect(hasActiveJulesSession({ body: null })).toBe(false)
    expect(hasActiveJulesSession({})).toBe(false)
  })
})

// --- Elegibilidade por EVIDÊNCIA POSITIVA (L3-T10) ---------------------------------
// O gate antigo casava CITAÇÃO DE TEXTO no corpo do PR: qualquer PR que contivesse a frase
// "PR created automatically by Jules" em qualquer posição — inclusive dentro de aspas, de um
// bloco de código ou de uma citação — era tratado como PR da automação. Um PR do dono que
// apenas FALA da automação (como este) entrava no escopo e podia levar comentário `@jules`
// automático. Estes testes fixam o comportamento certo: só é elegível quem prova ter nascido
// da automação.

type CorpoDePR = {
  user?: { login?: string } | null
  labels?: Array<string | { name?: string }>
  body?: string | null
}

function octokitFalso(pr: CorpoDePR, issues: Record<number, string[]> = {}) {
  return {
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      issues: {
        get: async ({ issue_number }: { issue_number: number }) => {
          const labels = issues[issue_number]
          if (!labels) throw new Error('404')
          return { data: { labels } }
        },
      },
    },
  } as unknown as OctokitParaTeste
}

// Última linha do corpo REAL do PR #388 — o rodapé como o dev de fato o escreve, não uma
// transcrição de memória. Se o formato mudar, a fixture muda junto e estes testes reagem.
const TRAILER_REAL = CORPO_PR_388_DEV.trim().split('\n').pop() as string

describe('isSecurityAutomationPR — PR do dono NÃO é elegível', () => {
  it('cita o marcador em prosa (PR que fala da automação) → não elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: 'Troca a checagem de "PR created automatically by Jules" por evidência positiva.',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 1)).toBe(false)
  })

  it('documenta o marcador dentro de bloco de código → não elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: `Documenta o rodapé que o dev escreve:\n\n\`\`\`\n${TRAILER_REAL}\n\`\`\`\n`,
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 2)).toBe(false)
  })

  it('reproduz o marcador em citação (>) ao responder review → não elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: `Sobre o comentário:\n\n> ${TRAILER_REAL}\n\nnão se aplica aqui.`,
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 3)).toBe(false)
  })

  it('fecha issue rotulada jules, mas o PR é do dono → não elegível', async () => {
    const octokit = octokitFalso(
      { user: { login: 'loureng' }, labels: [], body: 'Fixes #329 na mão, sem o dev.' },
      { 329: ['jules'] }
    )
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 4)).toBe(false)
  })
})

describe('isSecurityAutomationPR — PR da automação CONTINUA elegível', () => {
  it('rodapé real do dev (caso vivo do PR #356) → elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: `Fecha a issue #329.\n\n---\n${TRAILER_REAL}`,
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 5)).toBe(true)
  })

  it('rodapé antigo, sem link da tarefa → elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: 'Corrige X.\n\n---\n*PR created automatically by Jules for task 123 started by @loureng*',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 6)).toBe(true)
  })

  it('autor dependabot[bot] → elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'dependabot[bot]' },
      labels: [],
      body: 'Bumps lucide-react from 1.33.0 to 1.34.0.',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 7)).toBe(true)
  })

  it('label da automação no próprio PR (caso vivo do PR #360) → elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [{ name: 'dependabot' }, { name: 'dependencies' }],
      body: 'bump do grupo de desenvolvimento',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 8)).toBe(true)
  })
})

describe('isSecurityAutomationPR — texto solto não dispara nada', () => {
  it('"through the chat" não torna o PR elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: 'the owner adds an item through the chat',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 9)).toBe(false)
  })

  it('mencionar @jules no corpo não torna o PR elegível', async () => {
    const octokit = octokitFalso({
      user: { login: 'loureng' },
      labels: [],
      body: '@jules resolve esse conflito quando puder',
    })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 10)).toBe(false)
  })

  it('corpo vazio não torna o PR elegível', async () => {
    const octokit = octokitFalso({ user: { login: 'loureng' }, labels: [], body: null })
    expect(await isSecurityAutomationPR(octokit, 'GitOrchAI', 'gitorch', 11)).toBe(false)
  })
})

// --- O PONTO DE DECISÃO que analyze-conflicts.ts consulta ---------------------------------
// Achado do QA: o aperto do gate não tinha chegado onde o comentário é escrito. O script
// gateava com `isSecurityAutomationPR` e ia direto postar; `hasActiveJulesSession` não aparecia
// no arquivo. `decidirAcaoNoPR` é agora esse ponto único, e mora aqui na lib justamente para
// poder ser importado por um teste — importar `analyze-conflicts.ts` executaria seu `main()`.
//
// Os corpos abaixo são REAIS (capturados com `gh pr view`), porque a regra decide sobre texto
// que humanos e bots escrevem, e corpo inventado tende a confirmar a regra de quem o inventou.

describe('decidirAcaoNoPR — PR do DONO não passa por caminho nenhum', () => {
  const casosDoDono: Array<[string, string]> = [
    ['#347 (corpo real, fala da automação em prosa)', CORPO_PR_347_DONO],
    ['#361 (corpo real, cita Dependabot e três issues por número)', CORPO_PR_361_DONO],
  ]

  for (const [nome, body] of casosDoDono) {
    it(`${nome} → nem no escopo, nem pode comentar`, () => {
      expect(decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body })).toEqual({
        noEscopo: false,
        podeComentar: false,
      })
    })
  }

  it('corpo real do dono + rodapé CITADO em bloco de código → continua fora', () => {
    // O PR que documenta esta automação (como o desta própria mudança) reproduz o rodapé. Era
    // exatamente isso que o `body.includes(...)` antigo lia como "PR da automação".
    const body = `${CORPO_PR_347_DONO}\n\nO rodapé que o dev escreve é:\n\n\`\`\`\n${TRAILER_REAL}\n\`\`\`\n`
    expect(decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body })).toEqual({
      noEscopo: false,
      podeComentar: false,
    })
  })

  it('corpo real do dono + "Fixes #329" de issue rotulada `jules` → continua fora', () => {
    // Caso CONSTRUÍDO, não observado: nenhum PR do dono nos últimos 80 usa palavra-chave de
    // fechamento. Fica no teste porque era um caminho de elegibilidade de verdade — o gate
    // antigo lia a label da ISSUE, que é evidência sobre a issue, não sobre quem abriu o PR.
    const body = `${CORPO_PR_361_DONO}\n\nFixes #329.`
    expect(decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body })).toEqual({
      noEscopo: false,
      podeComentar: false,
    })
  })

  it('menção literal a @jules no corpo do dono → continua fora', () => {
    const body = `${CORPO_PR_347_DONO}\n\n@jules resolve esse conflito quando puder.`
    expect(decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body })).toEqual({
      noEscopo: false,
      podeComentar: false,
    })
  })
})

describe('decidirAcaoNoPR — escopo e escrita são decisões diferentes', () => {
  it('PR do dev (#388, corpo real) → no escopo E pode comentar', () => {
    expect(
      decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body: CORPO_PR_388_DEV })
    ).toEqual({ noEscopo: true, podeComentar: true })
  })

  it('PR do dev (#393, corpo real) → no escopo E pode comentar', () => {
    expect(
      decidirAcaoNoPR({ user: { login: 'loureng' }, labels: [], body: CORPO_PR_393_DEV })
    ).toEqual({ noEscopo: true, podeComentar: true })
  })

  it('Dependabot puro (#360, autor e labels reais) → no escopo, mas NÃO pode comentar', () => {
    // O furo que o QA descreveu em uma frase: este PR passava no gate de escopo e recebia um
    // comentário começando com `@jules` sem que existisse sessão nenhuma para reagir a ele.
    expect(
      decidirAcaoNoPR({
        user: { login: 'dependabot[bot]' },
        labels: [{ name: 'dependabot' }, { name: 'dependencies' }],
        body: CORPO_PR_360_DEPENDABOT,
      })
    ).toEqual({ noEscopo: true, podeComentar: false })
  })
})

describe('decidirAcaoNoPR — invariante: poder comentar implica estar no escopo', () => {
  // Tranca a relação de subconjunto declarada no comentário de `decidirAcaoNoPR`. Se alguém
  // afrouxar `hasActiveJulesSession` sem mexer em `ehPRDaAutomacao`, aparece um PR autorizado a
  // ESCREVER sem estar sequer no escopo da automação — e isso falha aqui.
  const corpus = [
    CORPO_PR_347_DONO,
    CORPO_PR_361_DONO,
    CORPO_PR_388_DEV,
    CORPO_PR_393_DEV,
    CORPO_PR_360_DEPENDABOT,
    `citado:\n\`\`\`\n${TRAILER_REAL}\n\`\`\``,
    `> ${TRAILER_REAL}`,
    `texto antes ${TRAILER_REAL} texto depois`,
    '',
  ]
  const autores = ['loureng', 'dependabot[bot]', 'alguem-de-fora']
  const labelsPossiveis: Array<Array<{ name: string }>> = [[], [{ name: 'jules' }], [{ name: 'x' }]]

  it('nenhuma combinação de autor/label/corpo escapa', () => {
    for (const body of corpus) {
      for (const login of autores) {
        for (const labels of labelsPossiveis) {
          const { noEscopo, podeComentar } = decidirAcaoNoPR({ user: { login }, labels, body })
          if (podeComentar) expect(noEscopo).toBe(true)
        }
      }
    }
  })
})
