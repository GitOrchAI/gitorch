import { buildFreeTextOption } from './telegram-bot.js'

/**
 * D76b (T10) — a mensagem que o PO manda ao dono quando a equipe topa com um
 * desejo de prioridade baixa enquanto o(s) pedido(s) de prioridade mais alta
 * dele ainda têm fila pela frente. Modelo EXATO ditado pelo dono:
 *
 *   "Fulano, a equipe está com o desejo X onde você deixou prioridade 3;
 *    é 1 épico com 1 feature, pouco esforço; o seu pedido Y (P0) tem
 *    10 fases, 15 épicos, ~200 tarefas, 10 sprints; posso colocar X na
 *    próxima sprint?"
 *
 * "Regra da amostra" (CLAUDE.md, Guilherme+Comunicação): 1 exemplo dele é
 * amostra de uma regra geral, nunca uma lista completa — expandir para
 * N desejos (1, 2, 3...) e para os campos que podem faltar (prioridade,
 * sprints) é obrigação de quem implementa, não do dono repetir caso a caso.
 * Duas generalizações deliberadas em cima do exemplo literal:
 *
 *   1. O exemplo dele omite "fases"/"tarefas" do desejo X (ambos são 0) e
 *      "features" do pedido Y — cita só o que "importa" a olho. Uma função
 *      pura não tem como decidir sozinha o que "importa" sem arriscar
 *      esconder um dado real; por isso o texto aqui sempre cita as 4
 *      contagens (fases/épicos/features/tarefas) de cada desejo, mesmo
 *      quando alguma é 0 — nunca seleciona o que mostrar.
 *   2. O exemplo tem exatamente 2 desejos (o de baixa prioridade sendo
 *      proposto, e o P0 do dono como contraste). A generalização cobre
 *      1..N: o primeiro desejo sempre abre a frase ("a equipe está com o
 *      desejo X..."); cada desejo seguinte entra como "o seu pedido Y
 *      (...) tem ..." — a mesma forma do exemplo, repetida para cada um.
 */

/** Um desejo, do jeito que a mensagem de stakeholder precisa: nome +
 *  prioridade + tamanho real (contado na árvore de issues) + sprints. */
export interface DesejoParaMensagemDeStakeholder {
  /** O NOME do desejo — a mensagem cita PELO NOME (D76b), nunca só o número
   *  interno da issue: quem lê é o dono, não alguém abrindo o GitHub. */
  titulo: string
  /**
   * A prioridade que o dono deu a este desejo. `null` = não há essa fonte
   * ainda (ver `coletor-de-desejo-para-stakeholder.ts` — hoje NENHUM lugar
   * do produto persiste isso) — o texto diz "prioridade não registrada",
   * NUNCA inventa um número.
   */
  prioridade: number | null
  /** Quantas fases o desejo tem, CONTADAS na árvore real de issues. */
  fases: number
  /** Quantos épicos, CONTADOS (soma de todas as fases). */
  epicos: number
  /** Quantas features, CONTADAS (soma de todos os épicos). */
  features: number
  /** Quantas tarefas, CONTADAS (soma de todas as features). */
  tarefas: number
  /** Sprints estimadas para este desejo. `null` = não estimado — o texto diz
   *  "sprints não estimadas", NUNCA inventa um número. */
  sprintsEstimadas: number | null
}

export interface MontarMensagemDeStakeholderArgs {
  /** Nome do dono, para abrir a frase ("Guilherme, a equipe..."). Vazio
   *  (`''`) quando quem chama não tem o nome à mão — a frase abre sem
   *  saudação, nunca com um nome inventado. */
  dono: string
  /** 1 ou mais desejos — o primeiro abre a frase, os demais entram como
   *  "o seu pedido ...". Lista vazia lança (não existe mensagem sem desejo
   *  nenhum para citar). */
  desejos: DesejoParaMensagemDeStakeholder[]
  /** A pergunta de negócio de fato ("Posso colocar X na próxima sprint?").
   *  Texto livre — quem chama decide a proposta, esta função só a encaixa
   *  no lugar certo da frase. */
  proposta: string
}

export interface OpcaoDeMensagemDeStakeholder {
  label: string
  value: string
}

export const VALOR_SIM_PRIORIZAR = 'sim-priorizar'
export const VALOR_MANTER_PRIORIDADE_ATUAL = 'manter-prioridade-atual'
export const VALOR_QUERO_MAIS_DETALHES = 'quero-mais-detalhes'

/** D71/D72: 3 opções objetivas + "Vou escrever" — mesmo padrão de
 *  `OPCOES_DE_DECISAO_DE_AUTOMACAO` (decisao-de-automacao.ts) e
 *  `OPCOES_DE_CUSTO_DA_ORDEM` (aviso-de-custo-da-ordem.ts): o botão de
 *  escrever usa o SENTINEL de `buildFreeTextOption`, nunca um valor literal
 *  — é o que arma o "digite sua resposta" de verdade em vez de gravar a
 *  string "escrever" como se fosse a decisão do dono. */
export const OPCOES_DE_MENSAGEM_DE_STAKEHOLDER: OpcaoDeMensagemDeStakeholder[] = [
  { label: 'Sim, priorizar o desejo agora', value: VALOR_SIM_PRIORIZAR },
  { label: 'Não, manter a prioridade atual', value: VALOR_MANTER_PRIORIDADE_ATUAL },
  { label: 'Quero ver mais detalhes antes', value: VALOR_QUERO_MAIS_DETALHES },
  buildFreeTextOption('Vou escrever'),
]

function pluralizar(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

function textoDePrioridade(prioridade: number | null): string {
  return prioridade === null ? 'prioridade não registrada' : `prioridade ${prioridade}`
}

function textoDeSprints(sprintsEstimadas: number | null): string {
  if (sprintsEstimadas === null) return 'sprints não estimadas'
  return pluralizar(sprintsEstimadas, 'sprint estimada', 'sprints estimadas')
}

/** "10 fases, 15 épicos, 40 features e 200 tarefas, 10 sprints estimadas" —
 *  as 4 contagens SEMPRE aparecem, mesmo quando alguma é 0 (ver o comentário
 *  do topo do arquivo: uma função pura não decide sozinha o que "importa"
 *  esconder). */
function textoDeTamanho(desejo: DesejoParaMensagemDeStakeholder): string {
  const fases = pluralizar(desejo.fases, 'fase', 'fases')
  const epicos = pluralizar(desejo.epicos, 'épico', 'épicos')
  const features = pluralizar(desejo.features, 'feature', 'features')
  const tarefas = pluralizar(desejo.tarefas, 'tarefa', 'tarefas')
  return `${fases}, ${epicos}, ${features} e ${tarefas}, ${textoDeSprints(desejo.sprintsEstimadas)}`
}

/**
 * Monta o texto da mensagem de stakeholder (D76b), no formato exato ditado
 * pelo dono, generalizado para 1..N desejos (ver os comentários do topo do
 * arquivo). NUNCA inventa prioridade/sprints ausentes — usa a frase em
 * português no lugar do número (ver `textoDePrioridade`/`textoDeSprints`).
 *
 * Função PURA: não busca nada, não formata data, só combina o que já foi
 * decidido/contado em outro lugar (`coletor-de-desejo-para-stakeholder.ts`
 * para o tamanho real; quem monta `desejos` decide prioridade/sprints).
 */
export function montarMensagemDeStakeholder(args: MontarMensagemDeStakeholderArgs): string {
  if (args.desejos.length === 0) {
    throw new Error(
      'montarMensagemDeStakeholder: precisa de ao menos 1 desejo para montar a mensagem'
    )
  }

  const [primeiro, ...outros] = args.desejos as [
    DesejoParaMensagemDeStakeholder,
    ...DesejoParaMensagemDeStakeholder[],
  ]

  const saudacao = args.dono ? `${args.dono}, a` : 'A'
  const frases: string[] = [
    `${saudacao} equipe está com o desejo ${primeiro.titulo} onde você deixou ` +
      `${textoDePrioridade(primeiro.prioridade)}; é ${textoDeTamanho(primeiro)}`,
  ]
  for (const outro of outros) {
    frases.push(
      `o seu pedido ${outro.titulo} (${textoDePrioridade(outro.prioridade)}) tem ${textoDeTamanho(outro)}`
    )
  }
  frases.push(args.proposta)

  const corpo = frases.join('; ')
  const opcoes = OPCOES_DE_MENSAGEM_DE_STAKEHOLDER.map(
    (opcao, indice) => `${indice + 1}. ${opcao.label}`
  )

  return [corpo, '', ...opcoes].join('\n')
}
