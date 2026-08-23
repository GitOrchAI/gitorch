import { describe, expect, it } from 'vitest'
import { decidirSobreEntrega } from './entrega-repetida.js'

// O defeito que travou a prova ponta a ponta no primeiro passo.
//
// Reenvio NÃO é erro: é o comportamento normal do GitHub, e o campo único
// existe justamente para reconhecê-lo. Tratar a colisão como falha inverteu o
// propósito da guarda e transformou idempotência em queda — com HTTP 500, que
// faz o GitHub reenviar, que causa outro 500.

describe('decidirSobreEntrega', () => {
  it('nunca vista: processa', () => {
    expect(decidirSobreEntrega(null)).toEqual({ acao: 'processar' })
    expect(decidirSobreEntrega(undefined)).toEqual({ acao: 'processar' })
  })

  it('já vista e CONCLUÍDA: ignora — é reenvio comum do GitHub', () => {
    const d = decidirSobreEntrega({ processed: true })
    expect(d.acao).toBe('ignorar')
  })

  it('já vista e NÃO concluída: RETOMA — a tentativa anterior morreu no meio', () => {
    // Este é o caso que não pode ser ignorado. A linha é gravada ANTES de o
    // papel ser acordado; se a tentativa morrer nesse intervalo, ignorar o
    // reenvio perde a missão para sempre, e em silêncio — que é o pior
    // desfecho possível para quem acabou de fazer um pedido.
    const d = decidirSobreEntrega({ processed: false })
    expect(d.acao).toBe('retomar')
  })

  it('toda decisão que não processa DIZ o motivo', () => {
    // Pular calado é o defeito, não a solução: quem lê o log precisa saber a
    // diferença entre "ignorei porque já fiz" e "retomei porque não terminei".
    const ignorou = decidirSobreEntrega({ processed: true })
    const retomou = decidirSobreEntrega({ processed: false })
    expect(ignorou.acao === 'ignorar' && ignorou.motivo.length).toBeGreaterThan(10)
    expect(retomou.acao === 'retomar' && retomou.motivo.length).toBeGreaterThan(10)
  })
})
