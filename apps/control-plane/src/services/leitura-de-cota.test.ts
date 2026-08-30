import { describe, expect, it } from 'vitest'
import {
  carimboDaLeitura,
  lerCotaDoMotor,
  temNumeroDeCota,
  percentualAindaVale,
} from './leitura-de-cota.js'

describe('leitura de cota', () => {
  it('leitor que devolve tudo nulo NÃO passa por leitura feita (o caso real dos 2 motores)', async () => {
    const cota = await lerCotaDoMotor({
      runtime: 'codex',
      ler: async () => ({ remaining: null, total: null }),
      home: '/tmp/x',
    })
    expect(cota.temNumero).toBe(false)
    expect(cota.motivo).toContain('não devolveu número nenhum')
  })

  it('o carimbo de leitura NÃO é gravado quando não houve número — era a mentira do dado', async () => {
    // quota_refreshed_at recente dizia "li a cota às 20:26" tendo lido nada.
    const cota = await lerCotaDoMotor({
      runtime: 'antigravity',
      ler: async () => ({ remaining: null, total: null }),
      home: '/tmp/x',
    })
    expect(carimboDaLeitura(cota, new Date())).toEqual({})
  })

  it('leitura com número: carimba e não tem motivo', async () => {
    const agora = new Date('2026-08-27T00:00:00Z')
    const cota = await lerCotaDoMotor({
      runtime: 'codex',
      ler: async () => ({ remaining: 10, total: 100 }),
      home: '/tmp/x',
    })
    expect(cota.temNumero).toBe(true)
    expect(cota.motivo).toBeNull()
    expect(carimboDaLeitura(cota, agora)).toEqual({ quotaRefreshedAt: agora })
  })

  it('leitor que explode devolve o MOTIVO, não um nulo mudo', async () => {
    const cota = await lerCotaDoMotor({
      runtime: 'antigravity',
      ler: async () => {
        throw new Error('a tela do CLI não abriu')
      },
      home: '/tmp/x',
    })
    expect(cota.temNumero).toBe(false)
    expect(cota.motivo).toContain('a tela do CLI não abriu')
  })

  it('motor sem leitor diz isso, em vez de fingir leitura vazia', async () => {
    const cota = await lerCotaDoMotor({ runtime: 'inventado', ler: undefined, home: '/tmp/x' })
    expect(cota.motivo).toContain('não há leitor de cota')
  })

  it('só a janela de percentual já conta como número (Claude/Codex não têm remaining)', () => {
    expect(temNumeroDeCota({ remaining: null, total: null, sessionPercentUsed: 42 })).toBe(true)
    expect(temNumeroDeCota({ remaining: null, total: null, weekPercentUsed: 7 })).toBe(true)
    expect(temNumeroDeCota({ remaining: null, total: null })).toBe(false)
  })

  it('nunca falha calado: sem número SEMPRE há motivo', async () => {
    for (const ler of [
      undefined,
      async () => ({ remaining: null, total: null }),
      async () => {
        throw new Error('x')
      },
    ]) {
      const cota = await lerCotaDoMotor({ runtime: 'codex', ler, home: '/tmp/x' })
      if (!cota.temNumero) expect(cota.motivo).toBeTruthy()
    }
  })
})

describe('percentualAindaVale — número de janela vencida é desconhecido, não fato', () => {
  // MEDIDO em 30/08: o banco guardava "semana 99% usada" para o Claude, lido 45
  // horas antes, com as duas janelas já viradas. A leitura feita na hora deu
  // 24%. Erro de 75 pontos percentuais, exibido com cara de fato.
  const agora = new Date('2026-08-30T00:00:00Z')

  it('janela que ainda vale devolve o número', () => {
    expect(percentualAindaVale(24, '2026-09-05T06:00:00Z', agora)).toBe(24)
  })

  it('janela JÁ VIRADA devolve null — o número morreu junto com ela', () => {
    expect(percentualAindaVale(99, '2026-08-29T06:00:00Z', agora)).toBeNull()
  })

  it('sem horário de virada NÃO dá para afirmar que ainda vale', () => {
    // Não é pessimismo: sem a virada, não há como saber se o número
    // sobreviveu. Servir mesmo assim é apostar.
    expect(percentualAindaVale(50, null, agora)).toBeNull()
  })

  it('percentual ausente continua ausente', () => {
    expect(percentualAindaVale(null, '2026-09-05T06:00:00Z', agora)).toBeNull()
  })

  it('data ilegível não vira número válido', () => {
    expect(percentualAindaVale(50, 'ontem', agora)).toBeNull()
  })

  it('zero por cento é um número de verdade, não ausência', () => {
    // 0% usado é informação: a janela acabou de virar e está limpa.
    expect(percentualAindaVale(0, '2026-09-05T06:00:00Z', agora)).toBe(0)
  })
})
