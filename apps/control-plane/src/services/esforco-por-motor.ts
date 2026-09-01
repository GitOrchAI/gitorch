import type { F6AgentRuntime } from '@gitorch/agents'

/**
 * ESFORÇO NÃO É UMA COISA SÓ. Cada motor expressa do seu jeito, e um deles não
 * expressa de jeito nenhum quando o modelo está fixado.
 *
 * Tudo aqui foi MEDIDO nesta VM em 01/09/2026, rodando os CLIs reais com a
 * credencial real do dono. Nenhum valor veio de documentação ou de memória —
 * a lição de 31/08 (um literal de modelo que envelheceu e matou 24 missões em
 * 9h48) vale igual para os níveis de esforço.
 *
 * ── claude (Claude Code CLI) ────────────────────────────────────────────────
 *   $ claude --help
 *     --effort <level>   Effort level for the current session
 *                        (low, medium, high, xhigh, max)
 *   $ claude --effort bogus -p "say ok"
 *     Warning: Unknown --effort value 'bogus' — ignoring it and using the
 *     default effort. Valid values: low, medium, high, xhigh, max.
 *     ok
 *   $ claude --model claude-haiku-4-5 --effort max -p "responda so: ok"  →  ok
 *   $ claude --model claude-sonnet-5  --effort xhigh -p "responda so: ok" →  ok
 *
 *   ATENÇÃO ao comportamento do CLI: valor inválido NÃO é erro — ele AVISA e
 *   roda no padrão. Ou seja, um esforço errado nosso passaria despercebido e o
 *   cliente pagaria por um nível que nunca foi aplicado. Por isso a validação
 *   é NOSSA, na porta (ver `esforcoValidoNoMotor`), e não delegada ao CLI.
 *
 * ── codex (OpenAI Codex CLI 0.142.5) ────────────────────────────────────────
 *   NÃO existe `--effort`. Conferido: `codex exec --help | grep -i effort` sai
 *   vazio. O esforço é uma chave de configuração:
 *
 *   $ codex exec --strict-config -c model_reasoning_effort=high ... "say ok"
 *     model: GPT-5.4-Mini
 *     reasoning effort: high          ← o CLI ecoa no cabeçalho da sessão
 *
 *   E a chave é RECONHECIDA de verdade, não engolida: com `--strict-config`,
 *   uma chave inventada é recusada na porta —
 *   $ codex exec --strict-config -c chave_que_nao_existe=1 ...
 *     Error loading config.toml: unknown configuration field
 *     `chave_que_nao_existe` in -c/--config override
 *   — enquanto `model_reasoning_effort` passa. Esse contraste é a prova de que
 *   o campo existe no esquema do CLI, e não de que ele aceita qualquer coisa.
 *
 *   Os NÍVEIS vêm do catálogo que o próprio servidor entrega ao CLI
 *   (`~/.codex/models_cache.json`, campo `supported_reasoning_levels`), lido
 *   nesta VM no mesmo dia:
 *     gpt-5.5       default=medium  efforts=[low, medium, high, xhigh]
 *     gpt-5.4-mini  default=medium  efforts=[low, medium, high, xhigh]
 *   Repare que 'max' NÃO está lá — existe no claude e não existe no codex.
 *   Uma lista única para os dois motores mandaria um valor inválido para a API
 *   do provedor, e o CLI não valida isso do lado de cá.
 *
 * ── antigravity (agy 1.1.22) ────────────────────────────────────────────────
 *   Aqui está o achado que muda o desenho. A flag EXISTE:
 *     $ agy --help
 *       --effort   Reasoning effort for the current CLI session (low|medium|high)
 *     $ agy --effort bogus --print "say ok"
 *       Error: invalid model selection (--model "" --effort "bogus"):
 *              invalid --effort "bogus" (valid: low, medium, high)
 *     $ agy --effort high --print "responda so: ok"   →  ok
 *
 *   MAS ela é MUTUAMENTE EXCLUSIVA com `--model`. Sempre, para todo modelo:
 *     $ agy --model "Gemini 3.7 Flash (Medium)" --effort high --print ...
 *       Error: invalid model selection (--model "Gemini 3.7 Flash (Medium)"
 *              --effort "high"): --effort is not supported for model
 *              "Gemini 3.7 Flash (Medium)"
 *     $ agy --model "Claude Opus 4.6 (Thinking)" --effort high --print ...
 *       Error: ... --effort is not supported for model "Claude Opus 4.6 (Thinking)"
 *     $ agy --model "Gemini 3.7 Flash" --effort high --print ...   (nome base)
 *       Error: ... --effort is not supported for model "Gemini 3.7 Flash"
 *
 *   A cascata SEMPRE fixa o modelo do degrau. Logo, no antigravity o esforço
 *   não é separável: ele já está DENTRO do nome — `Gemini 3.7 Flash (High)`,
 *   `(Medium)`, `(Low)`. Escolher esforço ali é escolher outro modelo, e é
 *   isso que `modeloComEsforcoNoNome` faz, contra o catálogo VIVO.
 *
 *   Isto é exatamente o que o dono mandou não fingir. Emitir `--effort` junto
 *   com `--model` no antigravity mataria 100% das missões dele com `invalid
 *   model selection` — a MESMA falha de 31/08, reintroduzida por um esforço
 *   genérico inventado por nós.
 */

/** Como cada motor expressa esforço na linha de comando. */
export type FormaDeEsforco =
  /** Flag dedicada do CLI (`--effort high`). */
  | 'flag'
  /** Chave de configuração (`-c model_reasoning_effort=high`). */
  | 'config'
  /** Não é separável: o esforço faz parte do NOME do modelo. */
  | 'no-nome-do-modelo'

export const COMO_O_MOTOR_EXPRESSA_ESFORCO: Readonly<Record<F6AgentRuntime, FormaDeEsforco>> =
  Object.freeze({
    claude: 'flag',
    codex: 'config',
    antigravity: 'no-nome-do-modelo',
  })

/**
 * Os níveis que CADA motor aceita de verdade. Listas diferentes de propósito:
 * 'max' só existe no claude, 'xhigh' não existe no antigravity. Ver o
 * cabeçalho para a saída de comando que provou cada uma.
 */
export const ESFORCOS_DO_MOTOR: Readonly<Record<F6AgentRuntime, readonly string[]>> = Object.freeze(
  {
    claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    codex: Object.freeze(['low', 'medium', 'high', 'xhigh']),
    antigravity: Object.freeze(['low', 'medium', 'high']),
  }
)

export function esforcoValidoNoMotor(runtime: string, esforco: string): boolean {
  const niveis = (ESFORCOS_DO_MOTOR as Record<string, readonly string[] | undefined>)[runtime]
  return niveis !== undefined && niveis.includes(esforco)
}

/** A chave de configuração do Codex que carrega o esforço. */
const CHAVE_DE_ESFORCO_DO_CODEX = 'model_reasoning_effort'

export interface ArgumentosDeEsforco {
  /** O que acrescentar à linha de comando. Vazio quer dizer "nada a passar". */
  args: string[]
  /** Por que nada foi passado, quando o pedido não pôde ser atendido. */
  aviso?: string
}

/**
 * Traduz o esforço do degrau para o argumento que AQUELE motor aceita.
 *
 * Devolve `[]` sempre que passar o argumento seria pior que não passar:
 * esforço não pedido, nível que o motor não conhece, ou antigravity com modelo
 * fixado (onde a flag é erro duro). Nunca "aproxima" um nível para o vizinho —
 * trocar `max` por `high` no codex mudaria o comportamento do agente pelas
 * costas do cliente, que é a classe de defeito que este produto já pagou caro.
 */
export function argumentosDeEsforco(args: {
  runtime: string
  esforco?: string | undefined
  modelo?: string | undefined
}): ArgumentosDeEsforco {
  const { runtime, esforco, modelo } = args
  if (!esforco) return { args: [] }

  const forma = (COMO_O_MOTOR_EXPRESSA_ESFORCO as Record<string, FormaDeEsforco | undefined>)[
    runtime
  ]
  if (!forma) {
    return { args: [], aviso: `motor "${runtime}" desconhecido — esforço "${esforco}" ignorado` }
  }

  if (!esforcoValidoNoMotor(runtime, esforco)) {
    const niveis = (ESFORCOS_DO_MOTOR as Record<string, readonly string[]>)[runtime] ?? []
    return {
      args: [],
      aviso:
        `o motor "${runtime}" não tem o esforço "${esforco}" ` +
        `(aceita: ${niveis.join(', ')}) — o degrau roda no esforço padrão dele`,
    }
  }

  if (forma === 'flag') return { args: ['--effort', esforco] }
  if (forma === 'config') return { args: ['-c', `${CHAVE_DE_ESFORCO_DO_CODEX}=${esforco}`] }

  // 'no-nome-do-modelo': a flag existe no CLI mas é recusada junto com
  // --model, e a cascata sempre fixa o modelo. O esforço já foi aplicado
  // antes, trocando o nome do modelo (ver modeloComEsforcoNoNome).
  return {
    args: [],
    aviso:
      `o motor "${runtime}" não aceita esforço separado do modelo ` +
      `(\`--effort\` junto de \`--model\` é erro duro do CLI); o esforço "${esforco}" ` +
      `vive dentro do nome do modelo${modelo ? ` — usando "${modelo}"` : ''}`,
  }
}

/** `Gemini 3.7 Flash (Medium)` → base `Gemini 3.7 Flash`, esforço `medium`. */
const NOME_COM_SUFIXO_DE_ESFORCO = /^(.*?)\s*\(([^()]+)\)\s*$/

function partesDoNome(nome: string): { base: string; esforco: string } | null {
  const m = NOME_COM_SUFIXO_DE_ESFORCO.exec(nome.trim())
  if (!m) return null
  const base = (m[1] ?? '').trim()
  const esforco = (m[2] ?? '').trim().toLowerCase()
  if (!base || !esforco) return null
  return { base, esforco }
}

export interface ModeloComEsforco {
  modelo: string
  trocado: boolean
  aviso?: string
}

/**
 * No antigravity, aplicar um esforço é trocar o modelo pela variante de mesmo
 * nome-base com aquele sufixo — e só se ela EXISTIR no catálogo vivo daquele
 * cliente.
 *
 * Fica na MESMA geração de propósito. `Gemini 3.6 Flash (High)` pedindo `low`
 * vira `Gemini 3.6 Flash (Low)`, nunca `Gemini 3.7 Flash (Low)`: quem fixou
 * 3.6 no degrau fixou de propósito, e trocar a geração aqui seria desfazer a
 * escolha do cliente com a desculpa de atender o esforço. (A troca de geração
 * tem dono e é outra: `escolherModeloVivo`, que só age quando o modelo pedido
 * SUMIU do catálogo.)
 *
 * Não existindo a variante — o catálogo real de hoje tem `Gemini 3.1 Pro` só
 * em High e Low, sem Medium — mantém o modelo pedido e DIZ. Inventar uma
 * variante que o provedor não tem é reproduzir `invalid model selection`.
 *
 * Catálogo vazio é "não sei", nunca "não existe": segue com o pedido, mesmo
 * fail-open do resto do produto.
 */
export function modeloComEsforcoNoNome(args: {
  modelo: string
  esforco?: string | undefined
  catalogo: readonly string[]
}): ModeloComEsforco {
  const { modelo, esforco } = args
  if (!esforco) return { modelo, trocado: false }

  const alvo = partesDoNome(modelo)
  if (!alvo) {
    return {
      modelo,
      trocado: false,
      aviso:
        `o modelo "${modelo}" não carrega esforço no nome, e este motor não tem ` +
        `esforço separável — o esforço "${esforco}" não pôde ser aplicado`,
    }
  }
  if (alvo.esforco === esforco.toLowerCase()) return { modelo, trocado: false }

  const catalogo = args.catalogo.filter((m) => typeof m === 'string')
  // FAIL-OPEN: sem catálogo não dá para provar que a variante existe.
  if (catalogo.length === 0) return { modelo, trocado: false }

  const variante = catalogo.find((nome) => {
    const p = partesDoNome(nome)
    return p !== null && p.base === alvo.base && p.esforco === esforco.toLowerCase()
  })

  if (!variante) {
    return {
      modelo,
      trocado: false,
      aviso:
        `o motor não tem "${alvo.base} (${esforco})" no catálogo vivo — ` +
        `mantendo "${modelo}", que é o que existe`,
    }
  }
  return { modelo: variante, trocado: true }
}

/**
 * O valor que de fato serve como `--model` DAQUELE motor.
 *
 * DOIS dos três catálogos guardam um nome de VITRINE que o CLI correspondente
 * RECUSA. É o defeito de 31/08 num disfarce novo — a coleta grava uma coisa, a
 * execução precisa de outra, e os dois trilhos nunca se encontram — e ele
 * estava esperando por todo degrau de claude e de codex desta cascata.
 *
 * ── claude ──────────────────────────────────────────────────────────────────
 * O catálogo vem de `display_name` da API `/v1/models` (ver model-catalog.ts).
 * Medido ao vivo em 01/09/2026 com a credencial real do dono:
 *
 *   $ claude --model "Claude Opus 5" -p "responda so: ok"
 *     [claude-code:unrecognized_model] {"model":"Claude Opus 5", ...}
 *     There's an issue with the selected model (Claude Opus 5).
 *   $ claude --model claude-opus-5     -p "responda so: ok"   →  ok
 *   $ claude --model claude-haiku-4-5  -p "responda so: ok"   →  ok
 *   $ claude --model claude-opus-4-8   -p "responda so: ok"   →  ok
 *   $ claude --model claude-sonnet-4-5 -p "responda so: ok"   →  ok
 *
 * Regra provada: minúsculas, e tudo que não é letra ou número vira hífen — o
 * ponto de `4.5` inclusive (`Claude Haiku 4.5` → `claude-haiku-4-5`).
 *
 * ── codex ───────────────────────────────────────────────────────────────────
 * O catálogo vem de `display_name || slug` de `~/.codex/models_cache.json`, e
 * o display_name é igualmente recusado. O contraste dos DOIS erros é a prova:
 *
 *   $ codex exec -m "GPT-5.5" ... "say ok"
 *     model: GPT-5.5
 *     ERROR: The 'GPT-5.5' model is not supported when using Codex with a
 *            ChatGPT account.                 ← morreu na validação do modelo
 *   $ codex exec -m gpt-5.5 ... "say ok"
 *     model: gpt-5.5
 *     ERROR: You've hit your usage limit ...  ← PASSOU pelo modelo
 *
 * O segundo erro é de COTA, não de modelo: o pedido chegou ao provedor. (A
 * cota desta conta está esgotada até 21/09, então a resposta final não pôde
 * ser obtida hoje — mas a validação do modelo, que é o que se testa aqui,
 * acontece antes e foi observada nas duas direções.)
 *
 * E a regra do codex NÃO é a do claude: os identificadores reais do cache são
 * `gpt-5.5` e `gpt-5.4-mini`, com o PONTO preservado. Aplicar a regra do
 * claude produziria `gpt-5-5`, que não existe. Só o espaço vira hífen
 * (`Codex Auto Review` → `codex-auto-review`).
 *
 * ── antigravity ─────────────────────────────────────────────────────────────
 * Passa intacto, e é o único: lá o `--model` aceita justamente o nome de
 * exibição que o catálogo guarda (`agy --model "Gemini 3.7 Flash (Medium)"`).
 */
export function valorDeModeloParaOMotor(runtime: string, modelo: string): string {
  const cru = modelo.trim()
  // Já é identificador/apelido: sem espaço e sem maiúscula, nada a converter.
  const precisaConverter = /[\s A-Z]/.test(cru)

  if (runtime === 'claude') {
    if (!/[\s.A-Z]/.test(cru)) return cru
    return cru
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  if (runtime === 'codex') {
    if (!precisaConverter) return cru
    // Ponto PRESERVADO — `gpt-5.5`, não `gpt-5-5`.
    return cru
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  return cru
}
