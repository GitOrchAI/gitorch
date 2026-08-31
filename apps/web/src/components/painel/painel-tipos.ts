// Tipos dos payloads das rotas do painel do owner.
//
// SÓ ROTA QUE EXISTE, E SÓ CONTRATO QUE ALGUÉM USA. Este arquivo carregava
// nove tipos que ninguém importava, três deles descrevendo rotas anotadas como
// "FALTA (leva 2)". O pior era o de `/painel/entregas`: a rota EXISTE e
// responde `{ entregas, prontas, andando, total, ... }`, enquanto o tipo aqui
// declarava `{ grupos: [...] }` — um contrato que nunca foi verdade, parado ao
// lado da tela, parecendo a fonte da verdade. Contrato declarado que ninguém
// usa é exatamente como a tela e a rota se separam sem ninguém ver: o tipo
// envelhece calado porque nada o compila contra o real.
//
// A regra, daqui para a frente: um tipo entra aqui quando a rota existe E uma
// tela o importa. Rota nova nasce com o contrato escrito contra a resposta
// real, não contra o desenho.

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

/** Estado do motor do ponto de vista de quem vai usá-lo agora. */
export type EstadoDoMotor = 'ligado' | 'precisa_religar' | 'nao_conectado'

export interface MotorCota {
  /** runtime, como o banco guarda: claude | codex | antigravity | github. */
  id: string
  nome: string
  estado: EstadoDoMotor
  /** % JÁ USADO da janela de sessão. `null` = não sei (nunca zero). */
  sessao: number | null
  /** % JÁ USADO da janela da semana. `null` = não sei. */
  semana: number | null
  /** quando a cota foi lida, ISO. `null` = nunca foi lida. */
  lidoEm: string | null
  precisaReligar: boolean
}

export interface AgentesPayload {
  atuando: AgenteAtuando[]
  motores: MotorCota[]
  /**
   * `false` = o produto NÃO conseguiu ler a cota. Sem isto, "falhei ao ler" e
   * "você não tem motor" davam a mesma tela vazia, e a falha virava silêncio.
   */
  cotaLida: boolean
  /** por que não deu, em linguagem de negócio. `null` quando leu. */
  motivoDaCota: string | null
}
