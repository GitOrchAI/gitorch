import type { FastifyInstance } from 'fastify'
import type {
  IssueParaDiagnostico,
  ResultadoDoDiagnostico,
} from '../services/diagnostico-de-issues.js'
import {
  montarLoteDeSugestoes,
  resolverAvalDoLote,
  type DecisaoDoItem,
  type ModoDeAval,
} from '../services/lote-de-sugestoes.js'
import { aplicarLoteDeSugestoes } from '../services/aplicar-lote-de-sugestoes.js'

// D7 (parte A) do desenho aprovado em 30/08: a porta HTTP do nível "Sugerir"
// — junta os achados de um projeto num lote só (GET) e resolve UM aval sobre
// o lote inteiro (POST): aprovar tudo, recusar tudo, ou item a item.
//
// Dependências injetadas pelo MESMO motivo de routes/desejos.ts: a rota
// precisa ser testável sem banco, sem clone de repositório e sem rede. Quem
// monta as de verdade é routes/index.ts.
export interface ProjetoParaLote {
  id: string
  /** 'dono/repo', como Project.wingId. */
  githubRepo: string
  autonomia: string | null | undefined
}

export interface DependenciasDoLoteDeSugestoes {
  buscarProjeto: (args: { projectId: string; userId: string }) => Promise<ProjetoParaLote | null>
  /** Caminho do clone local, pronto para o grafo do código — mesmo clone que o resto do produto reaproveita. */
  garantirWorkspace: (repo: string) => Promise<string>
  /** Issues ABERTAS do repositório, já paginadas até o fim (nunca só as 100 primeiras em silêncio). */
  listarIssuesAbertas: (repo: string) => Promise<IssueParaDiagnostico[]>
  /** `diagnosticarIssues` de verdade, injetado — mantém esta rota livre de graphify/git nos testes. */
  diagnosticar: (
    issues: IssueParaDiagnostico[],
    workspacePath: string
  ) => Promise<ResultadoDoDiagnostico>
  /** PATCH state:closed + comentário — a MESMA forma usada em scheduler.ts (fechar-incidente-resolvido). */
  fecharIssue: (repo: string, issueNumber: number, comentario: string) => Promise<void>
  /** Default: TETO_PADRAO_DO_LOTE (25). */
  teto?: number
}

async function montarLoteDoProjeto(projeto: ProjetoParaLote, deps: DependenciasDoLoteDeSugestoes) {
  const workspacePath = await deps.garantirWorkspace(projeto.githubRepo)
  const issues = await deps.listarIssuesAbertas(projeto.githubRepo)
  const resultado = await deps.diagnosticar(issues, workspacePath)
  const lote = montarLoteDeSugestoes(resultado, deps.teto !== undefined ? { teto: deps.teto } : {})
  return { lote, grafoIndisponivel: resultado.grafoIndisponivel }
}

function usuarioDaSessao(request: unknown): string | undefined {
  return (request as { user?: { id?: string } }).user?.id
}

export async function loteDeSugestoesRoutes(
  app: FastifyInstance,
  deps: DependenciasDoLoteDeSugestoes
) {
  // O lote inteiro, numa resposta só — a caixa "SUGERIR" do desenho.
  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projetos/:projectId/lote-de-sugestoes',
    async (request, reply) => {
      const userId = usuarioDaSessao(request)
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

      const projeto = await deps.buscarProjeto({ projectId: request.params.projectId, userId })
      if (!projeto) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      const { lote, grafoIndisponivel } = await montarLoteDoProjeto(projeto, deps)
      return reply.send({
        ...lote,
        ...(grafoIndisponivel !== undefined ? { grafoIndisponivel } : {}),
        nivelDeAutonomia: projeto.autonomia ?? null,
      })
    }
  )

  // Um aval só sobre o lote inteiro: aprovar tudo, recusar tudo, ou item a
  // item. Recalcula o MESMO lote (sem tabela nova, sem migração) em vez de ler
  // um lote guardado — risco aceito e documentado: se as issues mudarem entre
  // o GET e este POST, a decisão do dono (por NÚMERO de issue) se aplica ao
  // que existe agora, nunca ao que ele não chegou a ver.
  app.post<{
    Params: { projectId: string }
    Body: { modo?: string; porItem?: Record<string, DecisaoDoItem> }
  }>('/api/v1/projetos/:projectId/lote-de-sugestoes/aval', async (request, reply) => {
    const userId = usuarioDaSessao(request)
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

    const modo = request.body?.modo
    if (modo !== 'aprovar_tudo' && modo !== 'recusar_tudo' && modo !== 'por_item') {
      return reply.code(400).send({
        error: 'modo inválido — use "aprovar_tudo", "recusar_tudo" ou "por_item".',
      })
    }

    const projeto = await deps.buscarProjeto({ projectId: request.params.projectId, userId })
    if (!projeto) return reply.code(404).send({ error: 'Projeto não encontrado.' })

    const { lote, grafoIndisponivel } = await montarLoteDoProjeto(projeto, deps)

    const porItemNumerico: Record<number, DecisaoDoItem> | undefined = request.body?.porItem
      ? Object.fromEntries(
          Object.entries(request.body.porItem).map(([issue, decisao]) => [Number(issue), decisao])
        )
      : undefined

    const decididos = resolverAvalDoLote(lote, {
      modo: modo as ModoDeAval,
      ...(porItemNumerico ? { porItem: porItemNumerico } : {}),
    })

    const resultados = await aplicarLoteDeSugestoes(decididos, {
      nivel: projeto.autonomia,
      fecharIssue: (issueNumber, comentario) =>
        deps.fecharIssue(projeto.githubRepo, issueNumber, comentario),
    })

    return reply.send({
      resultados,
      aplicados: resultados.filter((r) => r.aplicado).length,
      foraDoTeto: lote.foraDoTeto,
      ...(grafoIndisponivel !== undefined ? { grafoIndisponivel } : {}),
    })
  })
}
