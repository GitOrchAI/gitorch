import { describe, it, expect, vi } from 'vitest'
import { runDuvidaMissionViaRails } from './duvida-rails-mission.js'

const BASE = {
  pergunta: 'Devo usar bcrypt ou argon2 para o hash de senha?',
  repository: 'acme/api',
  issueNumber: 7,
  contextBlocks: ['codegraph aqui'],
}

describe('runDuvidaMissionViaRails', () => {
  it('resposta técnica boa vira mensagem pronta para a sessão do dev', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        precisaDoDono: false,
        resposta:
          'Use argon2id: já está em package.json e o helper vive em src/lib/hash.ts, usado no login.',
      })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(r.destino.tipo).toBe('responder-o-dev')
    expect(r.mensagemParaODev).toContain('argon2id')
    expect(r.mensagemParaODev).toContain('src/lib/hash.ts')
  })

  it('decisão de negócio NÃO vira mensagem — sobe para o dono', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        precisaDoDono: true,
        resposta: 'Isso muda o que o cliente paga; quem decide é o dono.',
      })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(r.destino.tipo).toBe('perguntar-ao-dono')
    // O ponto que não pode falhar: nada é escrito na sessão do dev.
    expect(r.mensagemParaODev).toBeNull()
  })

  it('agente que não soube: nada é mandado ao dev, e escala ao RA (T14), não direto ao dono', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({ precisaDoDono: false, resposta: 'Não sei responder isso.' })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(r.destino.tipo).toBe('escalar-ao-ra')
    expect(r.mensagemParaODev).toBeNull()
  })

  it('a pergunta do dev vai INTEIRA no prompt — responder outra coisa não ajuda ninguém', async () => {
    const prompts: string[] = []
    const execute = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return JSON.stringify({
        precisaDoDono: false,
        resposta: 'Use argon2id, o helper já existe em src/lib/hash.ts e é usado no login.',
      })
    })

    await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(prompts[0]).toContain(BASE.pergunta)
    // E o contexto do trabalho, para a resposta ser sobre ESTA tarefa.
    expect(prompts[0]).toContain('#7')
  })
})
