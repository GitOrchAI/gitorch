/**
 * A tarefa fecha quando a entrega dela entra — não importa QUEM mesclou.
 *
 * DIAGNÓSTICO DO DONO, 27/08, e ele foi mais preciso que eu: "falta é o
 * gitorch saber todas issues do projeto e o que cada issue É e qual é linkado
 * a qual PR, pois já vi PRs merged com issue open".
 *
 * MEDIDO NO BANCO depois disso: dezesseis tarefas do gitorch e nove do
 * patinhas estavam ABERTAS com a entrega delas já mesclada — e o produto
 * SABIA, porque a linha da entrega tinha o commit do merge gravado. Algumas
 * foram redelegadas várias vezes por isso: a tarefa #128 chegou a ter CINCO
 * entregas, a #110 e a #210 três cada.
 *
 * POR QUE ACONTECIA: `fecharTarefaEntregue` só roda dentro da missão de QA,
 * logo depois de o produto mesclar com as próprias mãos. Quando o merge vinha
 * por outro caminho — o auto-merge do repositório, ou uma pessoa clicando —
 * ninguém fechava a tarefa. E tarefa aberta volta para a fila do gerente, que
 * a delega de novo, e a entrega nova nasce em conflito com a que já entrou.
 *
 * O conserto não é uma regra nova de fechamento: é a MESMA regra
 * (`decidirFechamento`, fechar-tarefa.ts) aplicada também fora do caminho em
 * que o produto foi o autor do merge. Este arquivo só decide QUEM merece ser
 * conferido, para a varredura não perguntar o estado de tarefa nenhuma à toa.
 */

export interface EntregaParaConferir {
  projectId: string
  issueNumber: number
  pullRequestNumber: number | null
  mergeCommitSha: string | null
  closedReason?: string | null | undefined
  /** Última escrita na linha da entrega — de onde sai a carência abaixo. */
  updatedAt: Date
}

/** A identidade de uma tarefa: o número só vale dentro do projeto dela. */
export function chaveDaTarefa(projectId: string, issueNumber: number): string {
  return `${projectId}#${issueNumber}`
}

/**
 * Quanto tempo a varredura espera antes de encostar numa entrega.
 *
 * O caminho normal (a missão de QA que acabou de mesclar) fecha a tarefa em
 * segundos. Se a varredura agisse junto, as DUAS comentariam e fechariam a
 * mesma tarefa — dois comentários idênticos no repositório do cliente, que é
 * exatamente o ruído que este produto evita em todo lugar. Um teste de costura
 * real pegou isso antes de ir para produção.
 *
 * Meia hora: muito além do que o caminho normal precisa, e muito aquém de
 * deixar a tarefa aberta tempo suficiente para o gerente redelegá-la.
 */
export const CARENCIA_ANTES_DE_VARRER_MS = 30 * 60_000

/**
 * Quantas tarefas a varredura consulta por passada. Cada consulta leva cerca
 * de 0,3 s; quarenta cabem com folga em meia dezena de segundos e a fila
 * andando em rodízio esgota o estoque em poucas passadas.
 */
export const TETO_DE_TAREFAS_POR_PASSADA = 40

/** Quanto tempo uma tarefa que não deu para ler descansa antes de nova tentativa. */
export const ESPERA_APOS_FALHA_MS = 6 * 60 * 60_000

/**
 * As entregas que valem uma consulta ao GitHub.
 *
 * Sem commit de merge não há o que fechar. Sem número de tarefa não há o que
 * fechar. Recém-mesclada também não entra: aquela ainda é do caminho normal.
 *
 * A mesma tarefa (projeto + número) aparece uma vez só, por mais entregas que
 * tenha acumulado — foi justamente a redelegação repetida que encheu o quadro.
 * A chave inclui o projeto: o número da issue só é único dentro de um
 * repositório, e deduplicar só por número fazia a tarefa de um projeto sumir
 * atrás da homônima de outro.
 */
export function entregasQueMerecemConferencia<T extends EntregaParaConferir>(
  linhas: readonly T[],
  agora: Date = new Date()
): T[] {
  const vistas = new Set<string>()
  const escolhidas: T[] = []
  for (const linha of linhas) {
    if (!linha.mergeCommitSha && linha.closedReason !== 'merged') continue
    if (!Number.isInteger(linha.issueNumber) || linha.issueNumber <= 0) continue
    // Recém-mesclada é do caminho normal, não desta varredura.
    if (agora.getTime() - linha.updatedAt.getTime() < CARENCIA_ANTES_DE_VARRER_MS) continue
    const chave = chaveDaTarefa(linha.projectId, linha.issueNumber)
    if (vistas.has(chave)) continue
    vistas.add(chave)
    escolhidas.push(linha)
  }
  return escolhidas
}

/** O que a ficha da tarefa já sabe sobre ela. */
export interface FichaDaTarefa {
  status: string | null
  /** O produto fechou esta tarefa por causa da entrega (guardado na conferência). */
  fechadaPelaEntrega: boolean
}

/** O que a varredura precisa do projeto: o repositório e as três chamadas que faz nele. */
export interface ContextoDoProjeto {
  wingId: string
  lerIssue: (numero: number) => Promise<{ state?: string }>
  comentar: (numero: number, corpo: string) => Promise<void>
  fechar: (numero: number) => Promise<void>
}

export interface DepsDaVarredura {
  linhas: readonly EntregaParaConferir[]
  agora: Date
  teto?: number
  /** Ficha de cada tarefa, por `chaveDaTarefa`. Ausente = nunca vista. */
  fichas: ReadonlyMap<string, FichaDaTarefa>
  /** Até quando cada tarefa que falhou descansa. Vive no processo e é mutada aqui. */
  falhasAte: Map<string, number>
  /** `null` pula o projeto (inativo, sem credencial, cota em freio). */
  abrirProjeto: (projectId: string) => Promise<ContextoDoProjeto | null>
  /** Grava na ficha que a tarefa está fechada (e se fomos nós). */
  marcarFicha: (
    projectId: string,
    numero: number,
    quem: { fechadaPelaEntrega: boolean }
  ) => Promise<void>
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  /** Depois de uma falha: `true` para o projeto parar (cota esgotada). */
  aposFalha: (wingId: string) => boolean
  /** A guarda de autonomia recusou a escrita neste projeto. */
  naoAutorizado: (err: unknown) => boolean
  aviso: (mensagem: string) => void
  info: (mensagem: string) => void
}

export interface ResumoDaVarredura {
  candidatas: number
  consultadas: number
  fechadas: number
  falhas: number
}

/**
 * Quem entra na passada, nesta ordem de prioridade.
 *
 *  - Fora: tarefa que a ficha já diz fechada (consultar de novo não muda nada),
 *    tarefa que o produto fechou e alguém reabriu (reabrir é decisão de gente)
 *    e tarefa que falhou há pouco (repetir a mesma leitura só gasta cota).
 *  - Primeiro quem nunca falhou; depois, quem falhou há mais tempo.
 *  - O teto corta o resto. Quem ficou de fora continua candidato e, como o
 *    consultado sai da lista (a ficha passa a dizer fechada), entra primeiro
 *    na passada seguinte.
 */
export function selecionarDaPassada<T extends EntregaParaConferir>(args: {
  candidatas: readonly T[]
  fichas: ReadonlyMap<string, FichaDaTarefa>
  falhasAte: ReadonlyMap<string, number>
  agora: Date
  teto: number
}): T[] {
  const agoraMs = args.agora.getTime()
  const elegiveis = args.candidatas.filter((l) => {
    const chave = chaveDaTarefa(l.projectId, l.issueNumber)
    const ficha = args.fichas.get(chave)
    if (ficha?.status === 'closed') return false
    if (ficha?.fechadaPelaEntrega) return false
    const descansaAte = args.falhasAte.get(chave)
    return descansaAte === undefined || descansaAte <= agoraMs
  })
  const ultimaFalha = (l: T): number =>
    args.falhasAte.get(chaveDaTarefa(l.projectId, l.issueNumber)) ?? 0
  // `sort` é estável: dentro do mesmo grupo vale a ordem de chegada.
  return [...elegiveis].sort((a, b) => ultimaFalha(a) - ultimaFalha(b)).slice(0, args.teto)
}

/**
 * Confere as tarefas entregues, cada uma no repositório do SEU projeto, e fecha
 * as que ainda estão abertas. Devolve os números da passada para o log.
 */
export async function varrerTarefasEntregues(deps: DepsDaVarredura): Promise<ResumoDaVarredura> {
  const candidatas = entregasQueMerecemConferencia(deps.linhas, deps.agora)
  const escolhidas = selecionarDaPassada({
    candidatas,
    fichas: deps.fichas,
    falhasAte: deps.falhasAte,
    agora: deps.agora,
    teto: deps.teto ?? TETO_DE_TAREFAS_POR_PASSADA,
  })
  const resumo: ResumoDaVarredura = {
    candidatas: candidatas.length,
    consultadas: 0,
    fechadas: 0,
    falhas: 0,
  }

  const porProjeto = new Map<string, typeof escolhidas>()
  for (const e of escolhidas) {
    const lista = porProjeto.get(e.projectId) ?? []
    lista.push(e)
    porProjeto.set(e.projectId, lista)
  }

  for (const [projectId, entregas] of porProjeto) {
    const ctx = await deps.abrirProjeto(projectId)
    if (!ctx) continue

    for (const entrega of entregas) {
      const numero = entrega.issueNumber
      resumo.consultadas += 1
      try {
        const issue = await ctx.lerIssue(numero)
        if (issue.state !== 'open') {
          await deps.marcarFicha(projectId, numero, { fechadaPelaEntrega: false })
          continue
        }

        await ctx.comentar(
          numero,
          recadoDeTarefaJaEntregue({
            pullRequestNumber: entrega.pullRequestNumber,
            mergeCommitSha: entrega.mergeCommitSha,
          })
        )
        await ctx.fechar(numero)
        await deps.marcarFicha(projectId, numero, { fechadaPelaEntrega: true })
        resumo.fechadas += 1
        const entregou = entrega.pullRequestNumber
          ? `PR #${entrega.pullRequestNumber}`
          : 'a entrega'
        await deps
          .registrarNoPainel(
            projectId,
            `tarefa-entregue-fechada:${ctx.wingId}#${numero}`,
            `Tarefa #${numero} de ${ctx.wingId} encerrada: ${entregou} já estava mesclado. Para desfazer: reabrir a issue #${numero}.`
          )
          .catch((err) =>
            deps.aviso(
              `${ctx.wingId}: tarefa #${numero} encerrada, mas o registro no painel falhou: ${(err as Error).message}`
            )
          )
        deps.info(`${ctx.wingId}: tarefa #${numero} encerrada — a entrega dela já estava mesclada`)
      } catch (err) {
        if (deps.naoAutorizado(err)) {
          // A guarda de autonomia deste projeto não deixa escrever: não é falha.
          deps.info(`${ctx.wingId}: autonomia não permite encerrar tarefas; pulando o projeto`)
          break
        }
        // Uma tarefa apagada ou sem permissão não pode deixar as outras abertas
        // para sempre — nem ser relida a cada passada.
        deps.falhasAte.set(
          chaveDaTarefa(projectId, numero),
          deps.agora.getTime() + ESPERA_APOS_FALHA_MS
        )
        resumo.falhas += 1
        deps.aviso(
          `${ctx.wingId}: não consegui conferir a tarefa #${numero}: ${(err as Error).message}`
        )
        // Limite de taxa: insistir nas outras tarefas só gasta mais cota.
        if (deps.aposFalha(ctx.wingId)) break
      }
    }
  }
  return resumo
}

/**
 * O texto do fechamento quando o merge NÃO foi feito pelo produto.
 *
 * Diferente do texto de `fecharTarefaEntregue` de propósito: lá o produto diz
 * "eu mesclei"; aqui ele não mesclou, e afirmar que mesclou seria uma mentira
 * pequena numa mensagem que fica no repositório do cliente para sempre.
 *
 * Sem número de PR o texto continua verdadeiro em vez de citar "#null": a
 * linha existe (a entrega foi mesclada, o commit está gravado), só o número do
 * pedido não foi registrado naquela passagem.
 */
export function recadoDeTarefaJaEntregue(args: {
  pullRequestNumber: number | null
  mergeCommitSha: string | null
}): string {
  const origem = args.pullRequestNumber
    ? `A entrega que resolve esta tarefa (PR #${args.pullRequestNumber}) foi mesclada`
    : 'A entrega que resolve esta tarefa foi mesclada'
  const trechoCommit = args.mergeCommitSha
    ? ` — commit ${args.mergeCommitSha.slice(0, 8)}.`
    : ' (commit registrado via merge de PR).'
  return [
    `Encerrada pelo GitOrch: ${origem}${trechoCommit}`,
    '',
    'O merge não passou pelas mãos do produto (auto-merge do repositório ou',
    'alguém clicando), e por isso a tarefa tinha ficado aberta mesmo com o',
    'trabalho entregue. Enquanto ficava aberta, ela voltava para a fila e era',
    'delegada de novo — o que produzia entregas em conflito com a que já tinha',
    'entrado.',
    '',
    'Registro automático. Para desfazer: reabrir esta issue.',
  ].join('\n')
}
