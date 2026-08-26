import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { decidirSobreAviso } from '../services/aviso-de-publicacao.js'
import {
  registrarEstadoDaPublicacao,
  type PrismaDevSession,
} from '../services/dev-session-store.js'

/**
 * A porta por onde quem publica FORA do GitHub confirma que a versão subiu
 * (D49, cenário (e): "tudo privado, numa VM minha").
 *
 * O produto só sabia observar publicação de fora, lendo o GitHub. Numa VM
 * privada não há o que ler: o GitHub nunca fica sabendo. Resultado medido em
 * 25/08 — seis entregas mescladas presas, cada uma esperando 24 horas por uma
 * confirmação impossível antes de desistir.
 *
 * Aqui a confirmação vem de quem sabe. O CD do cliente chama esta rota com a
 * chave do projeto (a mesma que o wizard já entrega) dizendo qual commit subiu
 * e se deu certo. A lei não afrouxa: continua sendo prova, só que vinda de
 * dentro em vez de de fora.
 */

interface Params {
  id: string
}

interface Body {
  /** O commit que subiu — o SHA inteiro, como o CD conhece. */
  commit?: string
  /** `false` quando a publicação falhou. Ausente = deu certo. */
  sucesso?: boolean
  /** Onde ficou no ar, quando o CD sabe dizer. Só informativo. */
  url?: string
}

export const avisoDePublicacaoRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post<{ Params: Params; Body: Body }>(
    '/api/projects/:id/publicado',
    async (request: FastifyRequest<{ Params: Params; Body: Body }>, reply: FastifyReply) => {
      const commit = request.body?.commit?.trim()
      if (!commit) {
        return reply.code(400).send({ error: 'informe o commit que foi publicado' })
      }

      // O dono do projeto, pela via de sempre. Uma chave de um projeto não
      // pode carimbar publicação em outro: seria um cliente declarando "no ar"
      // sobre a entrega alheia.
      const projeto = await app.prisma.project.findFirst({
        where: { id: request.params.id, wingId: request.wingId! },
        select: { id: true },
      })
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      // A entrega DAQUELE COMMIT, e não "a mais recente do projeto".
      //
      // Pela mais recente, um projeto com duas entregas esperando aviso ao
      // mesmo tempo (mescla A, mescla B antes de A confirmar) comparava o
      // aviso de B contra A e devolvia 409 — a confirmação legítima de B
      // nunca era aplicada, e B só se resolvia no teto de 24 horas.
      //
      // Sem distinção de caixa porque ferramentas de CD escrevem o SHA de
      // jeitos diferentes; o SHA vai INTEIRO, nunca por prefixo, para que
      // "quase o mesmo commit" não passe por "o mesmo commit".
      const entrega = await app.prisma.devSession.findFirst({
        where: {
          projectId: projeto.id,
          mergeCommitSha: { equals: commit, mode: 'insensitive' },
        },
        orderBy: { updatedAt: 'desc' },
        select: { sessionName: true, mergeCommitSha: true, closedAt: true },
      })

      const decisao = decidirSobreAviso({
        entrega,
        commitAvisado: commit,
        sucesso: request.body?.sucesso !== false,
        agora: new Date(),
      })

      if (decisao.acao === 'recusar') {
        return reply.code(409).send({ error: decisao.motivo })
      }
      if (decisao.acao === 'ignorar') {
        // 200, e não erro: reenvio do CD do cliente é comportamento normal, e
        // um CD que recebe erro tende a repetir em rajada.
        return reply.send({ registrado: false, motivo: decisao.motivo })
      }

      await registrarEstadoDaPublicacao({
        prisma: app.prisma as unknown as PrismaDevSession,
        sessionName: entrega!.sessionName,
        estado: decisao.estado,
        agora: new Date(),
      })

      // A PROVA de que a chamada existe e funciona (D50) — gravada DEPOIS do
      // efeito real, nunca antes. Gravar antes e falhar no registro da entrega
      // deixaria o pior estado possível: o cliente recebendo erro, a entrega
      // sem veredito, e o produto convencido de que o aviso "já está
      // instalado e funcionando" — encerrando 24h depois com a frase "o aviso
      // não chegou", que seria falsa. É a mesma ordem que a tarefa de conserto
      // já usa, e pelo mesmo motivo.
      await app.prisma.project
        .updateMany({
          where: { id: projeto.id, deployNoticeInstalledAt: null },
          data: { deployNoticeInstalledAt: new Date() },
        })
        .catch((err: unknown) =>
          // Best-effort: a confirmação da entrega já aconteceu e não pode ser
          // desfeita por causa desta marca. Mas nunca em silêncio — sem ela o
          // produto volta a pedir ao cliente o que ele já fez.
          app.log.warn(err, `[Publicação] não deu para marcar o aviso como instalado`)
        )

      app.log.info(
        `[Publicação] ${projeto.id} avisou que o commit ${commit} ${
          decisao.estado === 'no-ar' ? 'subiu' : 'falhou ao subir'
        }` + (request.body?.url ? ` (${request.body.url})` : '')
      )

      return reply.send({ registrado: true, estado: decisao.estado })
    }
  )
}

export default avisoDePublicacaoRoutes
