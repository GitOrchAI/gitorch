import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { webStaticPlugin, cacheControlFor } from './web-static.js'

/**
 * O HTML do wizard aponta pra chunks Next versionados por hash; um deploy gera
 * hashes novos e apaga os velhos. Se o navegador retiver um HTML antigo, ele
 * pede chunks inexistentes e o app trava (bug real do dono 20/07: preso em
 * "Preparando seu ambiente…" com bundle velho após vários redeploys no dia).
 * Contrato: HTML NUNCA cacheia sem revalidar (no-cache); assets hasheados
 * (_next/static) são imutáveis e cacheiam longo.
 */
describe('cacheControlFor — política de cache por arquivo', () => {
  it('HTML de página => no-cache (sempre revalida)', () => {
    expect(cacheControlFor('/x/setup.html')).toBe('no-cache')
    expect(cacheControlFor('/x/index.html')).toBe('no-cache')
  })
  it('outros arquivos => sem diretiva explícita', () => {
    expect(cacheControlFor('/x/favicon.ico')).toBeNull()
  })
})

describe('webStaticPlugin — rota de página serve o HTML com no-cache', () => {
  let dir: string
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-static-test-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>root</html>')
    fs.writeFileSync(path.join(dir, 'setup.html'), '<html>setup</html>')
    process.env['GITORCH_WEB_DIST'] = dir
    app = Fastify()
    await app.register(webStaticPlugin)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env['GITORCH_WEB_DIST']
  })

  it('/setup vem 200 com Cache-Control: no-cache (mata o bundle-velho do dono)', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('setup')
  })
})
