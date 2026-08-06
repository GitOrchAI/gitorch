import type { F6AgentRole } from '@gitorch/agents'

// Contrato de entregável: uma missão só conta como concluída quando a saída É o
// entregável do papel — não uma saudação, não uma narração de intenções.
//
// Existe porque o critério anterior era "saiu texto e o processo não falhou": a
// missão do PO de 65 caracteres ("I am ready in the sandbox environment. How can
// I help you today?") ficava VERDE no painel e era gravada como memória do
// projeto, envenenando o contexto do agente seguinte. Uma segunda missão do PO,
// de 191 caracteres ("I received your request with just --sandbox. Could you
// please clarify...") tinha o mesmo problema. Em contraste, uma missão real do
// SM de 7.891 caracteres começava com várias linhas de narração ("I will list
// the contents of /workspace", "I will run git status") e terminava em um
// relatório técnico real — essa NÃO pode ser reprovada.
//
// ESCOPO (achado crítico da revisão pós-merge): este contrato só faz sentido no
// caminho CLÁSSICO, onde a saída crua do motor É o entregável. Nos caminhos de
// TRILHOS (PO/SM/QA/RA via *-rails-mission.ts), a LLM só preenche formulários
// validados por schema e quem produz a saída final é o executor determinístico
// do nosso próprio código — essas saídas são prova de entrega por construção e
// não têm por que parecer um documento com seções/listas/código. Aplicar o
// contrato ali reprovava entregas reais (ex.: "PO rails applied wish #7 (...).
// Sprint goal: ... Tree: 1 phase, 2 epics... Executor: created issues #21,
// #22...", ou "QA: no delegated PR awaiting judgment.", 38 caracteres) e
// travava a cascata de onboarding (SM/QA nunca acordavam). Por isso
// `resolveMissionDelivery` recebe o `pathKind` e só chama `assertMissionDelivered`
// quando `pathKind === 'classic'`; nos trilhos, entrega é sempre `{ delivered:
// true }`.

export type MissionDeliveryCheck = { delivered: true } | { delivered: false; reason: string }

/**
 * De onde vem a saída da missão:
 * - 'classic': saída crua do motor (orchestrator.runMission) — precisa do
 *   contrato de estrutura/saudação abaixo.
 * - 'rails': saída produzida pelo executor determinístico dos trilhos
 *   (po/sm/qa/ra-rails-mission.ts) a partir de formulários validados por
 *   schema — é entregável por construção, o contrato não se aplica.
 */
export type MissionPathKind = 'classic' | 'rails'

/**
 * Decide se uma missão concluída (exitCode 0) tem entregável, escolhendo o
 * contrato certo pelo caminho de execução. Ponto único de decisão — o
 * scheduler não deve chamar `assertMissionDelivered` direto, para não
 * reintroduzir o bug de reprovar entregas reais dos trilhos.
 */
export function resolveMissionDelivery(
  role: F6AgentRole,
  output: string,
  pathKind: MissionPathKind
): MissionDeliveryCheck {
  if (pathKind === 'rails') {
    return { delivered: true }
  }
  return assertMissionDelivered(role, output)
}

// AJUSTE vs. o desenho inicial: um limiar único de tamanho (400/1200
// caracteres) não sobrevive à evidência real. A missão de PO rejeitada
// ("I received your request with just --sandbox. Could you please clarify...")
// tem 191 caracteres; a missão de SM que precisa ser ACEITA (delegação +
// watchdog + sensor, sem narração) tem só ~115 caracteres úteis. Um mínimo alto
// o bastante para reprovar a saudação reprovaria também a entrega legítima —
// tamanho não distingue os dois casos. O sinal que distingue é ESTRUTURA
// (seções, listas, código: o formato real de um entregável de qualquer papel
// F6) combinado com padrão de saudação. O tamanho mínimo aqui é só um piso
// para descartar respostas triviais tipo "ok"/"done" antes de gastar regex.
//
// Válido só no caminho CLÁSSICO (ver resolveMissionDelivery acima) — nos
// trilhos, um entregável real como "QA: no delegated PR awaiting judgment."
// (38 caracteres) fica abaixo deste piso e por isso não passa mais por aqui.
const TAMANHO_MINIMO = 40

/**
 * Frases de motor ocioso: ele acordou, não recebeu missão, e ofereceu ajuda.
 * Só valem como rejeição quando a saída NÃO tem estrutura FORTE de entregável
 * (ver ESTRUTURA_FORTE abaixo) — um relatório real que termine com "como
 * posso ajudar mais?" não deve ser reprovado por isso.
 *
 * Generalizadas a partir do incidente real (não são mais o texto literal da
 * transcrição) para não overfit numa frase exata que o motor não repete.
 */
const SAUDACOES = [
  /how can i (help|assist)/i,
  /como posso (ajudar|auxiliar)/i,
  /(i am|i'm) ready (in|to)/i,
  /ambiente .{0,30}(pronto|inicializado)/i,
  /\bcould (you )?please clarify\b/i,
  /\bwithout (a |any )?(clear |specific )?(task|instructions?|mission)\b/i,
  /\bwhat (would you like|do you want) me to do\b/i,
]

/**
 * Linhas que são apenas anúncio de intenção, sem resultado nenhum.
 *
 * Só os padrões em inglês observados no incidente real ("I will...", "I'm
 * going to..."). Um catch-all "vou "/"irei " foi removido: comeria qualquer
 * linha de um entregável real escrito em português que comece assim (ex.:
 * "Vou implementar X da seguinte forma: ..."), sem nenhuma evidência real de
 * motor produzindo narração nesses termos em pt-BR.
 */
const NARRACAO = /^\s*(i will|i'm going to)\b/i

/** Marcas de que a saída tem estrutura de entregável (seções, listas, dados). */
const ESTRUTURA = /^\s*(#{1,4}\s|\d+[.)]\s|[-*]\s|\{|```)/m

/**
 * Estrutura FORTE: seções, listas numeradas, JSON ou bloco de código. Uma
 * lista solta de marcadores ("- ") NÃO conta como forte — é exatamente o que
 * um motor ocioso produz ao formatar perguntas de esclarecimento como lista
 * ("Could you please clarify: - Do you want me to analyse the repository? -
 * Do you want me to write code?"), o que fazia essa saudação passar pelo
 * contrato antigo. Só estrutura forte pode anular um padrão de saudação.
 */
const ESTRUTURA_FORTE = /^\s*(#{1,4}\s|\d+[.)]\s|\{|```)/m

export function assertMissionDelivered(role: F6AgentRole, output: string): MissionDeliveryCheck {
  const texto = output.trim()

  const semNarracao = texto
    .split('\n')
    .filter((linha) => !NARRACAO.test(linha))
    .join('\n')
    .trim()

  if (texto.length > 0 && semNarracao.length === 0) {
    return {
      delivered: false,
      reason: `missão de ${role} sem entregável: a saída é narração de intenções, sem resultado`,
    }
  }

  if (semNarracao.length < TAMANHO_MINIMO) {
    return {
      delivered: false,
      reason: `missão de ${role} sem entregável: a saída tem ${semNarracao.length} caracteres úteis, abaixo do mínimo de ${TAMANHO_MINIMO}`,
    }
  }

  const temEstrutura = ESTRUTURA.test(semNarracao)
  const temEstruturaForte = ESTRUTURA_FORTE.test(semNarracao)
  const eSaudacao = SAUDACOES.some((padrao) => padrao.test(semNarracao))

  if (eSaudacao && !temEstruturaForte) {
    return {
      delivered: false,
      reason: `missão de ${role} sem entregável: o motor respondeu como se não tivesse recebido missão`,
    }
  }

  if (!temEstrutura) {
    return {
      delivered: false,
      reason: `missão de ${role} sem entregável: a saída não tem a estrutura do entregável do papel`,
    }
  }

  return { delivered: true }
}
