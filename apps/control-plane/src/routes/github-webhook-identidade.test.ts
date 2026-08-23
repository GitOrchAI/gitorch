import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { githubWebhookRoutes } from './github-webhook.js'

/**
 * DE QUEM É ESTA ENTREGA?
 *
 * A assinatura HMAC prova que o aviso veio do GitHub — e nada mais. Ela não diz
 * a QUAL projeto do gitorch aquele aviso pertence; quem decide isso é o
 * casamento aqui dentro. Dois furos moravam nessa decisão:
 *
 * 1. O casamento era um OU cego entre três critérios de FORÇA MUITO DIFERENTE.
 *    O identificador numérico do repositório é atribuído pelo GitHub e é único;
 *    o endereço "dono/repo" é texto declarado pelo cliente; e a INSTALAÇÃO
 *    cobre MUITOS repositórios de uma vez. Aceitar a instalação como critério
 *    para uma entrega que fala de um repositório específico entregava, a um
 *    projeto, os avisos de todos os OUTROS repositórios daquela conta.
 *
 * 2. A auto-cura gravava no projeto casado os identificadores que vieram na
 *    entrega — inclusive o da instalação. Bastava casar pelo critério mais
 *    fraco (o texto) e estar com o campo vazio para o projeto ADOTAR uma
 *    instalação inteira que ninguém declarou que era dele.
 */

interface ProjetoNoBanco {
  id: string
  wingId: string
  githubInstallationId: number | null
  githubRepoId: bigint | null
  createdAt: Date
}

type Condicao = Record<string, unknown>

/**
 * Banco de projetos de mentira, fiel o bastante para o que está em jogo aqui:
 * entende as três condições que a rota usa e o `OR` entre elas. Sem isto o
 * teste responderia ao FORMATO da consulta em vez de responder ao dado, e
 * passaria por engano tanto na versão com o furo quanto na sem.
 */
function bancoDeProjetos(projetos: ProjetoNoBanco[]): {
  findFirst: ReturnType<typeof vi.fn>
  findMany: ReturnType<typeof vi.fn>
} {
  const casa = (projeto: ProjetoNoBanco, condicao: Condicao): boolean => {
    if (Array.isArray(condicao['OR'])) {
      return (condicao['OR'] as Condicao[]).some((parte) => casa(projeto, parte))
    }
    return Object.entries(condicao).every(([campo, valor]) => {
      if (campo === 'wingId') return projeto.wingId === valor
      if (campo === 'githubRepoId') return projeto.githubRepoId === valor
      if (campo === 'githubInstallationId') return projeto.githubInstallationId === valor
      throw new Error(`condição não suportada pelo banco de mentira: ${campo}`)
    })
  }

  const buscar = (args: { where?: Condicao; take?: number }): ProjetoNoBanco[] => {
    const achados = projetos
      .filter((projeto) => casa(projeto, args.where ?? {}))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return args.take ? achados.slice(0, args.take) : achados
  }

  return {
    findFirst: vi.fn(async (args: { where?: Condicao }) => buscar(args)[0] ?? null),
    findMany: vi.fn(async (args: { where?: Condicao; take?: number }) => buscar(args)),
  }
}

/** Corpo + assinatura no formato que a rota exige. */
function entrega(app: ReturnType<typeof Fastify>, corpo: unknown, evento: string, id: string) {
  const texto = JSON.stringify(corpo)
  const assinatura =
    'sha256=' + crypto.createHmac('sha256', 'test-secret').update(texto).digest('hex')
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'x-hub-signature-256': assinatura,
      'x-github-event': evento,
      'x-github-delivery': id,
    },
    payload: corpo as Record<string, unknown>,
  })
}

const NASCIMENTO = new Date('2020-01-01T00:00:00.000Z')

describe('webhook do GitHub — a quem a entrega pertence', () => {
  let app: ReturnType<typeof Fastify>

  /** Popula o banco de mentira e devolve os espiões usados nas asserções. */
  function comProjetos(projetos: ProjetoNoBanco[]): ReturnType<typeof bancoDeProjetos> {
    const banco = bancoDeProjetos(projetos)
    app.prisma.project.findFirst = banco.findFirst as unknown as typeof app.prisma.project.findFirst
    app.prisma.project.findMany = banco.findMany as unknown as typeof app.prisma.project.findMany
    return banco
  }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await githubWebhookRoutes(app)
    app.addHook('onRequest', async (req: FastifyRequest) => {
      req.wingId = 'wing_123'
    })
    await app.ready()

    // O registro da entrega passou a ser "consultar, depois gravar sem
    // duplicar" — antes era um `create` que estourava em reenvio e derrubava a
    // rota com 500. Os dublês seguem o contrato novo.
    app.prisma.webhookDelivery.create = vi.fn().mockResolvedValue({})
    app.prisma.webhookDelivery.findUnique = vi.fn().mockResolvedValue(null)
    app.prisma.webhookDelivery.createMany = vi.fn().mockResolvedValue({ count: 1 })
    app.prisma.webhookDelivery.updateMany = vi.fn().mockResolvedValue({})
    app.prisma.project.update = vi.fn().mockResolvedValue({})
    comProjetos([])
  })

  it('ATAQUE: a entrega de um repositório NÃO cai num projeto só por compartilhar a instalação', async () => {
    // O projeto do Mallory carrega a instalação 999 (herdada em algum momento).
    // A entrega fala de "vitima/cofre", que ele nunca declarou — mas o cofre
    // vive na MESMA instalação. Casar por instalação aqui entregaria a ele o
    // conteúdo do repositório alheio, gravado inteiro em webhook_deliveries.
    comProjetos([
      {
        id: 'proj_mallory',
        wingId: 'mallory/site',
        githubInstallationId: 999,
        githubRepoId: null,
        createdAt: NASCIMENTO,
      },
    ])

    const res = await entrega(
      app,
      {
        action: 'opened',
        installation: { id: 999 },
        repository: { id: 555, full_name: 'vitima/cofre' },
      },
      'issues',
      'entrega_cofre'
    )

    expect(res.statusCode).toBe(404)
    expect(app.prisma.webhookDelivery.createMany).not.toHaveBeenCalled()
  })

  it('a auto-cura NUNCA adota a instalação: casou pelo endereço, grava só o id do repositório', async () => {
    comProjetos([
      {
        id: 'proj_x',
        wingId: 'ana/api',
        githubInstallationId: null,
        githubRepoId: null,
        createdAt: NASCIMENTO,
      },
    ])

    const res = await entrega(
      app,
      {
        action: 'opened',
        installation: { id: 777 },
        repository: { id: 1274419899, full_name: 'ana/api' },
      },
      'issues',
      'entrega_endereco'
    )

    expect(res.statusCode).toBe(200)
    expect(app.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proj_x' },
        data: { githubRepoId: 1274419899n },
      })
    )
    const chamada = (app.prisma.project.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(chamada.data).not.toHaveProperty('githubInstallationId')
  })

  it('EMPATE no endereço: dois projetos declaram o mesmo repositório, então ninguém é curado', async () => {
    // Com mais de um candidato, o casamento pode ter escolhido o errado — e
    // gravar o identificador imutável no errado o congelaria como dono.
    comProjetos([
      {
        id: 'proj_antigo',
        wingId: 'acme/api',
        githubInstallationId: null,
        githubRepoId: null,
        createdAt: NASCIMENTO,
      },
      {
        id: 'proj_novo',
        wingId: 'acme/api',
        githubInstallationId: null,
        githubRepoId: null,
        createdAt: new Date('2021-01-01T00:00:00.000Z'),
      },
    ])

    const res = await entrega(
      app,
      {
        action: 'opened',
        installation: { id: 777 },
        repository: { id: 42, full_name: 'acme/api' },
      },
      'issues',
      'entrega_empate'
    )

    expect(res.statusCode).toBe(200)
    expect(app.prisma.project.update).not.toHaveBeenCalled()
  })

  it('entrega SEM repositório (evento de quadro/instalação) ainda casa pela instalação — e não cura nada', async () => {
    comProjetos([
      {
        id: 'proj_ana',
        wingId: 'ana/api',
        githubInstallationId: 777,
        githubRepoId: 42n,
        createdAt: NASCIMENTO,
      },
    ])

    const res = await entrega(
      app,
      { action: 'edited', installation: { id: 777 }, projects_v2: { id: 'PVT_1' } },
      'projects_v2',
      'entrega_quadro'
    )

    expect(res.statusCode).toBe(200)
    expect(app.prisma.project.update).not.toHaveBeenCalled()
  })

  it('o identificador numérico do repositório continua sendo o casamento preferido', async () => {
    const banco = comProjetos([
      {
        id: 'proj_dono',
        wingId: 'ana/api',
        githubInstallationId: null,
        githubRepoId: 42n,
        createdAt: NASCIMENTO,
      },
    ])

    const res = await entrega(
      app,
      {
        action: 'opened',
        installation: { id: 777 },
        // O endereço mudou no GitHub (renomeado), o id numérico não muda.
        repository: { id: 42, full_name: 'ana/api-renomeado' },
      },
      'issues',
      'entrega_por_id'
    )

    expect(res.statusCode).toBe(200)
    // Achou pelo id: nem chega a procurar pelo texto declarado.
    expect(banco.findMany).not.toHaveBeenCalled()
    expect(app.prisma.project.update).not.toHaveBeenCalled()
  })

  it('id de repositório já tomado por outro projeto: a entrega segue processada, sem estourar', async () => {
    // As duas colunas são únicas no banco. Uma corrida (duas entregas do mesmo
    // repositório ao mesmo tempo) faz a segunda gravação colidir. Colisão de
    // unicidade não pode derrubar a entrega: o casamento já aconteceu, a cura
    // era só um atalho.
    comProjetos([
      {
        id: 'proj_x',
        wingId: 'ana/api',
        githubInstallationId: null,
        githubRepoId: null,
        createdAt: NASCIMENTO,
      },
    ])
    app.prisma.project.update = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['github_repo_id'] },
      })
    )

    const res = await entrega(
      app,
      {
        action: 'opened',
        installation: { id: 777 },
        repository: { id: 1274419899, full_name: 'ana/api' },
      },
      'issues',
      'entrega_colisao'
    )

    expect(res.statusCode).toBe(200)
    expect(app.prisma.webhookDelivery.createMany).toHaveBeenCalled()
  })
})
