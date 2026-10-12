import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// O dono não acompanha issue nem PR no GitHub. Comentário que lhe pede para
// "conferir e fechar" a tarefa fica sem resposta para sempre e a tarefa para
// com ele. A suspeita agora é decidida pelo produto (suspeita-de-tarefa-
// resolvida.ts); este teste falha se o texto antigo voltar a ser publicado.

const ler = (relativo: string): string =>
  readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8')

const PEDIDOS_PROIBIDOS = [
  'Confira e feche a issue',
  'remova esta suspeita',
  'gitorch:possivelmente-ja-resolvida',
]

describe('a suspeita de tarefa já resolvida não pede nada ao dono em comentário', () => {
  it.each([
    ['plugins/scheduler.ts', '../plugins/scheduler.ts'],
    ['services/sm-delegation.ts', './sm-delegation.ts'],
    ['services/suspeita-de-tarefa-resolvida.ts', './suspeita-de-tarefa-resolvida.ts'],
  ])('%s não publica o texto antigo', (_nome, caminho) => {
    const codigo = ler(caminho)
    for (const proibido of PEDIDOS_PROIBIDOS) {
      expect(codigo, proibido).not.toContain(proibido)
    }
  })
})
