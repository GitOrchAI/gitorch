// Quanto o nosso ciclo REALMENTE custa — contando o retrabalho.
//
// O raciocínio do dono, nas palavras dele: "se o modelo 3.1 pro do gemini é 20x
// melhor que humano... porém se teve 5 retrabalhos no jules, o ganho real não é
// 20x". A medição tem que descontar o retrabalho, não só somar o acerto.
//
// E o número vem do NOSSO banco. Multiplicador importado de fora ("IA é 10x
// mais rápida") é marketing de outra empresa, não medição nossa — e o dono
// decide em cima do que a gente mede.
//
// MEDIANA E P90, NUNCA SÓ MÉDIA. Uma entrega que travou 40 vezes puxa a média
// para cima e some no meio das outras; a mediana diz como é o caso típico e o
// p90 diz o quão ruim fica a cauda. As duas juntas é que descrevem o ciclo.
//
// O QUE NÃO DÁ PARA MEDIR HOJE APARECE COMO NULO, e a tela mostra travessão. O
// veredito do QA, por exemplo, não é gravado em lugar nenhum que dê para
// contar: o evento `qa_judgment` carrega só `{peloPortao: true}`. Inventar uma
// taxa de reprovação a partir disso seria número que ninguém mediu.

/** Os fatos de retrabalho que `dev_sessions` já grava, por entrega. */
export interface FatosDoCiclo {
  /** Quantas vezes a entrega foi tentada. 1 = de primeira. */
  attempts: number
  /** Cutucadas: quantas vezes foi preciso lembrar o dev de continuar. */
  nudges: number
  /** Voltas para a fila depois de já ter saído dela. */
  requeueCount: number
  /** Tentativas de mesclar que falharam. */
  mergeFailures: number
  /** Quando a sessão nasceu e quando fechou — o tempo de ponta a ponta. */
  createdAt: Date
  closedAt: Date | null
}

export interface Distribuicao {
  /** O caso típico. */
  mediana: number
  /** A cauda: 90% ficam abaixo disto. */
  p90: number
  /** O pior caso observado. */
  maximo: number
}

export interface MedicaoDoCiclo {
  /** Quantas entregas entraram na conta. */
  entregas: number
  /**
   * Quantas saíram de primeira: uma tentativa, nenhuma cutucada, nenhuma
   * refila, nenhuma falha de mescla. É o número que responde "com que
   * frequência dá certo sem ninguém empurrar".
   */
  dePrimeira: number
  /** Cutucadas por entrega. */
  cutucadas: Distribuicao
  /** Tentativas por entrega. */
  tentativas: Distribuicao
  /** Falhas ao mesclar, por entrega. */
  falhasDeMerge: Distribuicao
  /** Horas entre nascer e fechar, só das que fecharam. Nulo se nenhuma fechou. */
  horasAteFechar: Distribuicao | null
  /**
   * O que este produto NÃO consegue medir hoje, escrito. A tela mostra como
   * travessão — e dizer por quê é o que impede alguém de achar que é zero.
   */
  naoMedido: string[]
}

/**
 * Percentil pelo método do vizinho mais próximo, com a lista já ordenada.
 *
 * Sem interpolação de propósito: estes números são contagens inteiras
 * (cutucadas, tentativas), e um p90 de "3,4 cutucadas" não quer dizer nada
 * para quem lê. O valor devolvido é sempre um que aconteceu de verdade.
 */
export function percentil(ordenada: readonly number[], p: number): number {
  if (ordenada.length === 0) return 0
  const i = Math.ceil((p / 100) * ordenada.length) - 1
  return ordenada[Math.min(Math.max(i, 0), ordenada.length - 1)]!
}

/** Mediana, p90 e máximo de uma lista. */
export function distribuir(valores: readonly number[]): Distribuicao {
  const ordenada = [...valores].sort((a, b) => a - b)
  return {
    mediana: percentil(ordenada, 50),
    p90: percentil(ordenada, 90),
    maximo: ordenada.length > 0 ? ordenada[ordenada.length - 1]! : 0,
  }
}

/** Saiu de primeira: uma tentativa e nenhum empurrão de ninguém. */
export function saiuDePrimeira(f: FatosDoCiclo): boolean {
  return f.attempts <= 1 && f.nudges === 0 && f.requeueCount === 0 && f.mergeFailures === 0
}

/**
 * O que este produto ainda não consegue medir, e por quê.
 *
 * Fica como lista para a tela mostrar travessão COM o motivo. Um "—" sem
 * explicação é indistinguível de zero para quem está lendo.
 */
export const NAO_MEDIDO: readonly string[] = [
  'quantas entregas o QA reprovou — o registro do julgamento não guarda o veredito, só que passou pelo portão',
  'quanto tempo cada volta consumiu de cada motor — a cota por missão ainda não é gravada',
]

/**
 * Mede o ciclo a partir das entregas.
 *
 * Lista vazia devolve uma medição de zeros com `entregas: 0` — e não nulo:
 * "ainda não houve entrega" é uma resposta, e a tela sabe dizê-la. O que não é
 * resposta é inventar uma distribuição a partir de nada.
 */
export function medirCiclo(fatos: readonly FatosDoCiclo[]): MedicaoDoCiclo {
  const fechadas = fatos.filter((f) => f.closedAt !== null)
  const horas = fechadas.map((f) => (f.closedAt!.getTime() - f.createdAt.getTime()) / 3_600_000)

  return {
    entregas: fatos.length,
    dePrimeira: fatos.filter(saiuDePrimeira).length,
    cutucadas: distribuir(fatos.map((f) => f.nudges)),
    tentativas: distribuir(fatos.map((f) => f.attempts)),
    falhasDeMerge: distribuir(fatos.map((f) => f.mergeFailures)),
    // Só das que FECHARAM: incluir as abertas mediria "o tempo até agora", que
    // encolhe a conta e melhora o número sozinho com o passar do relógio.
    horasAteFechar: horas.length > 0 ? distribuir(horas.map((h) => Math.round(h * 10) / 10)) : null,
    naoMedido: [...NAO_MEDIDO],
  }
}
