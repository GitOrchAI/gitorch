import { describe, it, expect } from 'vitest'
import { projetoTemRepositorioValido } from './telegram.js'

/**
 * Fix-up (revisão) do defeito 4: dentro de `aoResponderDuvidaDoDev` (o
 * manipulador do prefixo `duvida-dev:`), o `comentarNaIssue` injetado em
 * `retomar-sessao-com-resposta.ts` buscava o projeto (`app.prisma.project.
 * findUnique`) e só validava `!projeto` — nunca `!projeto.wingId`. Um
 * projeto achado mas com `wingId` nulo/vazio (registro corrompido/legado)
 * seguia direto para `criarComentarNaIssue({ repository: projeto.wingId,
 * ... })`, montando `https://api.github.com/repos/<vazio>/issues/...` — uma
 * URL inválida que só estoura (com um erro confuso, 404 do GitHub) várias
 * chamadas depois, em vez de um aviso claro no ponto onde o dado já se
 * mostrou ruim.
 *
 * `projetoTemRepositorioValido` é o predicado extraído para ser testável
 * isoladamente (mesmo padrão de `criarComentarNaIssue`,
 * `parseDedupKeyDeDuvidaDoDev`) — sem montar o plugin Fastify inteiro.
 */
describe('projetoTemRepositorioValido', () => {
  it('projeto com wingId de verdade ("dono/repo"): válido', () => {
    expect(projetoTemRepositorioValido({ wingId: 'acme/api' })).toBe(true)
  })

  it('projeto inexistente (null): inválido', () => {
    expect(projetoTemRepositorioValido(null)).toBe(false)
  })

  it('projeto com wingId nulo: inválido — é EXATAMENTE o defeito medido (URL com "null")', () => {
    expect(projetoTemRepositorioValido({ wingId: null })).toBe(false)
  })

  it('projeto com wingId undefined: inválido', () => {
    expect(projetoTemRepositorioValido({ wingId: undefined })).toBe(false)
  })

  it('projeto com wingId vazio ou só espaço: inválido', () => {
    expect(projetoTemRepositorioValido({ wingId: '' })).toBe(false)
    expect(projetoTemRepositorioValido({ wingId: '   ' })).toBe(false)
  })
})
