// L4-T8 (fix-up 2) — o nascimento ÚNICO de uma issue de desejo.
//
// Achado A da revisão: os 4 nascimentos (routes/index.ts, plugins/telegram.ts
// e plugins/scheduler.ts×2 — `pedirOAvisoDePublicacao` e
// `abrirConsertoDePublicacao`) reimplementavam, cada um por conta própria, o
// MESMO trio: resolver o quadro do repositório (`resolverQuadroParaDesejo`),
// montar o `fetch` guardado pela autonomia REAL do projeto e só então chamar
// `criarIssueDeDesejo({ fetchImpl, quadro })`. Um deles
// (`pedirOAvisoDePublicacao`) nem chegava a passar `fetchImpl` — a issue
// nunca nascia, em NENHUM nível de autonomia, e a exceção da guarda padrão
// (`fetchSemPermissao`) morria em silêncio no `catch` de fora (L4-T19). A
// lição do SSRF de novo: um trio repetido em 4 lugares diverge sozinho; um
// trio só, chamado 4 vezes, não.
//
// DESVIO DELIBERADO do texto original do achado A ("guardaPorRepositorio, o
// mesmo caminho que 065d779 conectou"): o teste RED (`nascer-desejo.test.ts`,
// caso "cuidar") provou ao vivo que `guardaPorRepositorio` NUNCA funciona
// aqui — `criarIssueDeDesejo` usa o MESMO `fetchImpl` para criar a issue
// (REST, `/repos/.../issues`, repositório NA URL) e para anexar ao quadro
// (GraphQL, `/graphql`, o quadro é nomeado por id — NUNCA há repositório na
// URL). `guardaPorRepositorio` descobre o dono PELA URL
// (`repositorioDaUrl`); sem repositório na URL ela RECUSA sempre, com
// `EscritaNaoAutorizadaError` — o mesmo limite que o comentário de
// `anexarIssueDeIncidenteAoQuadro` (quadro-do-repositorio.ts) já documentava
// e que fez aquele caminho usar `fetchDoRepositorio`, não
// `guardaPorRepositorio`, para escrever no quadro do cliente. Com
// `guardaPorRepositorio` aqui, o anexo falhava SEMPRE — em QUALQUER nível de
// autonomia, inclusive "cuidar" — silenciosamente engolido pelo
// `try/catch` de `criarIssueDeDesejo` (vira só um `onWarn`), então nenhum
// teste de integração pegaria isso sem checar a chamada de rede de verdade.
// `fetchDoRepositorio` (mesmo helper que `abrirConsertoDePublicacao` e o
// `fetchDeEscritaNoCliente` do incidente já usam) resolve os dois formatos
// de URL, então é o que este nascimento usa — lendo a autonomia real no
// prisma continua sendo o contrato, só que por uma leitura no início deste
// nascimento (uma operação de milissegundos: uma leitura por chamada é tão
// "fresca" quanto uma por sub-requisição) em vez de uma por sub-requisição.

import { criarIssueDeDesejo, type RegistroDeFalha } from './desejo-no-github.js'
import { fetchDoRepositorio } from './guarda-de-autonomia.js'
import {
  resolverQuadroParaDesejo,
  type PrismaLikeParaQuadro,
  type DepsDoResolverQuadro,
} from './quadro-do-repositorio.js'
import type { LeitorDeCredencialDeLogin } from './project-credential.js'

/** O recorte de Prisma que este serviço precisa: o de
 *  `resolverQuadroDoRepositorio` (achar repositório/dono do projeto) MAIS
 *  `findFirst` por `wingId` — o MESMO jeito que 065d779 lê a autonomia REAL
 *  na hora de escrever (nunca uma reaproveitada de outro lugar). */
export interface PrismaLikeParaNascerDesejo extends PrismaLikeParaQuadro {
  project: PrismaLikeParaQuadro['project'] & {
    findFirst: (args: {
      where: { wingId: string; isActive: boolean }
      select: { autonomia: boolean }
    }) => Promise<{ autonomia?: string | null } | null>
  }
}

export interface DepsDeNascerDesejo {
  prisma: PrismaLikeParaNascerDesejo
  /** Injeção; produção passa `app.engineConnections`. Ausência (scripts,
   *  testes) resolve em "sem reforço", nunca lança. */
  engineConnections?: LeitorDeCredencialDeLogin
  /** Cru, ANTES da guarda de autonomia — só os testes trocam; em produção é
   *  o `fetch` do runtime. */
  fetchImpl?: typeof fetch
  /** Só os testes trocam — em produção é a credencial real da instalação
   *  do App (`criarIssueDeDesejo` cai em `mintInstallationToken` sozinho). */
  obterToken?: (repo: string) => Promise<string | null>
  onInfo?: (mensagem: string) => void
}

/**
 * O nascimento ÚNICO de uma issue de desejo: resolve o quadro do
 * repositório, monta o `fetch` guardado pela autonomia REAL do projeto e
 * cria a issue — com ou sem card, mas sempre com a guarda ligada.
 *
 * Nunca lança por causa do QUADRO: sem decisão 'usar', a issue nasce igual,
 * sem card, e o motivo vira `onInfo` (`resolverQuadroParaDesejo` já garante
 * isto). Falha ao ANEXAR ao quadro depois de a issue já existir também não
 * lança — vira `log.onWarn` (dentro de `criarIssueDeDesejo`).
 *
 * PODE lançar por causa da AUTONOMIA: um projeto em "só olhar" faz a
 * chamada de escrita real (POST da issue) recusar com
 * `EscritaNaoAutorizadaError` — de propósito, para a rota HTTP (065d779)
 * traduzir em 403 `AUTONOMIA_INSUFICIENTE`; quem chama por fora de uma rota
 * (Telegram, scheduler) trata isso como qualquer outra falha de escrita.
 */
export async function nascerDesejo(
  args: {
    projectId: string
    repo: string
    titulo: string
    corpo: string
    etiquetas: string[]
    log?: RegistroDeFalha
  },
  deps: DepsDeNascerDesejo
): Promise<{ numero: number }> {
  const quadroDeps: DepsDoResolverQuadro & { onInfo?: (mensagem: string) => void } = {
    prisma: deps.prisma,
    ...(deps.engineConnections ? { engineConnections: deps.engineConnections } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.onInfo ? { onInfo: deps.onInfo } : {}),
  }
  const quadro = await resolverQuadroParaDesejo(
    { projectId: args.projectId, repo: args.repo },
    quadroDeps
  )

  // A autonomia REAL do projeto, lida no prisma pelo `wingId` — o mesmo
  // filtro (`isActive: true`) que 065d779 já usava em routes/index.ts e
  // plugins/telegram.ts.
  const projeto = await deps.prisma.project.findFirst({
    where: { wingId: args.repo, isActive: true },
    select: { autonomia: true },
  })
  const nivel = projeto?.autonomia ?? null
  const fetchImpl = fetchDoRepositorio({
    nivel: () => nivel,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })

  return criarIssueDeDesejo({
    repo: args.repo,
    titulo: args.titulo,
    corpo: args.corpo,
    etiquetas: args.etiquetas,
    ...(args.log ? { log: args.log } : {}),
    ...(deps.obterToken ? { obterToken: deps.obterToken } : {}),
    fetchImpl,
    ...(quadro ? { quadro } : {}),
  })
}
