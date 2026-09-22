// O motor do próximo passo: substitui decidirAcaoNoPrOrfao (vigia-do-pr.ts).
// Os PORTÕES de segurança de hoje (PR de gente nunca é tocado, automação sem
// conserto, sessão viva, cedo demais, teto de ações, sem tarefa de origem,
// tarefa já fechada, mergeable/verificação desconhecidos) continuam
// EXATAMENTE os mesmos — só a decisão final muda: NUNCA "escalar" como
// resposta padrão. A configuração de quem cuida de cada origem (Tarefa 0.2)
// decide entre mesclar sozinho, perguntar antes, ou só acompanhar.

import {
  ehPRDaAutomacao,
  ehAutomacaoQueOVigiaNaoConserta,
  branchParaRetomar,
  MAX_ACOES_DO_VIGIA,
  IDADE_MINIMA_DE_ORFANDADE_MS,
  type SinaisDePR,
  type RamoDoPr,
  type EstadoDaVerificacao,
  type CausaDaParada,
} from './vigia-do-pr.js'
import type { CuidaPorOrigem } from './cuidado-por-origem.js'

export type AcaoDoMotor =
  | { acao: 'so-acompanhar'; motivo: string }
  | {
      acao: 'retomar'
      issueNumber: number
      causa: CausaDaParada
      pedido: string
      branchDoPr: string
      motivo: string
    }
  | { acao: 'fechar-vazio'; motivo: string }
  | { acao: 'mesclar'; motivo: string }
  | { acao: 'perguntar-se-cuida'; motivo: string }
  | { acao: 'escalar'; motivo: string }

export interface MotorDoProximoPassoDeps extends RamoDoPr {
  numero: number
  sinais: SinaisDePR
  temSessaoViva: boolean
  issueNumber: number | null
  issueAberta: boolean
  mergeable: boolean | null
  verificacao: EstadoDaVerificacao
  paradoHaMs: number
  acoesAnteriores: number
  podeAbrirSessao: boolean
  origem: string
  cuidaPorOrigem: CuidaPorOrigem
  /** Horas desde o último commit/marca de rascunho, ou `null` quando não
   *  está em construção (não é rascunho e o último commit já passou da
   *  janela). Calculado pelo chamador — este módulo só compara. */
  emConstrucaoHa: number | null
  janelaEmConstrucaoHoras: number
  /** Presentes só quando há veredito do QA para considerar (item já
   *  julgado) — ausentes, o motor nunca decide "mesclar". */
  entendimentoCompleto?: boolean
  vereditoDoQa?: 'approve' | 'request_changes'
  /** Fase 5.5: true quando o plano do GitHub não permite a melhoria paga E
   *  a alternativa gratuita ainda não está instalada no repositório. O motor
   *  degrada a decisão de 'mesclar' para 'perguntar-se-cuida' para exigir
   *  revisão humana, pois não confia que o código está livre de segredos. */
  exigeRevisaoDeSeguranca?: boolean
}

/** 'jules_gitorch'/'jules_fora' caem no balde `jules` de cuidaPorOrigem;
 *  'assistente' e 'pessoa' são os próprios nomes; 'dependabot' idem;
 *  'outro_bot' NUNCA é julgado — sempre só acompanha (Tarefa 3.9). */
function baldeDeCuidado(origem: string): keyof CuidaPorOrigem | null {
  if (origem === 'jules_gitorch' || origem === 'jules_fora' || origem === 'jules') return 'jules'
  if (origem === 'assistente' || origem === 'pessoa' || origem === 'dependabot') return origem
  if (origem === 'desconhecido') return 'jules'
  return null
}

export function decidirProximoPasso(deps: MotorDoProximoPassoDeps): AcaoDoMotor {
  // Portões herdados 1-9 (mesma ordem e mesmo motivo de decidirAcaoNoPrOrfao).
  if (!ehPRDaAutomacao(deps.sinais)) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} é entrega de gente` }
  }
  if (ehAutomacaoQueOVigiaNaoConserta(deps.sinais)) {
    return {
      acao: 'so-acompanhar',
      motivo: `#${deps.numero} é automação sem sessão atrás para retomar`,
    }
  }
  if (deps.temSessaoViva) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} ainda tem sessão viva` }
  }

  // A CONFIGURAÇÃO decide ANTES de qualquer julgamento de conteúdo — Fase
  // 3.9/3.10: "não cuidada" nunca chega a ser julgada.
  const balde = baldeDeCuidado(deps.origem)
  const politica = balde ? deps.cuidaPorOrigem[balde] : 'nao'
  if (politica === 'nao' || balde === null) {
    return { acao: 'so-acompanhar', motivo: `origem "${deps.origem}" configurada para não cuidar` }
  }

  // EM CONSTRUÇÃO: dentro da janela, só acompanha — mesmo com "sim".
  if (deps.emConstrucaoHa !== null && deps.emConstrucaoHa < deps.janelaEmConstrucaoHoras) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} ainda está em construção` }
  }

  if (deps.paradoHaMs < IDADE_MINIMA_DE_ORFANDADE_MS) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} recebeu novidade recente` }
  }
  if (deps.acoesAnteriores > MAX_ACOES_DO_VIGIA) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} já foi ao dono depois do teto` }
  }
  if (deps.issueNumber === null) {
    return politica === 'perguntar'
      ? { acao: 'perguntar-se-cuida', motivo: `#${deps.numero}: sem tarefa de origem registrada` }
      : {
          acao: 'escalar',
          motivo: `#${deps.numero}: sem tarefa de origem registrada, e a configuração manda cuidar sozinho`,
        }
  }
  if (!deps.issueAberta) {
    return { acao: 'fechar-vazio', motivo: `a tarefa #${deps.issueNumber} já está fechada` }
  }
  if (deps.mergeable === null) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: o GitHub ainda está calculando` }
  }
  if (deps.verificacao === 'pendente') {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: verificação ainda rodando` }
  }

  const causa: CausaDaParada | null =
    deps.mergeable === false ? 'conflito' : deps.verificacao === 'vermelha' ? 'ci-vermelha' : null

  if (causa === null) {
    // Nada para consertar. Pronto para julgar/mesclar — ou perguntar, ou
    // acompanhar, conforme a configuração. NUNCA "escalar" primeiro.
    if (deps.vereditoDoQa === 'approve' && deps.entendimentoCompleto) {
      if (deps.exigeRevisaoDeSeguranca) {
        return {
          acao: 'perguntar-se-cuida',
          motivo: `#${deps.numero}: pronto, mas o plano gratuito sem scanner exige revisão humana de segurança`,
        }
      }
      return {
        acao: 'mesclar',
        motivo: `#${deps.numero}: critérios batidos, mesclando conforme "${politica}"`,
      }
    }
    return politica === 'perguntar'
      ? { acao: 'perguntar-se-cuida', motivo: `#${deps.numero} está pronto — cuido deste pedido?` }
      : { acao: 'so-acompanhar', motivo: `#${deps.numero}: aguardando julgamento` }
  }

  const branch = branchParaRetomar(deps)
  if (branch === null) {
    return politica === 'perguntar'
      ? {
          acao: 'perguntar-se-cuida',
          motivo: `#${deps.numero}: precisa de conserto, sem ramo utilizável`,
        }
      : {
          acao: 'escalar',
          motivo: `#${deps.numero}: precisa de conserto, sem ramo utilizável, e a configuração manda cuidar sozinho`,
        }
  }
  if (!deps.podeAbrirSessao) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: sem vaga na conta do dev agora` }
  }

  return {
    acao: 'retomar',
    issueNumber: deps.issueNumber,
    causa,
    branchDoPr: branch,
    pedido:
      causa === 'conflito'
        ? `Traga a base para o seu ramo e resolva o conflito do pull request #${deps.numero}.`
        : `A verificação automática do pull request #${deps.numero} está vermelha — conserte a causa.`,
    motivo: `#${deps.numero}: ${causa === 'conflito' ? 'conflito' : 'verificação vermelha'}, abrindo sessão nova`,
  }
}
