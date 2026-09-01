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

  // D14, 01/09 — CASO REAL (tarefa #46 de GitOrchAI/gitorch): mesmo que o
  // modelo erre e marque precisaDoDono=true para "já está feito, o que
  // faço?", o freio determinístico de duvida-do-dev.ts reclassifica como
  // técnica e NUNCA acorda o dono.
  it('D14: mesmo com precisaDoDono=true do modelo, "já está feito" nunca acorda o dono', async () => {
    const perguntaReal =
      'However, looking at the code, the exact implementation for /wishlist is already present, ' +
      'as it was added in commit d175cb705b2b132fc11b1e175f9914a7916f12f2. Could you advise on ' +
      'what exactly needs to be done? Should I just open an empty PR to close the issue?'
    const execute = vi.fn(async () =>
      JSON.stringify({
        precisaDoDono: true, // o modelo erra, exatamente como ao vivo
        resposta: 'não tenho certeza se decido isso sozinho',
      })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, pergunta: perguntaReal, execute })

    expect(r.destino.tipo).toBe('escalar-ao-ra')
    expect(r.mensagemParaODev).toBeNull()
  })

  it('decisão de negócio de verdade: perguntaExecutivaPtBr/opcoesPtBr do modelo chegam no destino', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        precisaDoDono: true,
        resposta: 'Isso muda o que o cliente paga; quem decide é o dono.',
        perguntaExecutivaPtBr: 'A funcionalidade de wishlist deve ser grátis ou paga?',
        opcoesPtBr: [
          { label: 'Grátis para todos', value: 'gratis' },
          { label: 'Só para pagantes', value: 'pago' },
        ],
      })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(r.destino.tipo).toBe('perguntar-ao-dono')
    if (r.destino.tipo === 'perguntar-ao-dono') {
      expect(r.destino.perguntaExecutiva).toBe(
        'A funcionalidade de wishlist deve ser grátis ou paga?'
      )
      expect(r.destino.opcoes).toHaveLength(2)
    }
    // Nunca escreve nada na sessão do dev quando sobe para o dono.
    expect(r.mensagemParaODev).toBeNull()
  })

  it('decisão de negócio sem tradução do modelo: destino não inventa perguntaExecutiva', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        precisaDoDono: true,
        resposta: 'Isso muda o que o cliente paga; quem decide é o dono.',
      })
    )

    const r = await runDuvidaMissionViaRails({ ...BASE, execute })

    expect(r.destino.tipo).toBe('perguntar-ao-dono')
    if (r.destino.tipo === 'perguntar-ao-dono') {
      expect(r.destino.perguntaExecutiva).toBeUndefined()
      expect(r.destino.opcoes).toBeUndefined()
    }
  })
})
