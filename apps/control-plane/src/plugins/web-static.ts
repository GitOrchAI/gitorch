import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import fastifyStatic from '@fastify/static'
import * as path from 'node:path'
import * as fs from 'node:fs'

// Cache-Control do HTML servido pelo front estático: `no-cache` (sempre
// revalida), porque o HTML aponta pra chunks hasheados que um deploy troca —
// reter um HTML velho pede chunks inexistentes e trava o app. `null` = não é
// HTML, deixa o default do @fastify/static. Pura pra testar sem subir servidor.
export function cacheControlFor(filePath: string): string | null {
  return filePath.endsWith('.html') ? 'no-cache' : null
}

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
  //
  await app.register(fastifyStatic, {
    root: webDist,
    decorateReply: false,
  })

  // Next export gera `<rota>.html` (setup.html, painel.html); o index.html
  // cobre a raiz pelo wildcard. Mapeia as rotas de página → o HTML certo
  // (carregado uma vez no boot). Rotas exatas têm precedência sobre o wildcard.
  //
  // Cache: o HTML aponta para chunks Next versionados por HASH no nome
  // (`_next/static/chunks/<hash>.js`); um deploy gera hashes novos e apaga os
  // antigos. Se o navegador retiver um HTML de página antigo (cache heurístico/
  // bfcache — a resposta não trazia diretiva nenhuma), ele pede chunks que já
  // não existem e o app congela num passo (bug real do dono 20/07: preso em
  // "Preparando seu ambiente…" com bundle velho após vários redeploys no dia).
  // Por isso a PÁGINA vem com `no-cache` (revalida sempre → um redeploy é visto
  // na próxima navegação, sem hard-refresh). Os chunks já saem com cache-control
  // do @fastify/static e têm hash no nome, então não sofrem do mesmo problema.
  for (const page of ['setup', 'painel']) {
    const htmlPath = path.join(webDist, `${page}.html`)
    if (!fs.existsSync(htmlPath)) continue
    const content = fs.readFileSync(htmlPath, 'utf8')
    app.get(`/${page}`, (_req, reply) =>
      reply.type('text/html').header('Cache-Control', cacheControlFor(htmlPath)!).send(content)
    )
  }
}

export const webStaticPlugin = fp(webStaticPluginImpl)
