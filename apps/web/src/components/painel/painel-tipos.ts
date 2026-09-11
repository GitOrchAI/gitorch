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

// --- /api/v1/painel/pedidos/arvore (D2, leva 3) — NOVA nesta leva --------
//
// A árvore de UM pedido — fase→épico→feature→task —, pendurada embaixo da
// linha do pedido em TelaPedidos. Espelha `NoDaArvore` do control-plane
// (services/arvore-de-pedidos.ts): MESMO shape em todo nível, porque
// `addSubIssue` pendura cada um do mesmo jeito nativo do GitHub.

export interface NoDaArvore {
  numero: number
  situacao: 'andando' | 'fechado'
  titulo: string
  endereco: string
  /**
   * Quantos filhos diretos o GitHub reporta e quantos já fecharam. PODE ser
   * maior que `filhos.length`: a consulta tem um teto por nível, e um nó com
   * mais filhos do que o teto chega com `partes.total` maior — nunca finge
   * que trouxe a lista inteira.
   */
  partes: { total: number; concluidas: number }
  /** Os filhos que a consulta conseguiu trazer. Task (o último nível que a
   *  consulta desce) sempre chega com `filhos: []`. */
  filhos: NoDaArvore[]
}

export interface ArvorePayload {
  nos: NoDaArvore[]
}

// --- /api/v1/painel/dev-cota (DJ-T5) — existe -----------------------------
//
// Espelha ContaNoResumo/ResumoDeCota do control-plane
// (services/resumo-de-cota-do-dev.ts). Pedido do dono: "sabendo quantas
// tarefas diárias tem disponível baseado no plano... e quantas estão sendo
// usadas pra próximas tarefas ficarem na esteira".

export interface ContaDeCotaDoDev {
  /** Nulo = conta padrão da instância. */
  contaId: string | null
  /** Nomes (owner/repo) dos projetos que dividem esta conta. */
  projetos: string[]
  plano: string
  tetoConcorrentes: number
  tetoDiario: number
  /** Quantas sessões ocupam vaga simultânea AGORA. */
  simultaneas: number
  /** Sessões abertas nas últimas 24h — janela rolante, não dia de calendário. */
  enviadas24h: number
  /**
   * ISO 8601 de quando a próxima vaga diária libera. `null` quando há folga
   * agora (enviadas24h < tetoDiario) — não faz sentido prometer "próxima".
   */
  proximaVagaDiariaEm: string | null
  /** Tarefas prontas que o SM não delegou na última acordada, somadas entre os projetos da conta. */
  prontasEsperandoVaga: number
  /** 'sem_leitura' quando nenhum projeto da conta ainda teve uma acordada do SM lida. */
  leituraDoSm: 'ok' | 'sem_leitura'
}

export interface ResumoDeCotaDoDevPayload {
  agora: string
  contas: ContaDeCotaDoDev[]
}
