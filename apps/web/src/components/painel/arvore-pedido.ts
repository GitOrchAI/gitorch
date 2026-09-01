// A árvore de UM pedido — fase→épico→feature→task — pendurada embaixo da
// linha dele em TelaPedidos. Lógica fora do React (o app web testa lógica em
// .ts), a mesma separação de cascata.ts e painel-numeros.ts.
//
// O CONTRATO: GET /api/v1/painel/pedidos/arvore devolve os nós que a consulta
// conseguiu trazer (`NoDaArvore`, painel-tipos.ts) — a árvore inteira de UM
// pedido, já com os quatro níveis. O que este módulo decide é só DESENHO:
// quais níveis o dono já abriu, e o que cada linha mostra.
//
// A ARMADILHA JÁ PAGA CARA NESTE PAINEL (25 linhas desenhadas com 17 chaves,
// 8 colisões — mesma família de bug em cascata.ts): uma chave de linha
// baseada só no número da issue coincide entre ramos diferentes assim que
// dois nós de fases diferentes acontecerem de repetir número. Por isso a
// chave AQUI é o CAMINHO completo desde a raiz do pedido, nunca o número
// sozinho — estruturalmente impossível de colidir, mesmo que o mesmo número
// apareça em dois ramos (ver o teste "CHAVE ÚNICA").
import type { NoDaArvore } from './painel-tipos'

/** Os quatro níveis, na ordem que o dono desenhou (fase→épico→feature→task). */
export const NIVEL: readonly string[] = ['Fase', 'Épico', 'Feature', 'Task']

export interface LinhaDaArvore {
  /** Identidade da LINHA (o caminho completo desde a raiz), não do conteúdo. */
  chave: string
  /** 0=fase 1=épico 2=feature 3=task. */
  nivel: number
  no: NoDaArvore
  temFilhos: boolean
  /** Quantos filhos o GitHub reporta que a consulta NÃO trouxe — o teto da
   *  consulta, dito, nunca escondido. 0 quando a lista veio inteira. */
  naoCarregados: number
}

/**
 * A chave-raiz de UM pedido — o prefixo de toda chave de nó dele.
 *
 * Recebe o identificador COMPLETO que o chamador já usa para distinguir
 * pedidos entre si (`${projeto}#${numero}` em TelaPedidos, nunca só o
 * número): a tela de "todos os projetos" pendura mais de uma árvore na MESMA
 * tabela, e dois projetos diferentes podem ter um pedido #30 cada um. Um
 * prefixo que misturasse os dois faria as duas árvores colidirem de chave
 * assim que os números dos nós também coincidissem — a MESMA família do bug
 * que já desenhou 25 linhas com 17 chaves aqui.
 */
export function chaveRaizDoPedido(id: string | number): string {
  return `p${id}`
}

/**
 * Achata a árvore em linhas visíveis, respeitando quais nós o dono abriu.
 *
 * `raiz` identifica o pedido dono desta árvore — passe algo que já seja único
 * entre TODOS os pedidos desenhados na tela (não só o número: dois projetos
 * podem repetir número de issue). `abertos` é o conjunto de CHAVES abertas —
 * cada uma o caminho completo até aquele nó. Com `abertos` vazio só as fases
 * aparecem: um pedido com dezenas de tasks não nasce com tudo desenhado.
 */
export function linhasVisiveis(
  raiz: string | number,
  nos: readonly NoDaArvore[],
  abertos: ReadonlySet<string>
): LinhaDaArvore[] {
  const linhas: LinhaDaArvore[] = []

  const visitar = (lista: readonly NoDaArvore[], nivel: number, prefixo: string): void => {
    for (const no of lista) {
      const chave = `${prefixo}>${no.numero}`
      const temFilhos = no.filhos.length > 0
      const naoCarregados = Math.max(0, no.partes.total - no.filhos.length)
      linhas.push({ chave, nivel, no, temFilhos, naoCarregados })
      if (temFilhos && abertos.has(chave)) visitar(no.filhos, nivel + 1, chave)
    }
  }

  visitar(nos, 0, chaveRaizDoPedido(raiz))
  return linhas
}

/** Alterna uma chave aberta/fechada — nunca muta o conjunto recebido (o
 *  React precisa de uma identidade nova para re-renderizar). */
export function alternar(abertos: ReadonlySet<string>, chave: string): Set<string> {
  const novo = new Set(abertos)
  if (novo.has(chave)) novo.delete(chave)
  else novo.add(chave)
  return novo
}

/**
 * A frase de andamento de um nó — `null` quando não há nada de verdade para
 * dizer.
 *
 * Fechado sempre fala, mesmo sem partes (mesma regra do pedido: fechar é um
 * fato da issue, não uma medida de progresso). Sem partes E sem estar
 * fechado, este módulo NÃO inventa "0%" nem "ainda sem itens": uma task é
 * normalmente uma folha (0 de 0 é o estado esperado, não um alarme), e dizer
 * algo aqui seria supor um significado que o dado não carrega.
 */
export function andamentoDoNo(no: Pick<NoDaArvore, 'situacao' | 'partes'>): string | null {
  if (no.situacao === 'fechado') return 'fechado no GitHub'
  if (no.partes.total === 0) return null
  return `${no.partes.concluidas} de ${no.partes.total} prontos`
}
