/**
 * O pedido de desejo que espera o dono dizer A QUAL PROJETO ele pertence.
 *
 * Quem tem mais de um projeto e escreve `/desejo trocar a cor do botão` não
 * disse onde. Antes o produto respondia com um texto pedindo que a pessoa
 * escrevesse tudo de novo com o endereço do repositório na frente; o dono
 * tentou três vezes e as três foram recusadas. A resposta agora é um BOTÃO por
 * projeto — e é o botão que obriga a guardar o pedido: entre a pergunta e o
 * toque passa tempo de gente, e o serviço reinicia várias vezes por dia.
 *
 * Este arquivo é a REGRA, sem banco e sem rede: o que o pendente pode virar, e
 * como o teclado se parece. Quem fala com o Postgres e com o Telegram é o
 * `telegram-bot.ts`.
 */

/** O prefixo que separa o clique de projeto do clique de dúvida do PO, que
 * viaja no mesmo `callback_query`. Sem isso um roteador leria o outro. */
export const PREFIXO_DO_BOTAO_DE_PROJETO = 'desejo'

/**
 * Prazo do pendente. Um dia é o tempo de alguém sair do chat, dormir e voltar
 * — e curto o bastante para que um toque distraído numa conversa antiga não
 * abra uma tarefa que ninguém mais quer.
 */
export const PRAZO_DO_PENDENTE_MS = 24 * 60 * 60 * 1000

/**
 * Teto de botões. Acima disso o teclado vira uma parede ilegível e o caminho
 * honesto é o texto antigo, que ao menos cabe na tela. Não é limite do
 * Telegram: é limite de gente.
 */
export const TETO_DE_BOTOES = 12

export interface PendenteGuardado {
  id: string
  userId: string
  chatId: string
  texto: string
  usadoEm: Date | null
  createdAt: Date
}

export type DecisaoSobrePendente =
  { acao: 'usar'; texto: string } | { acao: 'sumiu' } | { acao: 'ja-usado' } | { acao: 'vencido' }

/**
 * O que fazer com o pendente no instante do clique.
 *
 * As três recusas são FATOS DIFERENTES e cada uma merece o seu próprio recado:
 * "sumiu" é banco limpo ou id forjado; "já usado" é o Telegram reentregando o
 * mesmo clique (acontece, e abrir a segunda issue seria o erro); "vencido" é
 * toque numa conversa velha. Colapsar os três num "não deu" faria a pessoa
 * tentar de novo exatamente onde não adianta.
 */
export function decidirSobrePendente(
  pendente: PendenteGuardado | null | undefined,
  agora: Date,
  prazoMs: number = PRAZO_DO_PENDENTE_MS
): DecisaoSobrePendente {
  if (!pendente) return { acao: 'sumiu' }
  if (pendente.usadoEm) return { acao: 'ja-usado' }

  const nascimento = pendente.createdAt.getTime()
  // Data ilegível não é data velha. Sem isto, um registro com carimbo estranho
  // seria descartado como vencido e o pedido do dono sumiria em silêncio.
  if (!Number.isFinite(nascimento)) return { acao: 'usar', texto: pendente.texto }

  if (agora.getTime() - nascimento > prazoMs) return { acao: 'vencido' }
  return { acao: 'usar', texto: pendente.texto }
}

export interface ProjetoDoBotao {
  /** O que a pessoa lê no botão. */
  rotulo: string
  /** O endereço real do repositório — a resposta que o clique carrega. */
  repo: string
}

export interface TecladoDeProjetos {
  inline_keyboard: { text: string; callback_data: string }[][]
}

/**
 * O teclado com um projeto por linha. Um por linha porque `dono/repositorio`
 * é longo: lado a lado o Telegram corta o nome e dois projetos parecidos ficam
 * indistinguíveis — exatamente o erro que o botão existe para evitar.
 *
 * O botão carrega o ÍNDICE, nunca o endereço: `callback_data` tem teto de 64
 * bytes e `dono/repositorio-com-nome-comprido` estoura. O índice é resolvido
 * contra a lista RECALCULADA no clique, então um projeto que saiu do ar no meio
 * do caminho não vira destino válido.
 */
export function montarTecladoDeProjetos(
  projetos: ProjetoDoBotao[],
  pendenteId: string
): TecladoDeProjetos {
  return {
    inline_keyboard: projetos
      .slice(0, TETO_DE_BOTOES)
      .map((p, i) => [
        { text: p.rotulo, callback_data: `${PREFIXO_DO_BOTAO_DE_PROJETO}:${pendenteId}:${i}` },
      ]),
  }
}

export interface CliqueDeProjeto {
  pendenteId: string
  indice: number
}

/**
 * Lê o clique. Devolve `null` para qualquer coisa que não seja nossa — o mesmo
 * `callback_query` também traz as respostas de dúvida do PO, e roubar o clique
 * alheio deixaria o dono sem resposta nos dois lados.
 */
export function lerCliqueDeProjeto(data: string | undefined | null): CliqueDeProjeto | null {
  if (!data) return null
  const partes = data.split(':')
  if (partes.length !== 3) return null
  if (partes[0] !== PREFIXO_DO_BOTAO_DE_PROJETO) return null

  const pendenteId = partes[1]
  if (!pendenteId) return null

  // Só dígitos: `Number('1e3')` daria 1000 e `Number(' 2')` daria 2. Índice
  // vem de botão nosso e é sempre um inteiro escrito por extenso.
  const cru = partes[2]
  if (!cru || !/^\d+$/.test(cru)) return null
  const indice = Number(cru)
  if (!Number.isSafeInteger(indice)) return null

  return { pendenteId, indice }
}
