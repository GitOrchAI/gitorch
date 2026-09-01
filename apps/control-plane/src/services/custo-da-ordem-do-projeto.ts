import { analisarCustoDaOrdem, type PedidoNaFila } from '@gitorch/cadence'
import { formatarAvisoDeCustoDaOrdem } from './aviso-de-custo-da-ordem.js'

// A caixa "Sua ordem custa caro?" ligada ao relógio: por PROJETO, lê a fila
// do quadro (ordem + peso — o que já existe), calcula, e — só quando vale a
// pena — avisa o dono com o pedido e o número.
//
// A LEI DO DESENHO ("você sempre decide") está na FORMA deste arquivo, não
// só no comentário: repare que `DepsDeCustoDaOrdem` não expõe NENHUMA
// função de escrita no quadro (nada como `moverItemDoQuadro`). Esta função
// estruturalmente não tem como reordenar nada — só pode ler a fila, calcular
// e avisar. Quem decide o que fazer com o aviso é o dono, do outro lado do
// Telegram/painel.

/** Um projeto, do jeito mínimo que esta avaliação precisa dele. */
export interface ProjetoParaAvaliar {
  id: string
  wingId: string
}

/**
 * O que já foi proposto para este projeto — para não repetir o MESMO aviso a
 * cada passada do relógio. `null` = nunca propôs nada, ou a última proposta
 * já deixou de valer (a ordem mudou, ou deixou de custar caro).
 *
 * Guardado em `Project.runtimeConfig.custoDaOrdem` (JSON já existente no
 * schema, mesmo padrão de `resolveQuadroDoProjeto`/`agent-question.ts`) —
 * nenhuma tabela nova, nenhuma migração.
 */
export interface EstadoDoAvisoDeCustoDaOrdem {
  ultimoPedidoProposto: number | null
}

export interface DepsDeCustoDaOrdem {
  /** Os projetos a avaliar nesta passada. */
  projetos: () => Promise<ProjetoParaAvaliar[]>
  /**
   * A fila do quadro deste projeto, NA ORDEM que está lá, com o peso de cada
   * item. `null` quando não deu para ler com confiança (sem quadro, sem
   * credencial, campo "Peso" ausente, algum item sem peso planejado) — é
   * SILÊNCIO desta passada, nunca um erro: o produto tenta de novo na
   * próxima, e nunca inventa um peso que não tem.
   */
  filaDoQuadro: (projeto: ProjetoParaAvaliar) => Promise<PedidoNaFila[] | null>
  lerEstado: (projectId: string) => Promise<EstadoDoAvisoDeCustoDaOrdem>
  salvarEstado: (projectId: string, estado: EstadoDoAvisoDeCustoDaOrdem) => Promise<void>
  /** Entrega o texto ao dono — o caminho que já existe (painel/Telegram). */
  avisar: (projeto: ProjetoParaAvaliar, texto: string) => Promise<void>
  /** Um projeto não pode travar os outros. Chamado, nunca lançado de novo. */
  onErro?: (projeto: ProjetoParaAvaliar, err: unknown) => void
}

export interface ResumoDaAvaliacao {
  avaliados: number
  avisados: number
}

const ESTADO_LIMPO: EstadoDoAvisoDeCustoDaOrdem = { ultimoPedidoProposto: null }

export async function avaliarCustoDaOrdemDosProjetos(
  deps: DepsDeCustoDaOrdem
): Promise<ResumoDaAvaliacao> {
  const projetos = await deps.projetos()
  let avisados = 0

  // EM SÉRIE, mesmo motivo das varreduras irmãs do relógio (scheduler.ts): um
  // projeto lento ou com defeito não pode atrasar nem derrubar os outros, e a
  // credencial pode ser compartilhada entre projetos do mesmo dono.
  for (const projeto of projetos) {
    try {
      const fila = await deps.filaDoQuadro(projeto)
      if (!fila) continue // não deu para ler com confiança — tenta na próxima passada

      const analise = analisarCustoDaOrdem(fila)
      const estado = await deps.lerEstado(projeto.id)

      if (!analise.custaCaro) {
        // A ordem deixou de custar caro (ou nunca custou). Limpa a marca:
        // se um candidato de verdade aparecer depois — mesmo que seja o
        // MESMO pedido de antes — ele precisa poder avisar de novo.
        if (estado.ultimoPedidoProposto !== null) {
          await deps.salvarEstado(projeto.id, ESTADO_LIMPO)
        }
        continue
      }

      // MESMO candidato já proposto: o dono já sabe. Repetir a cada passada
      // é a rajada de avisos de rotina que ele já reclamou (29/08,
      // classe-do-aviso.ts) — só que dentro do próprio produto.
      if (estado.ultimoPedidoProposto === analise.candidato.pedido) continue

      const texto = formatarAvisoDeCustoDaOrdem(analise.candidato)
      await deps.avisar(projeto, texto)
      await deps.salvarEstado(projeto.id, { ultimoPedidoProposto: analise.candidato.pedido })
      avisados++
    } catch (err) {
      deps.onErro?.(projeto, err)
    }
  }

  return { avaliados: projetos.length, avisados }
}
