import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * TRANCA DE REGRESSÃO — 31/08.
 *
 * `app.ready(cb)` chamado DE DENTRO de um plugin boota o root do avvio. A partir daí todo
 * `app.get()` registrado depois estoura `AVV_ERR_ROOT_PLG_BOOTED` — e como `registerRoutes()`
 * roda DEPOIS de `registerPlugins()` em `buildApp()`, o processo morre no arranque, na primeira
 * rota (`healthRoutes`). Foi exatamente isso que o PR #394 introduziu em `plugins/telegram.ts`:
 * o serviço entrou em crash-loop e o site respondeu 502 no primeiro restart depois do merge.
 *
 * Por que NENHUM teste pegou: o trecho fica atrás de um guard `NODE_ENV === 'test'`, que retorna
 * antes em todo o CI. Config verde, produção morta — daí a regra virar uma varredura do FONTE,
 * que não depende do ambiente para valer.
 *
 * Quem precisa rodar algo depois do boot usa `app.addHook('onReady', ...)`: mesmo momento, sem
 * bootar o root.
 */
const DIR_PLUGINS = join(import.meta.dirname, '.')

function arquivosDePlugin(): string[] {
  return readdirSync(DIR_PLUGINS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

describe('nenhum plugin pode bootar o root do Fastify', () => {
  it('há plugins para varrer (a varredura não pode passar por estar vazia)', () => {
    expect(arquivosDePlugin().length).toBeGreaterThan(5)
  })

  it.each(arquivosDePlugin())('%s não chama app.ready(', (arquivo) => {
    const codigo = readFileSync(join(DIR_PLUGINS, arquivo), 'utf8')
    const semComentarios = codigo
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
    expect(semComentarios).not.toMatch(/\bapp\s*\.\s*ready\s*\(/)
  })
})
