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

export type MissionDeliveryCheck = { delivered: true } | { delivered: false; reason: string }

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
const TAMANHO_MINIMO = 40

/**
 * Frases de motor ocioso: ele acordou, não recebeu missão, e ofereceu ajuda.
 * Só valem como rejeição quando a saída NÃO tem estrutura de entregável (ver
 * uso abaixo) — um relatório real que termine com "como posso ajudar mais?"
 * não deve ser reprovado por isso.
 */
const SAUDACOES = [
  /how can i (help|assist)/i,
  /como posso (ajudar|auxiliar)/i,
  /(i am|i'm) ready (in|to)/i,
  /ambiente .{0,30}(pronto|inicializado)/i,
  /received your request with just/i,
  /could you please clarify/i,
]

/** Linhas que são apenas anúncio de intenção, sem resultado nenhum. */
const NARRACAO = /^\s*(i will|i'm going to|vou |irei )/i

/** Marcas de que a saída tem estrutura de entregável (seções, listas, dados). */
const ESTRUTURA = /^\s*(#{1,4}\s|\d+[.)]\s|[-*]\s|\{|```)/m

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
  const eSaudacao = SAUDACOES.some((padrao) => padrao.test(semNarracao))

  if (eSaudacao && !temEstrutura) {
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
