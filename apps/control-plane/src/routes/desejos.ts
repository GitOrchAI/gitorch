import type { FastifyInstance } from 'fastify'
import { autorLegivel, LIMITE_DO_TEXTO_DO_DESEJO, montarDesejo } from '../services/desejo.js'
import {
  AcessoNaoVerificavelError,
  CredencialDoGithubInvalidaError,
} from '../services/acesso-ao-repositorio.js'

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
  /**
   * A prova, NO MOMENTO DO USO, de que aquele dono ainda pode escrever naquele
   * repositório. Lança `AcessoNaoVerificavelError` quando não dá para saber —
   * e "não sei" é recusa temporária, nunca permissão.
   */
  confirmarAcesso: (repo: string, userId: string) => Promise<boolean>
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

      // O acesso foi provado no cadastro — e só. Daquele momento em diante o
      // endereço virou `wingId` e ninguém mais perguntou nada. Se a organização
      // removeu a pessoa depois, o projeto continua ativo apontando para
      // repositório alheio, e o pedido daqui viraria escrita real lá dentro,
      // com a credencial da INSTALAÇÃO — que não é dela. Por isso a mesma prova
      // do wizard é refeita aqui, na hora de usar.
      try {
        if (!(await deps.confirmarAcesso(projeto.githubRepo, userId))) {
          request.log.warn(
            { userId, repo: projeto.githubRepo },
            'pedido recusado: o dono não escreve mais neste repositório'
          )
          return reply.code(403).send({
            error:
              'Você não tem mais acesso de escrita a este repositório no GitHub, então não dá para registrar o pedido nele.',
            code: 'REPO_SEM_ACESSO',
          })
        }
      } catch (erro) {
        // Credencial que o GitHub recusa tem UM conserto — reconectar — e ele
        // precisa aparecer antes do ramo geral: ali a recusa sairia como
        // indisponibilidade, cujo único conselho é "tente de novo em
        // instantes". Tentar de novo nunca ressuscita um token revogado, então
        // o cliente ficaria preso num aviso que não leva a lugar nenhum.
        // A recusa é a mesma (o pedido não é registrado); muda só a frase.
        if (erro instanceof CredencialDoGithubInvalidaError) {
          request.log.warn(
            { err: erro, userId, repo: projeto.githubRepo },
            'pedido recusado: o GitHub não aceita mais a credencial do dono'
          )
          return reply.code(503).send({
            error: 'Sua conexão com o GitHub não vale mais. Reconecte sua conta e mande de novo.',
            code: 'GITHUB_DESCONECTADO',
          })
        }
        if (erro instanceof AcessoNaoVerificavelError) {
          // Indisponibilidade se diz com o nome dela: recusa temporária, com
          // convite a tentar de novo. Seguir no escuro seria escrever no
          // repositório sem saber se ainda é dele.
          request.log.warn(
            { err: erro, userId, repo: projeto.githubRepo },
            'pedido recusado: não foi possível confirmar o acesso ao repositório'
          )
          return reply.code(503).send({
            error:
              'Não consegui confirmar no GitHub que este repositório ainda é seu. Tente de novo em instantes.',
            code: 'REPO_NAO_VERIFICAVEL',
          })
        }
        throw erro
      }

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
