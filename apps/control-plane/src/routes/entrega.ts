import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { travaDe, type EstadoDaTrava } from '../services/trava-de-entrega.js'
import type { AssistedLoginService } from '../services/assisted-login.js'

// Rotas INTERNAS do entregador (a ferramenta externa que troca a versão do
// produto). Servem para três coisas: ligar a trava de entrega, perguntar "ainda
// há trabalho em andamento?" e soltar a trava.
//
// PROTEÇÃO DUPLA e fechada por padrão. Qualquer falha de qualquer uma das duas
// responde 404, como se a rota não existisse, para não revelar a quem não é o
// chamador que ela está aqui:
//  1. a conexão vem do próprio computador (loopback) pelo ENDEREÇO REAL do
//     soquete. Não se usa `request.ip`: com proxy confiável ele vira o valor do
//     cabeçalho X-Forwarded-For, que o cliente controla. E como o proxy
//     reverso conversa com o serviço pelo próprio loopback, um pedido de
//     internet que atravessou o proxy também chega "do loopback" no soquete;
//     por isso um pedido com qualquer cabeçalho de encaminhamento é tratado
//     como de fora, mesmo vindo do loopback;
//  2. o cabeçalho X-Entrega-Token traz o segredo de serviço
//     (GITORCH_ENTREGA_TOKEN no ambiente), comparado em tempo constante. Sem a
//     variável definida (ou vazia) as rotas não existem.
//
// Ficam fora de `/api/`, então o login normal do painel não se aplica a elas.

const CABECALHO_DO_SEGREDO = 'x-entrega-token'
const CABECALHOS_DE_PROXY = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host']
const ENDERECOS_DE_LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Diagnóstico `running` sem atividade há mais que isso é restolho de um processo morto. */
const JANELA_DO_DIAGNOSTICO_VIVO_MS = 30 * 60 * 1000

declare module 'fastify' {
  interface FastifyInstance {
    /** Login assistido dos motores (registrado por plugins/engines.ts). */
    assistedLogin?: Pick<AssistedLoginService, 'contarAbertas'>
  }
}

const resumo = (texto: string): Buffer => createHash('sha256').update(texto).digest()

/** Comparação em tempo constante; o resumo iguala o tamanho dos dois lados. */
function segredoConfere(recebido: string, esperado: string): boolean {
  return timingSafeEqual(resumo(recebido), resumo(esperado))
}

function chamadorAutorizado(request: FastifyRequest): boolean {
  const esperado = process.env['GITORCH_ENTREGA_TOKEN']
  if (!esperado) return false
  const endereco = request.raw.socket.remoteAddress
  if (!endereco || !ENDERECOS_DE_LOOPBACK.has(endereco)) return false
  if (CABECALHOS_DE_PROXY.some((h) => request.headers[h] !== undefined)) return false
  const recebido = request.headers[CABECALHO_DO_SEGREDO]
  if (typeof recebido !== 'string' || recebido === '') return false
  return segredoConfere(recebido, esperado)
}

function serializarTrava(t: EstadoDaTrava) {
  return {
    ligada: t.ligada,
    desde: t.desde ? t.desde.toISOString() : null,
    motivo: t.motivo,
    ligadaPor: t.ligadaPor,
  }
}

export const entregaRoutes = async (app: FastifyInstance): Promise<void> => {
  const trava = () => travaDe(app.prisma, (m) => app.log.warn(m))

  const situacao = async () => {
    const t = await trava().estadoDaTrava()
    const vivo = new Date(Date.now() - JANELA_DO_DIAGNOSTICO_VIVO_MS)
    const [missoesRodando, missoesEsperando, diagnosticosRodando, sessoesDoDevVivas] =
      await Promise.all([
        app.prisma.mission.count({ where: { status: 'running' } }),
        app.prisma.mission.count({ where: { status: { in: ['pending', 'waiting'] } } }),
        app.prisma.diagnosisJob.count({ where: { status: 'running', updatedAt: { gte: vivo } } }),
        app.prisma.devSession.count({ where: { closedAt: null } }),
      ])
    const loginsAssistidosAbertos = app.assistedLogin?.contarAbertas() ?? 0
    // Missão `pending`/`waiting` não começou e fica na fila; a sessão do dev
    // assíncrono roda fora do servidor. Nenhuma das duas segura a troca.
    const podeTrocar =
      t.ligada && missoesRodando === 0 && diagnosticosRodando === 0 && loginsAssistidosAbertos === 0
    return {
      trava: serializarTrava(t),
      emAndamento: {
        missoesRodando,
        missoesEsperando,
        diagnosticosRodando,
        loginsAssistidosAbertos,
        sessoesDoDevVivas,
      },
      podeTrocar,
    }
  }

  const protegida =
    (acao: (request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!chamadorAutorizado(request)) return reply.callNotFound()
      try {
        return reply.send(await acao(request))
      } catch (err) {
        // Sem ler o estado de verdade não se afirma "pode trocar": 500 sem corpo útil.
        app.log.error(err, '[Entrega] falha ao atender o entregador')
        return reply
          .code(500)
          .send({ error: 'falha ao ler o estado da entrega', podeTrocar: false })
      }
    }

  app.get(
    '/interno/entrega',
    protegida(() => situacao())
  )

  app.post(
    '/interno/entrega/ligar',
    protegida(async (request) => {
      const corpo = (request.body ?? {}) as { motivo?: unknown; por?: unknown }
      const motivo =
        typeof corpo.motivo === 'string' && corpo.motivo.trim() !== ''
          ? corpo.motivo.trim().slice(0, 200)
          : 'troca de versão'
      const por =
        typeof corpo.por === 'string' && corpo.por.trim() !== ''
          ? corpo.por.trim().slice(0, 80)
          : 'entregador'
      await trava().ligarTrava({ motivo, por })
      return situacao()
    })
  )

  app.post(
    '/interno/entrega/desligar',
    protegida(async (request) => {
      const corpo = (request.body ?? {}) as { por?: unknown }
      const por =
        typeof corpo.por === 'string' && corpo.por.trim() !== ''
          ? corpo.por.trim().slice(0, 80)
          : 'entregador'
      await trava().desligarTrava({ por })
      return situacao()
    })
  )
}

export default entregaRoutes
