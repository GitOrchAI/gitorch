// Fase 2.5: um pedido feito FORA do GitOrch (você com um assistente, ou
// outra pessoa) carrega uma decisão de rumo que o time não tomou sozinho.
// Guarda essa direção na memória do projeto para a PRÓXIMA missão do PO e do
// analista entender o contexto sem repetir a pergunta.
//
// Três cuidados que fazem desta gravação algo que pode rodar a cada
// julgamento do QA:
//
//  - a gaveta vai para uma sala PRÓPRIA (mission-context.ts: SALA_DA_DIRECAO).
//    A sala `ra` é onde mora o contrato de jornadas que o PO lê, e a `qa` é o
//    que ele lê como lacuna de backlog: uma nota em qualquer das duas tomaria o
//    lugar do contrato ou viraria tarefa falsa;
//  - é idempotente: UMA gaveta por pull request, com id determinístico, então
//    rejulgar o mesmo PR atualiza a gaveta em vez de somar outra;
//  - só aprende de origem que o projeto não mandou ignorar (`cuidaPorOrigem`
//    `nao`). "Perguntar" aprende: ler o pedido não é agir sobre ele.

import { estaCompleto } from './entendimento-do-pedido.js'
import type { EntendimentoDoItem } from './ficha-do-item.js'
import { lerCuidaPorOrigem } from './cuidado-por-origem.js'
import { baldeDeCuidado } from './motor-do-proximo-passo.js'
import { cortarPorPontoDeCodigo } from './texto-seguro.js'
import {
  PREFIXO_DA_GAVETA_DE_DIRECAO,
  SALA_DA_DIRECAO,
  type MissionMemory,
} from './mission-context.js'

/** Só pedido de FORA do GitOrch carrega direção nova — Jules pelo GitOrch e
 *  Dependabot são o próprio produto/automação agindo, não uma decisão de
 *  rumo externa. */
const ORIGENS_DE_FORA: ReadonlySet<string> = new Set(['assistente', 'pessoa', 'jules_fora'])

/** Importância baixa de propósito: é contexto de consulta, não conhecimento de primeira linha. */
const IMPORTANCIA_DA_GAVETA = 0.3

/** O texto vem de um pull request de terceiro: cabe numa linha e tem teto. */
const MAX_CHARS_POR_CAMPO = 400

function numaLinha(texto: string): string {
  const limpo = texto
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  return cortarPorPontoDeCodigo(limpo, MAX_CHARS_POR_CAMPO, { sufixo: '…', aparar: true })
}

export async function registrarDirecaoDoProjeto(args: {
  projectId: string
  numeroDoPr: number
  /** A origem LIDA DA FICHA do PR (nunca do que o juiz escreveu). `null` = ficha sem origem. */
  origem: string | null | undefined
  entendimento: EntendimentoDoItem
  /** `Project.runtimeConfig`: de onde vem `cuidaPorOrigem`. */
  runtimeConfig: unknown
  deps: { cortex: MissionMemory; now: () => string }
}): Promise<void> {
  const origem = args.origem
  if (!origem || !ORIGENS_DE_FORA.has(origem)) return

  // Entendimento pela metade vira direção pela metade, e a direção entra no
  // planejamento do PO: melhor nenhuma que uma frase vazia.
  if (!estaCompleto(args.entendimento)) return

  const balde = baldeDeCuidado(origem)
  if (balde && lerCuidaPorOrigem(args.runtimeConfig, false)[balde] === 'nao') return

  const content =
    `${PREFIXO_DA_GAVETA_DE_DIRECAO} (origem: ${origem}), pull request #${args.numeroDoPr}: ` +
    `${numaLinha(args.entendimento.porQueExiste)}. ` +
    `Mudança: ${numaLinha(args.entendimento.oQueMuda)}.`

  // Id determinístico (projeto, PR): regravar o mesmo julgamento atualiza a
  // gaveta, e um entendimento novo do mesmo PR a substitui.
  const id = `direcao:${args.projectId}:${args.numeroDoPr}`
  if (args.deps.cortex.getDrawerById?.(id)?.content === content) return

  const agora = args.deps.now()
  await args.deps.cortex.writeDrawer({
    id,
    wingId: args.projectId,
    roomId: SALA_DA_DIRECAO,
    hallId: 'direcao',
    content,
    importance: IMPORTANCIA_DA_GAVETA,
    emotionalWeight: 0,
    createdAt: agora,
    validFrom: agora,
    confidence: 0.8,
    tags: ['direcao', 'fora-do-gitorch'],
  })
}
