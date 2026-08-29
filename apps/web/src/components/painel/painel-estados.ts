// As três respostas honestas do painel, como lógica pura (a decisão de QUAL
// aparece mora aqui, testável; o componente PainelEstados só desenha). Regra
// mais forte do produto: valor que pode não existir vira travessão, nunca 0;
// e "ainda não sei" / "não consegui saber" / "não tem nada" são três frases
// diferentes. Portado de ui_kits/painel-owner/ad-estados.jsx + ad-api.jsx.

export type EstadoNome = 'carregando' | 'indisponivel' | 'vazio' | 'ok'

export type EstadoBusca<T> =
  | { estado: 'carregando'; dados: null }
  | { estado: 'indisponivel'; dados: null; erro: Error }
  | { estado: 'vazio'; dados: T }
  | { estado: 'ok'; dados: T }

/**
 * Decide entre `ok` e `vazio` para um resultado que JÁ chegou. `vazio` só
 * quando a regra explícita diz que está vazio de verdade — uma lista com 0
 * itens não é a mesma coisa que "não deu para carregar".
 */
export function classificar<T>(args: { bruto: T; vazio?: (d: T) => boolean }): {
  estado: 'vazio' | 'ok'
  dados: T
} {
  const estaVazio = args.vazio ? args.vazio(args.bruto) : false
  return { estado: estaVazio ? 'vazio' : 'ok', dados: args.bruto }
}

/** Qualquer falha vira `indisponivel` + um Error de verdade (normaliza `unknown`). */
export function erroPara(e: unknown): { estado: 'indisponivel'; dados: null; erro: Error } {
  const erro = e instanceof Error ? e : new Error(String(e))
  return { estado: 'indisponivel', dados: null, erro }
}

/** O selo "dado de exemplo" aparece exatamente quando a tela está em modo demo. */
export function deveMostrarSelo(usarDemo: boolean): boolean {
  return usarDemo
}

const FRASES: Record<EstadoNome, (o_que: string) => string> = {
  carregando: () => 'Carregando…',
  indisponivel: (o_que) => `Não deu para carregar ${o_que} agora.`,
  vazio: () => '', // a tela escreve a própria frase de vazio
  ok: () => '',
}

/** Frase de estado, verbatim do handoff. `o_que` descreve o dado ("o ritmo da semana"). */
export function frase(estado: EstadoNome, o_que: string): string {
  return FRASES[estado](o_que)
}
