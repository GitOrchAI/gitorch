import { describe, expect, test } from 'vitest'
import { resolveRuntimeChain, type ResolverDefaults } from './runtime-resolver.js'
import {
  argumentosDeEsforco,
  modeloComEsforcoNoNome,
  valorDeModeloParaOMotor,
} from '../services/esforco-por-motor.js'
import { padraoDoDegrau } from '../services/padrao-do-degrau.js'
import type { F6AgentRole } from '@gitorch/agents'

/**
 * A CASCATA DO DONO, montada com os modelos REAIS de hoje e resolvida até a
 * linha de comando. Este é o teste que o pedido cobra: cada papel resolve para
 * o motor, o modelo e o esforço certos, degrau por degrau.
 *
 * O pedido dele, em 01/09, escrito do jeito humano:
 *   PO: Antigravity Claude Opus -> Codex 5.5        -> Claude Opus 5
 *   RA: Codex 5.5               -> Claude Sonnet    -> Antigravity Flash 3.6 High
 *   SM: Claude Haiku            -> Codex 5 mini     -> Antigravity Flash 3.7 small
 *   QA: Antigravity 3.1 pro high-> Claude Haiku     -> Codex 5.5
 *
 * O que ele escreve NÃO é o id do motor, e a diferença importa:
 *   "Codex 5 mini"              → o catálogo real do codex diz `GPT-5.4-Mini`
 *   "Antigravity Claude Opus"   → `Claude Opus 4.6 (Thinking)`
 *   "Antigravity 3.1 pro high"  → `Gemini 3.1 Pro (High)`
 *   "Flash 3.7 small"           → não existe "small"; a escada real é
 *                                 High/Medium/Low → `Gemini 3.7 Flash (Low)`
 *   "Claude Opus 5"             → o catálogo guarda esse nome de vitrine, mas o
 *                                 CLI só aceita `claude-opus-5` (medido ao vivo)
 *   "GPT-5.5"                   → mesma coisa no codex: o CLI recusa o nome de
 *                                 vitrine e aceita `gpt-5.5` (medido ao vivo)
 */

const CATALOGO = {
  antigravity: [
    'Gemini 3.7 Flash (High)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (Low)',
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
} as const

/** A cascata do dono, já traduzida para os nomes que os catálogos têm. */
const CASCATA_DO_DONO = {
  agents: {
    po: {
      runtime: 'antigravity',
      model: 'Claude Opus 4.6 (Thinking)',
      fallbacks: [
        { runtime: 'codex', model: 'GPT-5.5', effort: 'high' },
        { runtime: 'claude', model: 'Claude Opus 5', effort: 'high' },
      ],
    },
    ra: {
      runtime: 'codex',
      model: 'GPT-5.5',
      effort: 'medium',
      fallbacks: [
        { runtime: 'claude', model: 'Claude Sonnet 5', effort: 'medium' },
        { runtime: 'antigravity', model: 'Gemini 3.6 Flash (High)' },
      ],
    },
    sm: {
      runtime: 'claude',
      model: 'Claude Haiku 4.5',
      effort: 'low',
      fallbacks: [
        { runtime: 'codex', model: 'GPT-5.4-Mini', effort: 'low' },
        { runtime: 'antigravity', model: 'Gemini 3.7 Flash (Low)' },
      ],
    },
    qa: {
      runtime: 'antigravity',
      model: 'Gemini 3.1 Pro (High)',
      fallbacks: [
        { runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'xhigh' },
        { runtime: 'codex', model: 'GPT-5.5', effort: 'high' },
      ],
    },
  },
}

// Os padrões da instância NÃO participam quando o cliente escolheu — entram só
// no fim da cadeia, como garantia de que ela nunca sai vazia.
const PADROES: ResolverDefaults = {
  runtimeByRole: { po: 'codex', ra: 'codex', sm: 'codex', qa: 'codex' },
}

/**
 * O degrau resolvido ATÉ A LINHA DE COMANDO — que é onde o acerto se prova.
 * Confere o RESULTADO (o argv que o motor receberia), não "a função foi
 * chamada": um teste que só olhasse a chamada passaria com o argumento errado.
 */
function degrauResolvido(sel: { runtime: string; model?: string; effort?: string }): {
  runtime: string
  model: string | undefined
  argv: string[]
} {
  const catalogo = (CATALOGO as Record<string, readonly string[]>)[sel.runtime] ?? []
  // No antigravity o esforço é aplicado trocando o nome do modelo.
  const comEsforco = sel.model
    ? modeloComEsforcoNoNome({ modelo: sel.model, esforco: sel.effort, catalogo })
    : undefined
  const modeloEscolhido =
    sel.runtime === 'antigravity' ? (comEsforco?.modelo ?? sel.model) : sel.model
  const model = modeloEscolhido ? valorDeModeloParaOMotor(sel.runtime, modeloEscolhido) : undefined
  const esforcoArgs = argumentosDeEsforco({
    runtime: sel.runtime,
    ...(sel.effort !== undefined ? { esforco: sel.effort } : {}),
    ...(model !== undefined ? { modelo: model } : {}),
  }).args
  return {
    runtime: sel.runtime,
    model,
    argv: [...(model ? ['--model', model] : []), ...esforcoArgs],
  }
}

function cascataDe(role: F6AgentRole): ReturnType<typeof degrauResolvido>[] {
  return resolveRuntimeChain(role, CASCATA_DO_DONO, PADROES).map(degrauResolvido)
}

describe('a cascata do dono resolve papel por papel, degrau por degrau', () => {
  test('PO: Antigravity Claude Opus → Codex 5.5 → Claude Opus 5', () => {
    expect(cascataDe('po')).toEqual([
      {
        runtime: 'antigravity',
        model: 'Claude Opus 4.6 (Thinking)',
        argv: ['--model', 'Claude Opus 4.6 (Thinking)'],
      },
      {
        runtime: 'codex',
        model: 'gpt-5.5',
        argv: ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=high'],
      },
      {
        runtime: 'claude',
        model: 'claude-opus-5',
        argv: ['--model', 'claude-opus-5', '--effort', 'high'],
      },
    ])
  })

  test('RA: Codex 5.5 → Claude Sonnet → Antigravity Flash 3.6 High', () => {
    expect(cascataDe('ra')).toEqual([
      {
        runtime: 'codex',
        model: 'gpt-5.5',
        argv: ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=medium'],
      },
      {
        runtime: 'claude',
        model: 'claude-sonnet-5',
        argv: ['--model', 'claude-sonnet-5', '--effort', 'medium'],
      },
      {
        runtime: 'antigravity',
        model: 'Gemini 3.6 Flash (High)',
        argv: ['--model', 'Gemini 3.6 Flash (High)'],
      },
    ])
  })

  test('SM: Claude Haiku → Codex 5 mini → Antigravity Flash 3.7 (o mais barato)', () => {
    expect(cascataDe('sm')).toEqual([
      {
        runtime: 'claude',
        model: 'claude-haiku-4-5',
        argv: ['--model', 'claude-haiku-4-5', '--effort', 'low'],
      },
      {
        runtime: 'codex',
        model: 'gpt-5.4-mini',
        argv: ['--model', 'gpt-5.4-mini', '-c', 'model_reasoning_effort=low'],
      },
      {
        runtime: 'antigravity',
        model: 'Gemini 3.7 Flash (Low)',
        argv: ['--model', 'Gemini 3.7 Flash (Low)'],
      },
    ])
  })

  test('QA: Antigravity 3.1 Pro High → Claude Haiku (xhigh) → Codex 5.5', () => {
    expect(cascataDe('qa')).toEqual([
      {
        runtime: 'antigravity',
        model: 'Gemini 3.1 Pro (High)',
        argv: ['--model', 'Gemini 3.1 Pro (High)'],
      },
      {
        runtime: 'claude',
        model: 'claude-haiku-4-5',
        // 'xhigh' existe no claude — é a escada de 5 degraus dele.
        argv: ['--model', 'claude-haiku-4-5', '--effort', 'xhigh'],
      },
      {
        runtime: 'codex',
        model: 'gpt-5.5',
        argv: ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=high'],
      },
    ])
  })

  test('NENHUM degrau do antigravity leva --effort — seria erro duro do CLI', () => {
    for (const role of ['po', 'ra', 'sm', 'qa'] as const) {
      for (const degrau of cascataDe(role)) {
        if (degrau.runtime !== 'antigravity') continue
        expect(degrau.argv).not.toContain('--effort')
      }
    }
  })

  test('nenhum degrau recebe modelo de outro motor (o defeito medido em 01/09)', () => {
    for (const role of ['po', 'ra', 'sm', 'qa'] as const) {
      for (const degrau of cascataDe(role)) {
        const doMotor = (CATALOGO as Record<string, readonly string[]>)[degrau.runtime] ?? []
        const cabe = doMotor.some(
          (m) => valorDeModeloParaOMotor(degrau.runtime, m) === degrau.model
        )
        expect(cabe, `${role}/${degrau.runtime} recebeu "${degrau.model}"`).toBe(true)
      }
    }
  })
})

describe('o esforço pedido tem que ser do motor — nada de nível genérico', () => {
  test("'max' no codex não vira argumento: o codex não tem esse nível", () => {
    const cfg = { agents: { qa: { runtime: 'codex', model: 'GPT-5.5', effort: 'max' } } }
    const [degrau] = resolveRuntimeChain('qa', cfg, PADROES).map(degrauResolvido)
    expect(degrau?.argv).toEqual(['--model', 'gpt-5.5'])
  })

  test("'max' no claude vira argumento: lá o nível existe", () => {
    const cfg = { agents: { qa: { runtime: 'claude', model: 'Claude Opus 5', effort: 'max' } } }
    const [degrau] = resolveRuntimeChain('qa', cfg, PADROES).map(degrauResolvido)
    expect(degrau?.argv).toEqual(['--model', 'claude-opus-5', '--effort', 'max'])
  })

  test('no antigravity, pedir esforço TROCA o modelo pela variante do catálogo', () => {
    const cfg = {
      agents: {
        sm: { runtime: 'antigravity', model: 'Gemini 3.7 Flash (Medium)', effort: 'high' },
      },
    }
    const [degrau] = resolveRuntimeChain('sm', cfg, PADROES).map(degrauResolvido)
    expect(degrau?.model).toBe('Gemini 3.7 Flash (High)')
    expect(degrau?.argv).toEqual(['--model', 'Gemini 3.7 Flash (High)'])
  })
})

describe('aditivo: quem tem só o motor no degrau continua igual', () => {
  test('degrau só com runtime não perde nada e ganha o padrão do papel', () => {
    const cfg = { agents: { qa: { runtime: 'claude', fallbacks: [{ runtime: 'codex' }] } } }
    const chain = resolveRuntimeChain('qa', cfg, PADROES)
    // 'antigravity' entra no fim, completando a cadeia canônica (codex →
    // antigravity → claude) — o cliente só escolheu dois dos três motores
    // que existem, e o terceiro continua como reserva em vez de sumir.
    expect(chain.map((c) => c.runtime)).toEqual(['claude', 'codex', 'antigravity'])
    // Sem modelo escolhido, o padrão do PAPEL naquele MOTOR é quem responde —
    // e ele sai do catálogo vivo daquele motor, nunca de um literal do vizinho.
    const doQa = padraoDoDegrau({ role: 'qa', runtime: 'claude', catalogo: CATALOGO.claude })
    expect(doQa.model).toBe('Claude Opus 5')
    expect(doQa.effort).toBe('high')
  })

  test('esforço inválido no degrau não derruba a cadeia, só não vira argumento', () => {
    const cfg = {
      agents: { sm: { runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'turbo' } },
    }
    const [degrau] = resolveRuntimeChain('sm', cfg, PADROES).map(degrauResolvido)
    expect(degrau?.argv).toEqual(['--model', 'claude-haiku-4-5'])
  })
})
