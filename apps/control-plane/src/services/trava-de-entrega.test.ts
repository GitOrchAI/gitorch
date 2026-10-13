import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  criarTravaDeEntrega,
  decidirAvisoDeTravaEsquecida,
  HORAS_ATE_TRAVA_ESQUECIDA,
  type PrismaDaTrava,
} from './trava-de-entrega.js'

interface Linha {
  id: string
  ligada: boolean
  desde: Date | null
  motivo: string | null
  ligadaPor: string | null
}

/** Um "banco" de uma linha só, compartilhado entre instâncias do serviço. */
function bancoFalso(inicial?: Linha | null) {
  const estado: { linha: Linha | null; leituras: number; falhar: boolean } = {
    linha: inicial ?? null,
    leituras: 0,
    falhar: false,
  }
  const prisma: PrismaDaTrava = {
    travaDeEntrega: {
      async findUnique() {
        estado.leituras += 1
        if (estado.falhar) throw new Error('banco fora do ar')
        return estado.linha
      },
      async upsert(args) {
        if (estado.falhar) throw new Error('banco fora do ar')
        const base = estado.linha ?? {
          id: 'entrega',
          ligada: false,
          desde: null,
          motivo: null,
          ligadaPor: null,
        }
        estado.linha = { ...base, ...(estado.linha ? args.update : args.create) }
        return estado.linha
      },
    },
  }
  return { estado, prisma }
}

describe('trava de entrega: estado e idempotência', () => {
  it('sem linha no banco a trava está desligada', async () => {
    const { prisma } = bancoFalso()
    const trava = criarTravaDeEntrega(prisma)
    expect(await trava.estadoDaTrava()).toEqual({
      ligada: false,
      desde: null,
      motivo: null,
      ligadaPor: null,
    })
  })

  it('ligar grava ligada, desde, motivo e quem pediu', async () => {
    const { prisma } = bancoFalso()
    const agora = new Date('2030-01-01T10:00:00Z')
    const trava = criarTravaDeEntrega(prisma, { agora: () => agora.getTime() })
    const estado = await trava.ligarTrava({ motivo: 'troca de versão', por: 'entregador' })
    expect(estado).toEqual({
      ligada: true,
      desde: agora,
      motivo: 'troca de versão',
      ligadaPor: 'entregador',
    })
  })

  it('ligar duas vezes é idempotente e mantém o "desde" original', async () => {
    const { prisma } = bancoFalso()
    let t = new Date('2030-01-01T10:00:00Z').getTime()
    const trava = criarTravaDeEntrega(prisma, { agora: () => t })
    const primeiro = await trava.ligarTrava({ motivo: 'a', por: 'x' })
    t += 60_000
    const segundo = await trava.ligarTrava({ motivo: 'b', por: 'y' })
    expect(segundo.desde).toEqual(primeiro.desde)
    expect(segundo.motivo).toBe('a')
    expect(segundo.ligadaPor).toBe('x')
  })

  it('desligar limpa tudo; desligar de novo não muda nada', async () => {
    const { prisma } = bancoFalso()
    const trava = criarTravaDeEntrega(prisma)
    await trava.ligarTrava({ motivo: 'a', por: 'x' })
    const desligada = await trava.desligarTrava({ por: 'x' })
    expect(desligada).toEqual({ ligada: false, desde: null, motivo: null, ligadaPor: null })
    expect(await trava.desligarTrava({ por: 'x' })).toEqual(desligada)
  })

  it('sobrevive a um reinício: uma instância nova do serviço lê a trava do banco', async () => {
    const { prisma } = bancoFalso()
    await criarTravaDeEntrega(prisma).ligarTrava({ motivo: 'troca', por: 'entregador' })
    const depoisDoRestart = criarTravaDeEntrega(prisma)
    expect((await depoisDoRestart.estadoDaTrava()).ligada).toBe(true)
    expect(await depoisDoRestart.podeIniciarTrabalho()).toBe(false)
  })
})

describe('trava de entrega: guarda única podeIniciarTrabalho', () => {
  it('desligada: pode iniciar; ligada: não pode', async () => {
    const { prisma } = bancoFalso()
    let t = 0
    const trava = criarTravaDeEntrega(prisma, { agora: () => t })
    expect(await trava.podeIniciarTrabalho()).toBe(true)
    await trava.ligarTrava({ motivo: 'm', por: 'p' })
    expect(await trava.podeIniciarTrabalho()).toBe(false)
    await trava.desligarTrava({ por: 'p' })
    expect(await trava.podeIniciarTrabalho()).toBe(true)
    t += 1
  })

  it('usa cache curto: várias consultas seguidas leem o banco uma vez só', async () => {
    const { prisma, estado } = bancoFalso()
    let t = 1_000
    const trava = criarTravaDeEntrega(prisma, { agora: () => t, cacheMs: 1500 })
    await trava.podeIniciarTrabalho()
    await trava.podeIniciarTrabalho()
    t += 1000
    await trava.podeIniciarTrabalho()
    expect(estado.leituras).toBe(1)
    t += 600
    await trava.podeIniciarTrabalho()
    expect(estado.leituras).toBe(2)
  })

  it('FAIL-SAFE: sem conseguir ler a trava, NÃO inicia trabalho novo e avisa', async () => {
    const { prisma, estado } = bancoFalso()
    estado.falhar = true
    const onWarn = vi.fn()
    const trava = criarTravaDeEntrega(prisma, { onWarn })
    expect(await trava.podeIniciarTrabalho()).toBe(false)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]![0]).toMatch(/trava de entrega/i)
  })

  it('FAIL-SAFE: banco volta e o trabalho volta a iniciar depois do cache', async () => {
    const { prisma, estado } = bancoFalso()
    estado.falhar = true
    let t = 0
    const trava = criarTravaDeEntrega(prisma, { agora: () => t, cacheMs: 1000 })
    expect(await trava.podeIniciarTrabalho()).toBe(false)
    estado.falhar = false
    t += 1100
    expect(await trava.podeIniciarTrabalho()).toBe(true)
  })

  it('cliente de banco sem o modelo da trava (dublê de teste) não bloqueia nem avisa', async () => {
    const onWarn = vi.fn()
    const trava = criarTravaDeEntrega({} as unknown as PrismaDaTrava, { onWarn })
    expect(await trava.podeIniciarTrabalho()).toBe(true)
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('o modelo e a tabela existem de verdade: schema.prisma e a migração concordam', () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma')
    const schema = readFileSync(join(raiz, 'schema.prisma'), 'utf8')
    const sql = readFileSync(join(raiz, 'trava-de-entrega-migration.sql'), 'utf8')
    expect(schema).toMatch(/model TravaDeEntrega \{[\s\S]*?@@map\("trava_de_entrega"\)/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS trava_de_entrega/)
    for (const coluna of ['id', 'ligada', 'desde', 'motivo', 'ligada_por', 'updated_at']) {
      expect(sql).toContain(coluna)
    }
  })

  it('ligar e desligar invalidam o cache na hora', async () => {
    const { prisma } = bancoFalso()
    const trava = criarTravaDeEntrega(prisma, { agora: () => 5, cacheMs: 60_000 })
    expect(await trava.podeIniciarTrabalho()).toBe(true)
    await trava.ligarTrava({ motivo: 'm', por: 'p' })
    expect(await trava.podeIniciarTrabalho()).toBe(false)
  })
})

describe('aviso de trava esquecida', () => {
  const desde = new Date('2030-01-01T10:00:00Z')
  const horas = (h: number) => new Date(desde.getTime() + h * 3_600_000)

  it('o limite é de 2 horas', () => {
    expect(HORAS_ATE_TRAVA_ESQUECIDA).toBe(2)
  })

  it('desligada: nada a avisar e a marca é limpa', () => {
    const r = decidirAvisoDeTravaEsquecida({ desde: null, ultimoAviso: horas(5), agora: horas(6) })
    expect(r.deveAvisar).toBe(false)
    expect(r.novoUltimoAviso).toBeNull()
  })

  it('ligada há menos de 2 horas: silêncio', () => {
    const r = decidirAvisoDeTravaEsquecida({ desde, ultimoAviso: null, agora: horas(1.9) })
    expect(r.deveAvisar).toBe(false)
  })

  it('ligada há 2 horas: avisa UMA vez e marca', () => {
    const r = decidirAvisoDeTravaEsquecida({ desde, ultimoAviso: null, agora: horas(2) })
    expect(r.deveAvisar).toBe(true)
    expect(r.novoUltimoAviso).toEqual(horas(2))
    expect(r.horasLigada).toBe(2)
  })

  it('não repete a cada tique: só depois de outro período de 2 horas', () => {
    const marca = horas(2)
    expect(
      decidirAvisoDeTravaEsquecida({ desde, ultimoAviso: marca, agora: horas(3.5) }).deveAvisar
    ).toBe(false)
    const de_novo = decidirAvisoDeTravaEsquecida({ desde, ultimoAviso: marca, agora: horas(4) })
    expect(de_novo.deveAvisar).toBe(true)
    expect(de_novo.novoUltimoAviso).toEqual(horas(4))
  })
})
