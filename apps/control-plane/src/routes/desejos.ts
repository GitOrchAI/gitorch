import type { FastifyInstance } from 'fastify'
import { autorLegivel, LIMITE_DO_TEXTO_DO_DESEJO, montarDesejo } from '../services/desejo.js'

// Porta HTTP do desejo: o dono descreve o que quer em linguagem de gente e o
// produto registra a issue oficial. As dependências entram por injeção porque
// a rota tem de ser testável sem banco e sem rede — quem monta as de verdade é
// `routes/index.ts`.
export interface DependenciasDeDesejos {
  buscarProjeto: (args: { projectId: string; userId: string }) => Promise<{
    id: string
    githubRepo: string
  } | null>
  /**
   * Os projetos que aceitam pedido, pela MESMA regra que `buscarProjeto` usa
   * para aceitar ou recusar. É isto que impede a tela de oferecer um projeto
   * que o envio vai recusar.
   */
  listarProjetos: (userId: string) => Promise<{ id: string; nome: string; repo: string }[]>
  /**
   * O cadastro de quem está pedindo, só o que serve para ASSINAR a issue. O
   * identificador da conta nunca é a assinatura: ver `autorLegivel`.
   */
  buscarAutor: (userId: string) => Promise<{ nome: string | null; arroba: string | null } | null>
  criarIssue: (args: {
    repo: string
    titulo: string
    corpo: string
    etiquetas: string[]
  }) => Promise<{ numero: number }>
}

export async function desejosRoutes(app: FastifyInstance, deps: DependenciasDeDesejos) {
  // A lista que o seletor da tela mostra.
  //
  // Ela vinha da tela de setup (`GET /api/v1/setup/status`), que filtra por dono
  // e por missão de setup e NÃO olha se o projeto está ativo — enquanto o envio
  // aqui embaixo exige projeto ativo. O resultado eram os dois erros opostos: a
  // tela oferecia um projeto e, no clique, respondia que aquele mesmo projeto
  // "não está disponível"; e escondia projeto criado por outro caminho, que o
  // envio teria aceitado. Com a lista saindo da mesma regra do envio, o que a
  // tela oferece é exatamente o que o servidor aceita.
  //
  // O dono é o `request.user.id` — o MESMO id que o POST usa para achar o
  // projeto. Fosse outro, a lista e o aceite voltariam a discordar, que é
  // justamente o defeito que esta rota existe para fechar.
  app.get('/api/v1/desejos/projetos', async (request, reply) => {
    const userId = (request as unknown as { user?: { id?: string } }).user?.id
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

    return reply.send({ projetos: await deps.listarProjetos(userId) })
  })

  app.post<{ Body: { projectId?: string; texto?: string } }>(
    '/api/v1/desejos',
    async (request, reply) => {
      const userId = (request as unknown as { user?: { id?: string } }).user?.id
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

      const projectId = request.body?.projectId
      const texto = request.body?.texto
      if (typeof projectId !== 'string' || typeof texto !== 'string' || texto.trim() === '') {
        return reply.code(400).send({ error: 'Pedido vazio ou projeto ausente.' })
      }

      // O teto vale AQUI, não só no navegador: acima dele o GitHub recusa o
      // corpo da issue com 422, o que virava 502 e chegava à tela como "tente
      // de novo em instantes" — conselho impossível de cumprir. O 413 diz o
      // motivo real (texto grande demais) e devolve o limite, para a tela poder
      // dizer o número em vez de um "grande demais" sem régua.
      if (texto.trim().length > LIMITE_DO_TEXTO_DO_DESEJO) {
        return reply.code(413).send({
          error: 'Texto grande demais para caber numa issue do GitHub.',
          limite: LIMITE_DO_TEXTO_DO_DESEJO,
        })
      }

      const projeto = await deps.buscarProjeto({ projectId, userId })
      if (!projeto) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      // Quem assina a issue é a PESSOA. Falha ao ler o cadastro não derruba o
      // pedido: `autorLegivel` cai no identificador da conta, que é feio mas
      // honesto — perder o pedido do dono por causa da assinatura seria pior.
      const quem = await deps.buscarAutor(userId)
      const desejo = montarDesejo({ texto, autor: autorLegivel(quem ?? {}, userId) })

      try {
        const criada = await deps.criarIssue({
          repo: projeto.githubRepo,
          titulo: desejo.titulo,
          corpo: desejo.corpo,
          etiquetas: desejo.etiquetas,
        })
        return reply.code(201).send({
          numero: criada.numero,
          endereco: `https://github.com/${projeto.githubRepo}/issues/${criada.numero}`,
        })
      } catch (erro) {
        // O erro do GitHub pode conter credencial; nunca repassar ao cliente.
        // A chave é `err` de propósito: o pino só serializa um Error sob ela.
        // Sob qualquer outra chave o objeto vira `{}` e a linha registra
        // "falhou" sem o motivo — exatamente o que ninguém consegue consertar.
        request.log.error({ err: erro }, 'falha ao registrar o desejo no GitHub')
        return reply.code(502).send({ error: 'Não consegui registrar o pedido agora.' })
      }
    }
  )
}

export default desejosRoutes
