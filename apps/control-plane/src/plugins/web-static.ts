import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import fastifyStatic from '@fastify/static'
import * as path from 'node:path'
import * as fs from 'node:fs'

// Serve o wizard estático (Next `output: 'export'`) PELA MESMA ORIGEM da API.
// Por quê: com o front no GitHub Pages e a API noutro domínio, o cookie de
// sessão é "third-party" e os navegadores modernos o bloqueiam — o login
// completa mas a sessão "some" na chamada seguinte. Servindo o front na mesma
// origem, o cookie httpOnly volta a ser first-party (seguro, sem token em
// localStorage). Dir do build via GITORCH_WEB_DIST (default ../web/out
// relativo ao cwd do serviço, que roda em apps/control-plane).
const webStaticPluginImpl: FastifyPluginAsync = async (app) => {
  const webDist = process.env['GITORCH_WEB_DIST'] ?? path.resolve(process.cwd(), '../web/out')

  // Ausência do build do front NÃO derruba a API: só registra o serving se o
  // index.html existir.
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    app.log.warn(`webStatic: ${path.join(webDist, 'index.html')} ausente; front não será servido`)
    return
  }

  // decorateReply:false — o @fastify/swagger-ui já registrou um @fastify/static
  // (que decora reply.sendFile); um segundo registro decorando de novo lançaria
  // FST_ERR_DEC_ALREADY_PRESENT. Servimos os assets pelo wildcard e as páginas
  // lendo o HTML direto.
  await app.register(fastifyStatic, {
    root: webDist,
    decorateReply: false,
  })

  // Next export gera `<rota>.html` (setup.html, painel.html); o index.html
  // cobre a raiz pelo wildcard. Mapeia as rotas de página → o HTML certo
  // (carregado uma vez no boot). Rotas exatas têm precedência sobre o wildcard.
  for (const page of ['setup', 'painel']) {
    const htmlPath = path.join(webDist, `${page}.html`)
    if (!fs.existsSync(htmlPath)) continue
    const content = fs.readFileSync(htmlPath, 'utf8')
    app.get(`/${page}`, (_req, reply) => reply.type('text/html').send(content))
  }
}

export const webStaticPlugin = fp(webStaticPluginImpl)
