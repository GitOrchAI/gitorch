import { describe, it, expect } from 'vitest'
import { dedupKeyDeRetomada, parseDedupKeyDeRetomada } from './dedup-key-de-retomada.js'

// C1 (fix-up L4-T5, CSO): a dedupKey de `retomarPrReprovado.perguntarAoDono`
// (plugins/scheduler.ts) incluía `retomadasAnteriores` — que MUDA a cada
// ciclo (é o próprio contador que a decisão observa). Como `ask()`
// (agent-question.ts) dedupa por `{projectId, dedupKey, status: 'answered'}`,
// uma chave que varia a cada ciclo nunca bate de novo: a resposta do dono a
// "retomado 3× — o que fazer?" fica órfã assim que o contador muda, e a
// PRÓXIMA escalada da MESMA PR pergunta de novo do zero, ignorando a decisão
// já tomada. A chave certa é estável por PR — igual ao padrão de
// `dedup-key-de-duvida.ts` (`duvida-dev:<repo>:<issue>:<hash>`).

describe('dedupKeyDeRetomada', () => {
  it('monta retomada-travada:<repo>:<pr>, estável entre ciclos', () => {
    const chave = dedupKeyDeRetomada({ repo: 'acme/api', prNumber: 3917 })
    expect(chave).toBe('retomada-travada:acme/api:3917')
    // A MESMA chave, não importa quantas vezes já foi retomado — é isso que
    // torna a resposta do dono achável de novo.
    expect(dedupKeyDeRetomada({ repo: 'acme/api', prNumber: 3917 })).toBe(chave)
  })

  it('repo sem "/" → lança (nunca monta chave quebrada em silêncio)', () => {
    expect(() => dedupKeyDeRetomada({ repo: 'acme-api', prNumber: 1 })).toThrow()
  })

  it('prNumber não inteiro positivo → lança', () => {
    expect(() => dedupKeyDeRetomada({ repo: 'acme/api', prNumber: 0 })).toThrow()
    expect(() => dedupKeyDeRetomada({ repo: 'acme/api', prNumber: -1 })).toThrow()
    expect(() => dedupKeyDeRetomada({ repo: 'acme/api', prNumber: 1.5 })).toThrow()
  })
})

describe('parseDedupKeyDeRetomada', () => {
  it('lê de volta repo e número do PR', () => {
    expect(parseDedupKeyDeRetomada('retomada-travada:acme/api:3917')).toEqual({
      repository: 'acme/api',
      prNumber: 3917,
    })
  })

  it('prefixo errado → null', () => {
    expect(parseDedupKeyDeRetomada('automacao:acme/api:wf:1')).toBeNull()
    expect(parseDedupKeyDeRetomada('duvida-dev:acme/api:1:abc')).toBeNull()
  })

  it('repo sem "/" → null (nunca inventa)', () => {
    expect(parseDedupKeyDeRetomada('retomada-travada:acme-api:1')).toBeNull()
  })

  it('número de PR não numérico → null', () => {
    expect(parseDedupKeyDeRetomada('retomada-travada:acme/api:abc')).toBeNull()
  })

  it('formato antigo com retomadasAnteriores no final → null (chave antiga não é adotada por engano)', () => {
    expect(parseDedupKeyDeRetomada('retomada-travada:acme/api:3917:2')).toBeNull()
  })

  it('ida e volta: dedupKeyDeRetomada -> parseDedupKeyDeRetomada', () => {
    const chave = dedupKeyDeRetomada({ repo: 'loureng/patinhas-3d-crafts', prNumber: 3917 })
    expect(parseDedupKeyDeRetomada(chave)).toEqual({
      repository: 'loureng/patinhas-3d-crafts',
      prNumber: 3917,
    })
  })
})
