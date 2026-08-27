// Navegação do painel do owner, fora do React (a estrutura é dado, não
// desenho — testável). Portado de ui_kits/painel-owner/app.jsx.
//
// O bundle chamava a tela de repositórios de 'repositorios'; aqui ela é
// 'projetos', alinhado ao rótulo "Projetos" e à rota /api/projects.

export type TelaId =
  | 'visao'
  | 'pedidos'
  | 'decisoes'
  | 'entregas'
  | 'custos'
  | 'projetos'
  | 'regras'
  | 'historico'
  | 'config'

export interface ItemNav {
  id: TelaId
  /** rótulo visível */
  l: string
  /** nome do ícone (ver PainelIcons) */
  i: string
  /** mostra o contador de decisões pendentes */
  badge?: boolean
}

export interface GrupoNav {
  g: string
  itens: ItemNav[]
}

export const NAV: GrupoNav[] = [
  {
    g: 'Operação',
    itens: [
      { id: 'visao', l: 'Visão geral', i: 'home' },
      { id: 'pedidos', l: 'Pedidos', i: 'spark' },
      { id: 'decisoes', l: 'Decisões', i: 'inbox', badge: true },
      { id: 'entregas', l: 'Entregas', i: 'ship' },
    ],
  },
  {
    g: 'Recursos',
    itens: [
      { id: 'custos', l: 'Custos e limites', i: 'wallet' },
      { id: 'projetos', l: 'Projetos', i: 'repo' },
    ],
  },
  {
    g: 'Conta',
    itens: [
      { id: 'regras', l: 'Regras', i: 'shield' },
      { id: 'historico', l: 'Histórico', i: 'scroll' },
      { id: 'config', l: 'Configurações', i: 'cog' },
    ],
  },
]

export const PLANO: ItemNav[] = NAV.flatMap((s) => s.itens)

export const TITULOS: Record<TelaId, string> = Object.fromEntries(
  PLANO.map((i) => [i.id, i.l])
) as Record<TelaId, string>

/** Mobile: "só olhar e decidir" — quatro destinos, o resto sob "Mais". */
export const TABS = ['visao', 'decisoes', 'pedidos', 'mais'] as const
export type TabId = (typeof TABS)[number]

export const TAB_META: Record<TabId, { l: string; i: string }> = {
  visao: { l: 'Visão', i: 'home' },
  decisoes: { l: 'Decisões', i: 'inbox' },
  pedidos: { l: 'Pedidos', i: 'spark' },
  mais: { l: 'Mais', i: 'dots' },
}

const DESTINOS_FIXOS: TelaId[] = ['visao', 'decisoes', 'pedidos']

/** As telas que aparecem na folha "Mais" do celular (tudo menos os 3 fixos). */
export function telasDaFolha(): ItemNav[] {
  return PLANO.filter((i) => !DESTINOS_FIXOS.includes(i.id))
}

/** Título da tela; id desconhecido → "Visão geral" (nunca quebra o cabeçalho). */
export function tituloDaTela(id: string): string {
  return TITULOS[id as TelaId] ?? 'Visão geral'
}
