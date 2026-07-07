import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import fastifyCors from '@fastify/cors'
import { CORS_MAX_AGE } from '../config/constants.js'

const corsPluginImpl: FastifyPluginAsync = async (app) => {
  // Origens por CONFIG (CORS_ORIGIN: lista separada por vírgula; '*' libera) —
  // domínio hardcoded aqui já bloqueou frontend real em produção.
  const raw = process.env['CORS_ORIGIN'] ?? '*'
  const origin = raw.trim() === '*' ? true : raw.split(',').map((o) => o.trim())
  await app.register(fastifyCors, {
    origin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-GitHub-Delivery', 'X-Hub-Signature-256'],
    maxAge: CORS_MAX_AGE,
  })
}

// fp() é obrigatório aqui: sem ele, este plugin ganha seu próprio escopo
// encapsulado e o hook do @fastify/cors não escapa pra fora dele — todas as
// rotas IRMÃS registradas depois em registerPlugins (auth, engines, etc.)
// ficam sem cabeçalho CORS nenhum, quebrando toda chamada cross-origin real
// (achado ao vivo pelo /qa: sem isto, nem GET simples funcionava).
export const corsPlugin = fp(corsPluginImpl)
