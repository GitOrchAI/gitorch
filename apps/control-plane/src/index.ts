import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import Fastify, { FastifyInstance } from 'fastify'
import { loadEnv } from './config/env.js'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'
import { webStaticPlugin } from './plugins/web-static.js'
import {
  conferirBancoNoArranque,
  notificadorDaInstancia,
  type PrismaParaConferencia,
} from './services/banco-atrasado.js'

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    // Confiar SÓ no peer local (não uma CONTAGEM de hops — achado FW-3): com
    // `trustProxy: 1` (contagem), o Fastify confia cegamente na ÚLTIMA
    // entrada de X-Forwarded-For não importa QUEM conectou na porta — ou
    // seja, qualquer processo que alcance a porta da API DIRETAMENTE (outro
    // processo na mesma VM compartilhada, qualquer peer da rede privada),
    // pulando o Funnel de propósito, escreve seu próprio X-Forwarded-For e o
    // Fastify confia do mesmo jeito. Uma LISTA de peers confiáveis
    // (loopback, onde o Funnel roda de verdade) muda a pergunta de "quantos
    // hops confio" pra "de QUEM eu aceito X-Forwarded-For": só quando o
    // socket que conectou é loopback é que o cabeçalho é lido; de qualquer
    // outro peer, `request.ip` é o peer real, cabeçalho ignorado por
    // completo. Isso fecha (a) o mesmo contorno do rate limit girando o
    // header que o achado I1 original documentava, e (b)
    // `X-Forwarded-For: 127.0.0.1` cair na allowlist padrão e ficar isento —
    // derrubando também o limitador de brute-force do login, que esta
    // branch passou a depender de `request.ip`.
    trustProxy: env.GITORCH_TRUST_PROXY ? ['127.0.0.1', '::1'] : false,
    logger: env.LOG_PRETTY
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss Z' },
          },
        }
      : { level: env.LOG_LEVEL },
    ajv: {
      customOptions: { strict: true, coerceTypes: 'array' },
    },
  })

  await registerPlugins(app, env)
  await registerRoutes(app)
  // Depois das rotas de API: serve o wizard estático na MESMA origem (rotas
  // exatas de /api já registradas têm precedência sobre o wildcard do estático).
  await app.register(webStaticPlugin)

  return app
}

async function start(): Promise<void> {
  const env = loadEnv()
  const app = await buildApp()

  try {
    await app.listen({ port: env.PORT, host: env.HOST })
    app.log.info(`Server listening on ${env.HOST}:${env.PORT}`)
    // O banco está em dia com o código? Em 26/08 uma migração não aplicada
    // deixou a esteira 80 minutos morta, com o erro estourando de minuto em
    // minuto num journal que ninguém lê. Best-effort e nunca derruba o
    // arranque: subir calado foi o defeito, subir gritando é o conserto —
    // recusar subir trocaria uma falha silenciosa por uma queda total (a API,
    // os webhooks e o assistente funcionam mesmo com uma coluna faltando).
    void conferirBancoNoArranque({
      prisma: app.prisma as unknown as PrismaParaConferencia,
      avisar: notificadorDaInstancia(),
      log: { warn: (m) => app.log.warn(m), info: (m) => app.log.info(m) },
    }).catch(() => undefined)
    app.log.info(`Documentation available at http://${env.HOST}:${env.PORT}/docs`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down gracefully...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Guarda de entrypoint (achado M2, corrigido no achado FW-1): só sobe o
// servidor de verdade quando este arquivo é executado DIRETAMENTE (tsx/node
// em src|dist/index.*) — nunca quando é só IMPORTADO (ex.: um teste de seam
// real chamando buildApp() pra provar o wiring de trustProxy/allowList sem
// reimplementá-lo à parte). Sem isto, importar este módulo já dispara
// `start()` como efeito colateral: tenta ouvir porta e conectar
// Postgres/Redis reais dentro da suíte de teste.
//
// A comparação original (`import.meta.url === \`file://${process.argv[1]}\``)
// comparava uma URL contra uma CONCATENAÇÃO DE STRING crua — quebra em dois
// casos reais de produção: (1) `import.meta.url` é o REALPATH (Node resolve
// symlinks pro módulo principal), então rodar via `current/dist/index.js`
// (o padrão de deploy desta VM: symlink `current -> releases/<sha>` trocado
// atomicamente) nunca bate contra `file://.../releases/<sha>/dist/index.js`;
// (2) `import.meta.url` é percent-encoded (espaço vira `%20`), a
// concatenação crua não. Nos dois casos o guard decidia (errado) que este
// módulo não era o entrypoint, `start()` nunca era chamado, e o processo
// simplesmente chegava ao fim do módulo e saía com exit 0 — sem ouvir porta
// nenhuma, sem logar UMA linha sequer. systemd via "sucesso". O sintoma real
// seria só "nada responde na porta", debugado às cegas.
//
// Correção: resolve `argv[1]` pelo caminho REAL (`realpathSync`, segue
// symlink) e converte pro MESMO formato de URL que `import.meta.url` usa
// (`pathToFileURL`, mesmo encoding) antes de comparar — é o padrão que a
// própria documentação do Node recomenda pra detectar "sou o módulo
// principal" em ESM. Escolhida em vez de mover `start()` pra um módulo
// separado (a outra opção do achado FW-1) porque é uma mudança de UMA linha
// contida em index.ts — não exige tocar Dockerfile/systemd/CI, que já
// invocam `node dist/index.js` diretamente em 4 lugares.
function resolveIsMainModule(): boolean {
  const invokedPath = process.argv[1]
  if (invokedPath === undefined) return false
  try {
    return pathToFileURL(realpathSync(invokedPath)).href === import.meta.url
  } catch (err) {
    // argv[1] não resolve pra um arquivo real (ex.: REPL, `node -e`, um
    // caminho apagado entre o spawn e este ponto) — não há como prometer que
    // isto é o entrypoint principal. Nunca fica silencioso: se isto
    // acontecer numa invocação real de produção, este log é o ÚNICO sinal de
    // que o servidor não subiu.
    console.error(
      `[index.ts] guarda de entrypoint: falha ao resolver argv[1]="${invokedPath}" — servidor NÃO iniciado: ${String(err)}`
    )
    return false
  }
}

const isMainModule = resolveIsMainModule()
if (isMainModule) {
  start()
} else if (process.env['NODE_ENV'] !== 'test') {
  // Nunca silencioso (achado FW-1): fora de teste, todo import deste módulo
  // que NÃO dispara start() deixa rastro — é exatamente o log que faltava
  // pra depurar um "systemd diz sucesso, porta nunca abre" em produção.
  console.error(
    `[index.ts] módulo carregado mas NÃO como entrypoint principal — servidor NÃO iniciado. argv[1]=${process.argv[1] ?? '<undefined>'} import.meta.url=${import.meta.url}`
  )
}
