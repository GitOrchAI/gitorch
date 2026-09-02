import type { F6AgentRole } from '@gitorch/agents'

// Descanso depois de uma acordada VAZIA.
//
// O QUE FOI MEDIDO (banco de produção, 21/08/2026): 203 missões de julgamento
// criadas no dia, 143 delas devolvendo "no delegated PR awaiting judgment" —
// cerca de 13 por hora, o dia inteiro. Nenhuma delas chegou a chamar o motor
// (o julgamento devolve `noOp` antes de qualquer passo de LLM), então não é
// cota do cliente queimada; é contêiner subindo à toa, chamada de API e ruído
// na tabela de missões.
//
// A CAUSA: a vigília de sessão reexamina cada sessão viva a cada ~10 minutos e
// pede julgamento para toda sessão que já tem pull request — e a sessão só
// fecha quando a publicação é confirmada. Uma entrega cujo pull request JÁ
// recebeu parecer continua pedindo julgamento para sempre. Com 9 a 11 sessões
// vivas em dois projetos, dá exatamente os ~13/hora observados. Isso ficou
// visível agora porque o julgamento saiu do teto diário (decisão D25) — antes,
// o teto de 24 mascarava a rajada.
//
// A MARCA QUE FALTAVA CONSUMIR: `noOp` já é produzida por qa-rails-mission.ts,
// sm-delegation.ts, incident-sensor.ts e sm-watchdog.ts, e ninguém a lia. Este
// módulo é o elo que faltava.
//
// O QUE ESTE MÓDULO DELIBERADAMENTE NÃO FAZ:
//
// 1. Não cala o julgamento. A decisão D25 do dono existe justamente para o QA
//    nunca ficar mudo, e o descanso vale só para acordadas que JÁ se provaram
//    vazias. Origem que traz informação nova (aviso do GitHub sobre um pull
//    request específico, fila levantada pelo SM) FURA o descanso.
// 2. Não pula calado. Quem consulta recebe até quando o descanso vale, para
//    registrar no log — pular em silêncio é o defeito que estamos consertando,
//    não a solução.
// 3. Não decide sozinho quando acaba: uma acordada que FEZ trabalho apaga o
//    descanso na hora, porque o projeto claramente voltou a ter o que fazer.

/**
 * De onde veio o pedido de acordar. É o que separa "o relógio bateu de novo"
 * de "aconteceu alguma coisa nova neste repositório".
 */
export type OrigemDoDisparo =
  /** Relógio: a janela do cron do papel. */
  | 'agenda'
  /** Vigília das sessões do dev assíncrono (a cada ~10 min por sessão viva). */
  | 'vigia'
  /** Aviso do GitHub sobre um pull request específico (CI concluído, PR aberto). */
  | 'aviso-do-github'
  /** Fila que o acordar do SM levantou: entrega aberta sem parecer nosso. */
  | 'fila-do-sm'
  /**
   * O papel ANTERIOR terminou e deixou trabalho pronto. É a esteira andando
   * sem esperar o próximo agendamento — medido em 26/08: sem isto, o desejo
   * do dono parava entre o RA e o PO até alguém acordar o PO na mão.
   */
  | 'esteira'
  /** Rota administrativa / disparo manual. */
  | 'sob-demanda'
  /** Cascata de onboarding de um projeto novo. */
  | 'onboarding'
  /**
   * D16: o control-plane RETOMOU sozinho, na subida do processo, uma vez
   * pendente que sobreviveu a um restart (persistida em VezPendente — ver
   * services/vez-pendente.ts). Mesmo motivo de 'esteira': o papel anterior
   * terminou e deixou trabalho pronto; só que desta vez a informação
   * atravessou um restart em vez de continuar no mesmo processo.
   */
  | 'boot'

/**
 * Origens que trazem INFORMAÇÃO NOVA e por isso furam o descanso.
 *
 * `fila-do-sm` está aqui por um motivo concreto: o SM só enfileira depois de
 * ver, na API do GitHub, uma entrega aberta sem parecer nosso no commit de
 * agora. Sem esta exceção, o descanso anularia exatamente o conserto que faz o
 * julgamento acordar quando PRECISA.
 */
const ORIGENS_QUE_FURAM: ReadonlySet<OrigemDoDisparo> = new Set<OrigemDoDisparo>([
  'aviso-do-github',
  'fila-do-sm',
  // Pelo MESMO motivo do `fila-do-sm`: o bastão só é passado quando o papel
  // anterior de fato produziu algo (acordada em falso não passa). É
  // informação nova, e o descanso não pode engolir justamente o conserto que
  // faz a esteira ser contínua.
  'esteira',
  'sob-demanda',
  'onboarding',
  // Pelo MESMO motivo de 'esteira' — só que a informação atravessou um
  // restart do processo em vez de continuar no mesmo (D16, vez-pendente.ts).
  'boot',
])

export function origemFuraODescanso(origem: OrigemDoDisparo): boolean {
  return ORIGENS_QUE_FURAM.has(origem)
}

export interface DecisaoDeDescanso {
  pular: boolean
  /** Até quando o descanso vale — vai para o log, para o pulo nunca ser mudo. */
  ate?: Date
  /**
   * Primeira consulta desde que o descanso começou. Serve para avisar ALTO uma
   * vez e baixo nas repetições: o relógio consulta a cada minuto, e repetir o
   * mesmo aviso sessenta vezes por hora apagaria o sinal tanto quanto o
   * silêncio.
   */
  primeiraVez: boolean
}

export interface RegistroDeDescanso {
  registrarAcordadaVazia(args: { projectId: string; role: F6AgentRole; agora?: Date }): Date
  registrarAcordadaProdutiva(args: { projectId: string; role: F6AgentRole }): void
  consultar(args: {
    projectId: string
    role: F6AgentRole
    origem: OrigemDoDisparo
    agora?: Date
  }): DecisaoDeDescanso
}

/**
 * `duracaoMs` zero (ou negativo) desliga o descanso por completo — a válvula
 * de escape para quando o dono quiser o comportamento antigo de volta sem
 * precisar de deploy de código.
 */
export function criarRegistroDeDescanso(duracaoMs: number): RegistroDeDescanso {
  const descansando = new Map<string, { ate: number; avisado: boolean }>()
  const chave = (projectId: string, role: F6AgentRole) => `${projectId}:${role}`

  return {
    registrarAcordadaVazia({ projectId, role, agora }) {
      const inicio = (agora ?? new Date()).getTime()
      const ate = inicio + Math.max(duracaoMs, 0)
      descansando.set(chave(projectId, role), { ate, avisado: false })
      return new Date(ate)
    },
    registrarAcordadaProdutiva({ projectId, role }) {
      descansando.delete(chave(projectId, role))
    },
    consultar({ projectId, role, origem, agora }) {
      if (duracaoMs <= 0) return { pular: false, primeiraVez: false }
      if (origemFuraODescanso(origem)) return { pular: false, primeiraVez: false }

      const k = chave(projectId, role)
      const atual = descansando.get(k)
      if (!atual) return { pular: false, primeiraVez: false }

      const momento = (agora ?? new Date()).getTime()
      if (atual.ate <= momento) {
        descansando.delete(k)
        return { pular: false, primeiraVez: false }
      }

      const primeiraVez = !atual.avisado
      if (primeiraVez) descansando.set(k, { ...atual, avisado: true })
      return { pular: true, ate: new Date(atual.ate), primeiraVez }
    },
  }
}
