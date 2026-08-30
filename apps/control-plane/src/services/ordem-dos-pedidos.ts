import { exigirPermissao, type NivelDeAutonomia } from '@gitorch/cadence'

// O cliente ajusta a ordem dos pedidos NO PAINEL, e o quadro dele no GitHub
// acompanha.
//
// Decisão do dono (5.1): "o cliente só vai acessar o nosso painel, ajusta pelo
// painel e isso ajusta automaticamente nas outras plataformas".
//
// Este é o bloco que ESCREVE, e veio por último de propósito: até aqui o painel
// só lia. Escrever no repositório do cliente é a parte que não se faz por
// engano — por isso passa pela guarda de autonomia antes de qualquer coisa, e
// por isso cada escrita fica registrada.
//
// IDEMPOTÊNCIA MEDIDA, não presumida (30/08, no quadro do dono com 118 itens):
// mandar a mesma ordem duas vezes deixou 118 itens nas duas. A mutation do
// GitHub MOVE, nunca insere.

/** Quem sabe mexer no quadro. Só o que este serviço precisa. */
export interface QuadroQueAceitaOrdem {
  moverItemDoQuadro(input: { projectId: string; itemId: string; depoisDe?: string }): Promise<void>
}

export interface PedidoNaOrdem {
  /** O número da issue — o que o dono reconhece. */
  pedido: number
  /** O id do item DENTRO do quadro (não o da issue). */
  itemId: string
}

export interface RegistroDeEscrita {
  /** O que foi feito, em português, para o cliente ler. */
  oQueFiz: string
  /** Quando. */
  quando: string
  /** Os pedidos na ordem que ficou. */
  ordem: number[]
}

export interface DepsDaOrdem {
  quadro: QuadroQueAceitaOrdem
  /** Nível do projeto, lido na hora. */
  nivel: () => NivelDeAutonomia | null | undefined | string
  /** Registra o que foi escrito, para o cliente poder ver depois. */
  registrar: (r: RegistroDeEscrita) => Promise<void>
  agora?: () => Date
}

/**
 * Põe os pedidos na ordem que o cliente pediu.
 *
 * A guarda vem PRIMEIRO, antes de qualquer chamada: recusar depois de já ter
 * movido três itens deixaria o quadro dele meio arrumado, que é pior que não
 * ter mexido.
 *
 * A ordem é aplicada de trás para frente. Movendo o último primeiro, cada
 * `moverItemDoQuadro` usa como âncora um item que JÁ está no lugar certo —
 * fazendo do começo para o fim, cada movimento embaralharia os que ainda não
 * foram tratados.
 */
export async function aplicarOrdemDosPedidos(
  deps: DepsDaOrdem,
  args: { projectId: string; pedidos: readonly PedidoNaOrdem[] }
): Promise<RegistroDeEscrita> {
  // Reordenar o quadro é organizar, não propor nem mesclar. Lança
  // `EscritaNaoAutorizadaError` quando o cliente não autorizou — e lança ANTES
  // de mover qualquer coisa.
  exigirPermissao(deps.nivel(), 'organizar')

  if (args.pedidos.length === 0) {
    throw new Error('ORDEM_VAZIA: não há pedido nenhum para ordenar.')
  }

  // De trás para frente: o penúltimo vai para depois do último, e assim por
  // diante, até o primeiro ir para o topo.
  for (let i = args.pedidos.length - 1; i >= 0; i--) {
    const atual = args.pedidos[i]!
    const anterior = i > 0 ? args.pedidos[i - 1] : undefined
    await deps.quadro.moverItemDoQuadro({
      projectId: args.projectId,
      itemId: atual.itemId,
      // Sem `depoisDe`, vai para o topo — que é onde o primeiro deve ficar.
      ...(anterior ? { depoisDe: anterior.itemId } : {}),
    })
  }

  const ordem = args.pedidos.map((p) => p.pedido)
  const registro: RegistroDeEscrita = {
    oQueFiz: `Reordenei ${ordem.length} pedido(s) no seu quadro: ${ordem.map((n) => `#${n}`).join(', ')}.`,
    quando: (deps.agora ?? (() => new Date()))().toISOString(),
    ordem,
  }

  // O registro vem DEPOIS de a escrita acontecer. Registrar antes e falhar no
  // meio diria ao cliente que o produto fez algo que não fez.
  await deps.registrar(registro)

  return registro
}
