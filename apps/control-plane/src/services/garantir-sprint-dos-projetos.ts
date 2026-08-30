import { garantirSprintNoQuadro, DIAS_DE_SPRINT_PADRAO } from './garantir-sprint.js'
import type { ClienteDeQuadro, ResultadoDaSprint } from './garantir-sprint.js'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'

/**
 * O caminho de PRODUÇÃO que garante a sprint no quadro de cada projeto.
 *
 * POR QUE ESTE ARQUIVO EXISTE: `garantirSprintNoQuadro` foi construída,
 * testada e mesclada no bloco 3 da leva 2 — e ficou ÓRFÃ. Medido em 30/08/2026
 * por três caminhos independentes: `grep` não achou nenhum chamador fora do
 * próprio teste; o grafo do código mostrou o nó ligado só ao `.test.ts`; e a
 * API do GitHub confirmou na fonte que o quadro #2 do gitorch tinha os 13
 * campos padrão e NENHUM campo de iteração — se a função tivesse rodado uma
 * única vez na vida, o campo existiria.
 *
 * A consequência para quem usa: `GET /api/v1/painel/sprint` devolvia
 * `{"sprints":[],"configurados":0}` para sempre, e o painel dizia "seus
 * projetos ainda não têm sprint configurada" — uma frase honesta sobre um
 * estado que o produto tinha prometido resolver sozinho.
 *
 * A lição, que vale além deste caso: código que existe, tem teste verde e não
 * é chamado por ninguém é indistinguível de código que funciona, até alguém
 * olhar o resultado no mundo. Por isso o teste desta função verifica que a
 * garantia É CHAMADA, e a prova final foi conferida no quadro do GitHub, não
 * na resposta da nossa própria rota.
 */

/** O que aconteceu com um projeto nesta passada. */
export interface ResultadoPorProjeto {
  projeto: string
  repo: string
  estado:
    | ResultadoDaSprint['estado']
    /** o nível de autonomia não permite escrever no quadro. */
    | 'recusado'
    /** não há credencial que alcance este repositório. */
    | 'sem_credencial'
    /** nenhum quadro utilizável (a decisão não foi 'usar'). */
    | 'sem_quadro'
    /** qualquer outra falha, dita e não engolida. */
    | 'falhou'
  motivo: string
}

export interface ProjetoParaSprint {
  id: string
  name: string
  wingId: string
  autonomia: string | null
  sprintDias: number | null
  /** Dono do projeto. Nulo só em registro legado — e sem dono não há
   *  credencial do App para buscar. */
  userId?: string | null
}

export interface DepsDaSprint {
  /** Os projetos ativos que devem ter sprint. */
  listarProjetos: () => Promise<ProjetoParaSprint[]>
  /**
   * A credencial que alcança ESTE repositório, e de onde ela veio.
   *
   * Não é detalhe: o App do produto não enxerga quadro de conta pessoal
   * ("Resource not accessible by integration", provado em 30/08 no
   * patinhas-3d-crafts). Para esses, o produto usa a credencial do próprio
   * cliente, guardada cifrada em `Project.encryptedClientToken` — campo que
   * existe exatamente para onde o App não chega.
   */
  credencialDoProjeto: (
    p: ProjetoParaSprint
  ) => Promise<{ token: string; origem: 'app' | 'cliente' } | null>
  /** Decide QUAL quadro usar (os 8 cenários de `resolver-quadro.ts`). */
  quadroDoProjeto: (
    p: ProjetoParaSprint,
    token: string
  ) => Promise<{ acao: string; quadro?: { id: string; title: string }; motivo?: string }>
  /** A garantia em si, com o cliente de quadro JÁ embrulhado na guarda. */
  garantir: (
    cliente: ClienteDeQuadro,
    args: { projectId: string; duracaoEmDias: number }
  ) => Promise<ResultadoDaSprint>
  /** O cliente de quadro para este projeto, com a guarda de autonomia dentro. */
  clienteDeQuadro?: (p: ProjetoParaSprint, token: string) => ClienteDeQuadro
  log: { warn: (m: string) => void; info: (m: string) => void; debug: (m: string) => void }
}

export async function garantirSprintDosProjetos(
  deps: DepsDaSprint
): Promise<{ resultados: ResultadoPorProjeto[] }> {
  const projetos = await deps.listarProjetos()
  const resultados: ResultadoPorProjeto[] = []

  // EM SÉRIE, de propósito. Dois projetos do mesmo dono compartilham a
  // credencial; em paralelo, uma renovação de token no meio da outra derruba
  // as duas — o defeito que matou a conta do Codex em 26/08. O ganho de
  // paralelizar aqui seria de segundos, uma vez por tique.
  for (const p of projetos) {
    const base = { projeto: p.name, repo: p.wingId }
    try {
      const cred = await deps.credencialDoProjeto(p)
      if (!cred) {
        // Ausência DITA, não silenciada: sem isto o projeto simplesmente não
        // apareceria, e "não tentei" pareceria "tentei e estava tudo certo".
        resultados.push({
          ...base,
          estado: 'sem_credencial',
          motivo: 'não há credencial que alcance este repositório',
        })
        continue
      }

      const decisao = await deps.quadroDoProjeto(p, cred.token)
      if (decisao.acao !== 'usar' || !decisao.quadro) {
        // 'criar', 'escolher' e 'sem_acesso' são respostas legítimas que NÃO
        // dão um quadro certo. Inventar um aqui seria pior que não fazer nada.
        resultados.push({
          ...base,
          estado: 'sem_quadro',
          motivo: decisao.motivo ?? `nenhum quadro utilizável (${decisao.acao})`,
        })
        continue
      }

      const cliente = deps.clienteDeQuadro?.(p, cred.token)
      const r = await deps.garantir(cliente as ClienteDeQuadro, {
        projectId: decisao.quadro.id,
        // A duração é DO CLIENTE quando ele escolheu (decisão do dono, 30/08:
        // "pra clientes no painel eles decidem de quantos dias"). O padrão do
        // produto vale só para quem nunca escolheu.
        duracaoEmDias: p.sprintDias ?? DIAS_DE_SPRINT_PADRAO,
      })
      resultados.push({ ...base, estado: r.estado, motivo: r.motivo })
    } catch (err) {
      // A recusa da guarda NÃO é falha: é o produto obedecendo ao nível que o
      // cliente escolheu. Misturar as duas faria um "só olhar" legítimo
      // aparecer no log como defeito, e o defeito de verdade se perder no meio.
      if (err instanceof EscritaNaoAutorizadaError) {
        resultados.push({ ...base, estado: 'recusado', motivo: err.message })
        continue
      }
      const motivo = err instanceof Error ? err.message : String(err)

      // "Resource not accessible by integration" tem uma causa conhecida e uma
      // saída conhecida: o App do produto NÃO enxerga quadro de conta pessoal
      // (só de organização). Não é falha nossa nem defeito de código — é
      // permissão que o App não tem e nunca vai ter, e a saída é o cliente
      // guardar a credencial dele. Deixar isso como "falhou" genérico mandaria
      // alguém procurar um defeito que não existe, e esconderia do dono a
      // única coisa que resolveria.
      if (/not accessible by integration/i.test(motivo)) {
        resultados.push({
          ...base,
          estado: 'sem_credencial',
          motivo:
            'o aplicativo do GitOrch não enxerga quadro de conta pessoal; ' +
            'para este repositório é preciso a sua própria credencial guardada no projeto',
        })
        continue
      }

      deps.log.warn(`[sprint] ${p.wingId}: ${motivo.slice(0, 200)}`)
      resultados.push({ ...base, estado: 'falhou', motivo })
    }
  }

  return { resultados }
}

export { garantirSprintNoQuadro }
