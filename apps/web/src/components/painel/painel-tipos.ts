// Tipos dos payloads das rotas do painel do owner.
//
// Os shapes vêm verbatim de `ui_kits/painel-owner/API.md` do handoff
// (GitOrch Design System). Rotas que já existem no control-plane e rotas
// que faltam (leva 2) estão anotadas em cada bloco.

// --- /api/v1/painel/ritmo (API.md §2.1) — FALTA (leva 2) -----------------

export interface RitmoPorDia {
  data: string
  entregas: number
}

export interface RitmoPayload {
  periodo: { inicio: string; fim: string; rotulo: string }
  entregue: number
  /** null quando não há meta configurada (`meta_definida: false`). Nunca chutar. */
  meta: number | null
  por_dia: RitmoPorDia[]
  hoje: string
  dias_uteis_restantes: number
  no_ritmo: boolean
  meta_definida: boolean
}

// --- /api/v1/painel/pulso (API.md §2.2) — NOVA nesta leva ----------------

export interface PulsoPayload {
  /** ISO do evento/missão mais recente; null quando não há nenhum sinal. */
  ultimo_sinal_em: string | null
  ha_segundos: number | null
  /** frase em PT-BR sem jargão; null quando não há sinal. */
  descricao: string | null
  quente: boolean
  limite_frio_segundos: number
}

// --- /api/v1/painel/agentes (API.md §2.3) — NOVA nesta leva --------------

export type EstadoAgente = 'trabalhando' | 'esperando_voce' | 'bloqueado' | 'ocioso'

export interface AgenteAtuando {
  id: string
  nome: string
  papel: string
  estado: EstadoAgente
  descricao: string
  projeto: string | null
  desde: string | null
  /** só quando há progresso real e medido; null → o painel não desenha barra. */
  progresso: number | null
}

export interface MotorCota {
  id: string
  nome: string
  usado: number
  /** null quando o motor não reporta teto (`limite_conhecido: false`). */
  limite: number | null
  janela: string
  limite_conhecido: boolean
}

export interface AgentesPayload {
  atuando: AgenteAtuando[]
  motores: MotorCota[]
}

// --- /api/v1/painel/entregas (API.md §2.5) — FALTA (leva 2) --------------

export interface EntregaItem {
  titulo: string
  /** o ganho que a entrega trouxe; ausente quando ninguém o escreveu. */
  ganho?: string
  projeto: string
  quando: string
  responsavel: string
  /** todo o jargão vive aqui e em nenhum outro campo. */
  tecnico: string
}

export interface EntregasGrupo {
  rotulo: string
  total: number
  itens: EntregaItem[]
}

export interface EntregasPayload {
  grupos: EntregasGrupo[]
}

// --- /api/v1/painel/historico (API.md §2.6) — FALTA (leva 2) ------------

export interface HistoricoEvento {
  quando: string
  quem: string
  o_que: string
  evidencia: string
  tecnico: string
}

export interface HistoricoPayload {
  eventos: HistoricoEvento[]
  pagina: number
  total: number
}

// --- POST /api/v1/painel/decisoes/:id/responder (API.md §2.4) — NOVA -----

export interface DecisaoRespostaOk {
  id: string
  status: 'answered'
  answer: string
  answeredAt: string
  /** o serviço grava a string 'panel' (schema comenta `telegram | panel`);
   *  a view rotula em PT-BR, nunca usa este campo para lógica. */
  answeredVia: 'panel'
}
