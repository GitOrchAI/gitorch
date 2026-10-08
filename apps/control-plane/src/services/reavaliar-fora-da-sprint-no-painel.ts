// Fase 4.3: a tarefa que a conferência (4.1) viu FORA da sprint atual e que já
// tem peso e lugar na fila do quadro é reavaliada pela peça `reavaliarForaDaSprint`,
// e o resultado vai só para a linha do tempo do painel.
//
// Por decisão do dono, a sprint NÃO puxa backlog: só recebe o que já está em
// andamento (sprint-com-itens.ts). Por isso esta etapa não tem NENHUMA
// capacidade de escrita na sprint, no quadro ou no GitHub — as dependências
// abaixo são só "listar" e "registrar no painel". A peça nunca devolve
// "entra agora"; o texto dela é o que aparece para o dono.
//
// Roda dentro do passe do custo da ordem, com a fila que ele já leu: nenhuma
// chamada nova ao GitHub.

import type { PrismaClient } from '@prisma/client'
import { analisarCustoDaOrdem, type PedidoNaFila } from '@gitorch/cadence'
import { reavaliarForaDaSprint } from './reavaliar-fora-da-sprint.js'
import { registrarNoPainelSeForNovo } from './registro-no-painel.js'

/** Eventos NOVOS por passada: o primeiro ciclo de um quadro grande não inunda a linha do tempo. */
export const TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA = 10

export interface DepsDoForaDaSprint {
  /** `dono/repo`. */
  repo: string
  /** Tarefas que a conferência gravou com `naSprint = false`. */
  listarForaDaSprint: () => Promise<number[]>
  /** Devolve `true` quando gravou o evento e `false` quando ele já existia. */
  registrarNoPainel: (evento: { chave: string; texto: string }) => Promise<boolean>
}

export async function registrarTarefasForaDaSprint(
  deps: DepsDoForaDaSprint,
  fila: readonly PedidoNaFila[]
): Promise<{ registradas: number[] }> {
  const registradas: number[] = []
  const foraDaSprint = new Set(await deps.listarForaDaSprint())

  // Na ordem da fila: quem está mais perto de ser trabalhado é reportado primeiro.
  for (const [indice, pedido] of fila.entries()) {
    if (registradas.length >= TETO_DE_EVENTOS_FORA_DA_SPRINT_POR_PASSADA) break
    if (!foraDaSprint.has(pedido.pedido)) continue

    // A peça soma o pedido à fila que recebe; ele já está nela, então sai antes.
    const outros = fila.filter((p) => p.pedido !== pedido.pedido)
    const reavaliacao = reavaliarForaDaSprint({ pedido, fila: outros })

    // A chave segue a CATEGORIA do resultado (custo baixo, ou o candidato que
    // custa caro), não o texto: os números do texto mudam a cada pedido novo na
    // fila e reabririam o evento sem que nada de importante tenha mudado.
    const analise = analisarCustoDaOrdem([...outros, pedido])
    const categoria = analise.custaCaro ? `caro-${analise.candidato.pedido}` : 'barato'

    const gravou = await deps.registrarNoPainel({
      chave: `fora-da-sprint:${deps.repo}:${pedido.pedido}:${categoria}`,
      texto:
        `GitOrch: a tarefa #${pedido.pedido} de ${deps.repo} (peso ${pedido.peso}, posição ` +
        `${indice + 1} de ${fila.length} na fila) está fora da sprint atual — ${reavaliacao.motivo} ` +
        `(nada foi alterado na sprint nem no quadro).`,
    })
    if (gravou) registradas.push(pedido.pedido)
  }
  return { registradas }
}

/** O mesmo, ligado ao banco: o que o scheduler chama com a fila do passe do custo da ordem. */
export function registrarForaDaSprintComPrisma(args: {
  prisma: Pick<PrismaClient, 'repoItem' | 'event'>
  projectId: string
  repo: string
  fila: readonly PedidoNaFila[]
}): Promise<{ registradas: number[] }> {
  return registrarTarefasForaDaSprint(
    {
      repo: args.repo,
      listarForaDaSprint: async () => {
        const linhas = await args.prisma.repoItem.findMany({
          where: {
            projectId: args.projectId,
            tipo: 'issue',
            conferencia: { path: ['naSprint'], equals: false },
          },
          select: { numero: true },
        })
        return linhas.map((l) => l.numero)
      },
      registrarNoPainel: (evento) =>
        registrarNoPainelSeForNovo({
          prisma: args.prisma,
          projectId: args.projectId,
          chave: evento.chave,
          texto: evento.texto,
        }),
    },
    args.fila
  )
}
