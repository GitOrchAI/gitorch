import { describe, expect, test, vi } from 'vitest'
import {
  modeloVivoParaAMissao,
  degrausQueValemATentativa,
  varrerCatalogoDeModelosDoRelogio,
} from './scheduler.js'
import { resolveRuntimeChain, type ResolverDefaults } from '../lib/runtime-resolver.js'

/**
 * O PONTO DE LIGAÇÃO entre o catálogo COLETADO e a escolha do modelo da missão.
 *
 * As peças puras estão testadas caso a caso (catalogo-vivo-de-modelos.test.ts,
 * modelos-a-recoletar.test.ts, scheduler-modelo-vivo.test.ts). Aqui prova-se o
 * que só a LIGAÇÃO pode errar: a cadeia que o resolvedor REAL produz, passada
 * pela conferência REAL contra os catálogos REAIS do banco, resulta nos degraus
 * certos. Nada aqui imita o laço do failover — são as mesmas funções que
 * `executeMissionWithFailover` chama, na mesma ordem.
 */

// Os padrões REAIS do scheduler (RESOLVER_DEFAULTS): motor padrão codex nos
// quatro papéis. O `modelByRole` que ficava aqui ao lado — um modelo do
// ANTIGRAVITY servindo de padrão para QUALQUER motor — foi removido em
// 01/09/2026: era ele que envenenava os degraus dos outros motores, e ninguém
// tinha medido. O padrão de modelo agora é por papel E por motor, do catálogo
// vivo (services/padrao-do-degrau.ts).
const PADROES_REAIS: ResolverDefaults = {
  runtimeByRole: { po: 'codex', ra: 'codex', sm: 'codex', qa: 'codex' },
}

// OS CATÁLOGOS REAIS, copiados do banco de produção em 01/09/2026 03:00:
//   select runtime, models from engine_connections where runtime <> 'github'
const CATALOGO_DO_BANCO: Record<string, string[]> = {
  antigravity: [
    'Gemini 3.7 Flash (High)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (Low)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ],
  claude: [
    'Claude Opus 5',
    'Claude Sonnet 5',
    'Claude Fable 5',
    'Claude Opus 4.8',
    'Claude Opus 4.7',
    'Claude Sonnet 4.6',
    'Claude Opus 4.6',
    'Claude Opus 4.5',
    'Claude Haiku 4.5',
    'Claude Sonnet 4.5',
  ],
  codex: ['GPT-5.5', 'GPT-5.4-Mini', 'Codex Auto Review'],
}

const prismaComOsCatalogosReais = (catalogos = CATALOGO_DO_BANCO) => ({
  engineConnection: {
    findFirst: vi.fn(async (args: unknown) => {
      const runtime = (args as { where: { runtime: string } }).where.runtime
      const models = catalogos[runtime]
      return models ? { models } : null
    }),
  },
})

const semLog = { warn: (): void => undefined }

/** Exatamente a sequência de `executeMissionWithFailover`, com as funções reais. */
async function degrausDaMissao(args: {
  role: 'po' | 'ra' | 'sm' | 'qa'
  motoresConectados: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any
  log?: { warn: (msg: string) => void }
}) {
  const cadeia = resolveRuntimeChain(args.role, null, PADROES_REAIS, args.motoresConectados)
  const conferidos = await Promise.all(
    cadeia.map(async (sel) => ({
      runtime: sel.runtime,
      ...(await modeloVivoParaAMissao({
        prisma: args.prisma,
        ownerUserId: 'user_1',
        runtime: sel.runtime,
        role: args.role,
        ...(sel.model !== undefined ? { desejado: sel.model } : {}),
        ...(sel.effort !== undefined ? { esforco: sel.effort } : {}),
        log: args.log ?? semLog,
      })),
    }))
  )
  return degrausQueValemATentativa(conferidos)
}

describe('o catálogo coletado LIGADO à escolha do modelo (caminho real da missão)', () => {
  test('o resolvedor não carimba mais o modelo de um motor nos outros', () => {
    // ATÉ 01/09/2026 esta chamada devolvia `Gemini 3.7 Flash (Medium)` nos
    // TRÊS degraus, porque `modelByRole` era uma constante só. E, rodado ao
    // vivo nesta VM com a credencial do dono:
    //   $ claude --model "Gemini 3.7 Flash (Medium)" -p "say ok"
    //     There's an issue with the selected model (Gemini 3.7 Flash (Medium)).
    // Ou seja: o degrau do claude do rodízio era um container queimado.
    // Agora o modelo só aparece aqui quando o CLIENTE escolheu; o padrão de
    // quem não escolheu é resolvido por motor, contra o catálogo vivo dele.
    const cadeia = resolveRuntimeChain('ra', null, PADROES_REAIS, [
      'antigravity',
      'claude',
      'codex',
    ])
    expect(cadeia).toEqual([
      { runtime: 'codex' },
      { runtime: 'antigravity' },
      { runtime: 'claude' },
    ])
  })

  test('quem não escolheu recebe o padrão do PAPEL naquele MOTOR, do catálogo vivo', async () => {
    const r = await degrausDaMissao({
      role: 'ra',
      motoresConectados: ['antigravity', 'claude', 'codex'],
      prisma: prismaComOsCatalogosReais(),
    })
    expect(r.pulados).toEqual([])
    // O RA é papel de exigência MÉDIA (ver services/padrao-do-degrau.ts).
    // Cada motor entrega o médio DELE, tirado do catálogo dele — e o modelo
    // sai no formato que aquele CLI aceita — `claude-sonnet-5` e `gpt-5.5`, e
    // não os nomes de vitrine "Claude Sonnet 5" e "GPT-5.5", que os dois CLIs
    // recusam (medido ao vivo em 01/09/2026).
    expect(r.degraus).toEqual([
      { runtime: 'codex', modelo: 'gpt-5.5', esforco: 'medium', valeATentativa: true },
      {
        runtime: 'antigravity',
        modelo: 'Gemini 3.7 Flash (Medium)',
        esforco: undefined,
        valeATentativa: true,
      },
      { runtime: 'claude', modelo: 'claude-sonnet-5', esforco: 'medium', valeATentativa: true },
    ])
  })

  test('o SM (papel barato) e o QA (papel que julga) não recebem mais o mesmo modelo', async () => {
    // Era o desperdício dos dois lados: o SM, que só movimenta card, rodava no
    // mesmo modelo do QA, que JULGA o PR. Um pagava caro à toa, o outro
    // julgava fraco.
    const sm = await degrausDaMissao({
      role: 'sm',
      motoresConectados: ['claude'],
      prisma: prismaComOsCatalogosReais(),
    })
    const qa = await degrausDaMissao({
      role: 'qa',
      motoresConectados: ['claude'],
      prisma: prismaComOsCatalogosReais(),
    })
    const doClaude = (r: { degraus: Array<{ runtime: string }> }) =>
      r.degraus.find((d) => d.runtime === 'claude')
    expect(doClaude(sm)).toEqual({
      runtime: 'claude',
      modelo: 'claude-haiku-4-5',
      esforco: 'low',
      valeATentativa: true,
    })
    expect(doClaude(qa)).toEqual({
      runtime: 'claude',
      modelo: 'claude-opus-5',
      esforco: 'high',
      valeATentativa: true,
    })
  })

  test('o esforço pedido é validado contra o motor, nunca repassado às cegas', async () => {
    // 'max' existe no claude e NÃO existe no codex (medido: o catálogo do
    // servidor do Codex lista low/medium/high/xhigh). O CLI do claude, aliás,
    // ACEITA valor inválido com um simples aviso e roda no padrão — então quem
    // precisa recusar somos nós.
    const noCodex = await modeloVivoParaAMissao({
      prisma: prismaComOsCatalogosReais(),
      ownerUserId: 'user_1',
      runtime: 'codex',
      role: 'qa',
      desejado: 'GPT-5.5',
      esforco: 'max',
      log: semLog,
    })
    expect(noCodex.esforco).toBeUndefined()

    const noClaude = await modeloVivoParaAMissao({
      prisma: prismaComOsCatalogosReais(),
      ownerUserId: 'user_1',
      runtime: 'claude',
      role: 'qa',
      desejado: 'Claude Opus 5',
      esforco: 'max',
      log: semLog,
    })
    expect(noClaude).toEqual({ modelo: 'claude-opus-5', esforco: 'max', valeATentativa: true })
  })

  test('no antigravity o esforço troca o MODELO, e nunca vira esforço separado', async () => {
    const r = await modeloVivoParaAMissao({
      prisma: prismaComOsCatalogosReais(),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      role: 'sm',
      desejado: 'Gemini 3.7 Flash (Medium)',
      esforco: 'high',
      log: semLog,
    })
    // `agy --model X --effort high` é erro duro do CLI (medido ao vivo), então
    // o esforço tem que sair do degrau depois de virar nome de modelo.
    expect(r).toEqual({
      modelo: 'Gemini 3.7 Flash (High)',
      esforco: undefined,
      valeATentativa: true,
    })
  })

  test('O DEFEITO DE 31/08: o modelo removido pelo provedor não queima mais a rodada', async () => {
    // O catálogo do antigravity coletado DEPOIS da remoção (a saída real de
    // `agy models` nesta VM em 01/09: 11 modelos, nenhum 3.5) e um projeto que
    // escolheu explicitamente um esforço que não existe mais nessa família.
    // Antes: a missão pagava um `podman run` para receber `invalid model
    // selection` — 24 vezes em 9h48. Agora o degrau é PULADO e o seguinte
    // assume.
    const semA35 = {
      ...CATALOGO_DO_BANCO,
      antigravity: CATALOGO_DO_BANCO['antigravity']?.filter((m) => !m.includes('3.5')) ?? [],
    }
    const avisos: string[] = []
    const cadeia = [
      { runtime: 'antigravity', model: 'Gemini 3.5 Flash (Turbo)' },
      { runtime: 'claude' },
    ]
    const conferidos = await Promise.all(
      cadeia.map(async (sel) => ({
        runtime: sel.runtime,
        ...(await modeloVivoParaAMissao({
          prisma: prismaComOsCatalogosReais(semA35),
          ownerUserId: 'user_1',
          runtime: sel.runtime,
          role: 'ra' as const,
          ...(sel.model !== undefined ? { desejado: sel.model } : {}),
          log: { warn: (m: string) => avisos.push(m) },
        })),
      }))
    )
    const r = degrausQueValemATentativa(conferidos)

    expect(r.pulados.map((d) => d.runtime)).toEqual(['antigravity'])
    expect(r.degraus.map((d) => d.runtime)).toEqual(['claude'])
    // E DIZ POR QUÊ, com o nome do modelo e do motor: o defeito original durou
    // 9h48 porque ninguém foi avisado de nada.
    const sobreOAntigravity = avisos.find((a) => a.includes('antigravity'))
    expect(sobreOAntigravity).toContain('Gemini 3.5 Flash (Turbo)')
  })

  test('FAIL-OPEN de ponta a ponta: banco fora do ar não pula degrau nenhum', async () => {
    const r = await degrausDaMissao({
      role: 'ra',
      motoresConectados: ['antigravity', 'claude'],
      prisma: {
        engineConnection: { findFirst: vi.fn().mockRejectedValue(new Error('sem banco')) },
      },
    })
    expect(r.pulados).toEqual([])
    // Três degraus: o codex padrão do papel mais os dois motores conectados.
    // NENHUM é pulado — sem catálogo, a resposta honesta é "não sei", nunca
    // "o modelo não existe".
    expect(r.degraus.map((d) => d.runtime)).toEqual(['codex', 'antigravity', 'claude'])
    // E todos rodam SEM `--model`, com o modelo padrão do próprio motor.
    //
    // Até 01/09/2026 este caso devolvia `Gemini 3.7 Flash (Medium)` nos três,
    // porque o padrão da instância era esse literal. Com o banco fora do ar
    // não há como saber o modelo de cada motor, e chutar o nome de UM deles
    // para os TRÊS é o que fazia `claude --model "Gemini 3.7 Flash (Medium)"`
    // responder "There's an issue with the selected model". Não saber e não
    // passar nada é honesto; não saber e chutar é o defeito.
    expect(r.degraus.every((d) => d.modelo === undefined)).toBe(true)
  })

  test('projeto que ESCOLHEU o modelo mantém a escolha mesmo com o banco fora do ar', async () => {
    // O fail-open não pode virar desculpa para descartar a cascata do cliente:
    // sem catálogo não há como conferir, e a escolha dele continua valendo.
    const semBanco = {
      engineConnection: { findFirst: vi.fn().mockRejectedValue(new Error('sem banco')) },
    }
    const escolhido = await modeloVivoParaAMissao({
      prisma: semBanco,
      ownerUserId: 'user_1',
      runtime: 'claude',
      role: 'qa',
      desejado: 'Claude Opus 5',
      esforco: 'high',
      log: semLog,
    })
    expect(escolhido).toEqual({ modelo: 'claude-opus-5', esforco: 'high', valeATentativa: true })
  })
})

describe('varrerCatalogoDeModelosDoRelogio — a coleta pelo relógio, ligada de verdade', () => {
  const fakeApp = (
    conexoes: Array<Record<string, unknown>>,
    refreshModels = vi.fn(async () => ['GPT-5.5'])
  ) =>
    ({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      prisma: { engineConnection: { findMany: vi.fn(async () => conexoes) } },
      engineConnections: { refreshModels },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

  test('coleta a conexão vencida e NÃO toca na que está em dia nem na que está caída', async () => {
    const refreshModels = vi.fn(async () => ['GPT-5.5'])
    const app = fakeApp(
      [
        { userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null },
        {
          userId: 'u1',
          runtime: 'claude',
          status: 'connected',
          modelsCheckedAt: new Date(Date.now() - 60_000),
        },
        { userId: 'u1', runtime: 'codex', status: 'needs_reconnect', modelsCheckedAt: null },
      ],
      refreshModels
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(refreshModels.mock.calls).toEqual([['u1', 'antigravity']])
  })

  test('uma conexão que explode não impede a seguinte de ser coletada', async () => {
    const refreshModels = vi.fn(async (_userId: string, runtime: string) => {
      if (runtime === 'antigravity') throw new Error('binário fora do ar')
      return ['Claude Opus 5']
    })
    const app = fakeApp(
      [
        { userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null },
        { userId: 'u1', runtime: 'claude', status: 'connected', modelsCheckedAt: null },
      ],
      refreshModels as never
    )
    await expect(varrerCatalogoDeModelosDoRelogio(app)).resolves.toBeUndefined()
    expect(refreshModels.mock.calls.map((c) => c[1])).toEqual(['antigravity', 'claude'])
  })

  test('catálogo vazio não é silêncio: o dono fica sabendo que a lista está velha', async () => {
    const app = fakeApp(
      [{ userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null }],
      vi.fn(async () => [])
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(app.log.warn.mock.calls[0]?.[0]).toContain('preservada')
  })

  test('sem conexão vencida, nem chega a chamar a coleta', async () => {
    const refreshModels = vi.fn(async () => ['GPT-5.5'])
    const app = fakeApp(
      [
        {
          userId: 'u1',
          runtime: 'antigravity',
          status: 'connected',
          modelsCheckedAt: new Date(),
        },
      ],
      refreshModels
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(refreshModels).not.toHaveBeenCalled()
  })
})
