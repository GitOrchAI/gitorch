import { describe, it, expect, vi } from 'vitest'
import { REGUA_PADRAO } from '@gitorch/cadence'
import { registrarSePronto, paraTela, type DepsDoIncremento } from './incremento.js'
import { CAMPOS_VAZIOS } from './enriquecer-incremento.js'

// Os seis campos do desenho (D3): projeto (via projectId/relação) + issueNumber
// já eram gravados; os quatro que faltavam (sprint, título, peso, origem) mais
// wishCreatedAt/mergedAt vêm de `buscarCamposDoIncremento` (enriquecer-incremento.ts)
// e chegam aqui já prontos — este módulo só os repassa para `gravar`.
const CAMPOS_REAIS = {
  sprint: 'Sprint 3',
  titulo: 'A árvore aparece no painel',
  peso: 8,
  pedidoOuProativo: 'pedido' as const,
  wishCreatedAt: new Date('2026-08-20T09:00:00Z'),
  mergedAt: new Date('2026-08-25T18:00:00Z'),
}

const PRONTA = {
  projectId: 'proj_1',
  issueNumber: 42,
  pullRequestNumber: 7,
  mergeCommitSha: 'deadbeef',
  deployState: 'no-ar',
  envLastVerdict: 'no-ar',
  quemTocou: 'gitorch' as const,
  ...CAMPOS_REAIS,
}

function deps(over: Partial<DepsDoIncremento> = {}): DepsDoIncremento {
  return {
    lerRegua: vi.fn().mockResolvedValue(null),
    gravar: vi.fn().mockResolvedValue(undefined),
    jaRegistrado: vi.fn().mockResolvedValue(false),
    ...over,
  }
}

describe('registrarSePronto — só grava o que a régua deixa fechar', () => {
  it('entrega completa vira Incremento', async () => {
    const d = deps()
    const v = await registrarSePronto(d, PRONTA)
    expect(v.pronto).toBe(true)
    expect(d.gravar).toHaveBeenCalledTimes(1)
  })

  it('entrega mesclada mas NÃO no ar não grava, e diz por quê', async () => {
    const d = deps()
    const v = await registrarSePronto(d, { ...PRONTA, deployState: 'sem-publicacao' })
    expect(v.pronto).toBe(false)
    expect(v.porQueNaoFechou).toEqual(['foi mesclada, mas ainda não chegou ao ar'])
    expect(d.gravar).not.toHaveBeenCalled()
  })

  it('a régua DAQUELE projeto é quem manda', async () => {
    // O mesmo fato, dois projetos, dois resultados — que é o ponto de a régua
    // ser do cliente.
    const semAr = { ...PRONTA, deployState: 'sem-publicacao' }
    const exigente = deps()
    expect((await registrarSePronto(exigente, semAr)).pronto).toBe(false)

    const relaxado = deps({ lerRegua: vi.fn().mockResolvedValue({ no_ar: false }) })
    expect((await registrarSePronto(relaxado, semAr)).pronto).toBe(true)
    expect(relaxado.gravar).toHaveBeenCalledTimes(1)
  })

  it('a régua vai COPIADA para dentro do registro', async () => {
    // Sem isto, mudar a régua amanhã reescreveria a história: uma entrega de
    // ontem passaria a parecer que atendeu critérios que ninguém exigia dela.
    const d = deps({ lerRegua: vi.fn().mockResolvedValue({ ambiente_respondeu: true }) })
    await registrarSePronto(d, PRONTA)
    const gravado = (d.gravar as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(gravado.reguaAplicada).toEqual({ ...REGUA_PADRAO, ambiente_respondeu: true })
    expect(gravado.criterios).toContain('ambiente_respondeu')
  })

  it('D3: os seis campos do desenho chegam completos em gravar', async () => {
    // projeto (via projectId) · sprint · o que era (titulo) · quanto pesava
    // (peso) · quem tocou · pedido seu ou proativo — os seis do desenho.
    const d = deps()
    await registrarSePronto(d, PRONTA)
    const gravado = (d.gravar as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(gravado.projectId).toBe('proj_1')
    expect(gravado.sprint).toBe('Sprint 3')
    expect(gravado.titulo).toBe('A árvore aparece no painel')
    expect(gravado.peso).toBe(8)
    expect(gravado.quemTocou).toBe('gitorch')
    expect(gravado.pedidoOuProativo).toBe('pedido')
    expect(gravado.wishCreatedAt).toEqual(new Date('2026-08-20T09:00:00Z'))
    expect(gravado.mergedAt).toEqual(new Date('2026-08-25T18:00:00Z'))
  })

  it('D3: quando o enriquecimento não achou nada, grava os campos vazios — nunca inventa', async () => {
    const d = deps()
    await registrarSePronto(d, {
      ...PRONTA,
      ...CAMPOS_VAZIOS,
      quemTocou: 'gitorch' as const,
    })
    const gravado = (d.gravar as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(gravado.sprint).toBeNull()
    expect(gravado.titulo).toBeNull()
    expect(gravado.peso).toBeNull()
    expect(gravado.pedidoOuProativo).toBe('proativo')
    expect(gravado.wishCreatedAt).toBeNull()
  })

  it('o mesmo pedido NÃO vira dois Incrementos', async () => {
    // Contar a mesma entrega duas vezes daria ao dono um número que só cresce
    // e não quer dizer nada.
    const d = deps({ jaRegistrado: vi.fn().mockResolvedValue(true) })
    const v = await registrarSePronto(d, PRONTA)
    expect(v.pronto).toBe(true)
    expect(d.gravar).not.toHaveBeenCalled()
  })

  it('não consulta o registro quando nem passou na régua', async () => {
    // Uma consulta a menos no caminho quente do relógio, e a ordem certa: só
    // se pergunta "já registrei?" depois de saber que há o que registrar.
    const d = deps()
    await registrarSePronto(d, { ...PRONTA, mergeCommitSha: null })
    expect(d.jaRegistrado).not.toHaveBeenCalled()
  })

  it('régua guardada com lixo cai no padrão, não em permissão', async () => {
    const d = deps({ lerRegua: vi.fn().mockResolvedValue({ no_ar: 'sim', inventado: true }) })
    const v = await registrarSePronto(d, { ...PRONTA, deployState: 'falhou' })
    // 'sim' não desliga o critério: continua exigindo estar no ar.
    expect(v.pronto).toBe(false)
  })
})

describe('paraTela — o que falta chega escrito', () => {
  it('entrega pronta mostra a data e nada faltando', async () => {
    const v = await registrarSePronto(deps(), PRONTA)
    const t = paraTela({
      projeto: 'gitorch',
      pedido: 42,
      entrega: 7,
      veredito: v,
      prontoEm: new Date('2026-08-29T23:00:00Z'),
    })
    expect(t.pronto).toBe(true)
    expect(t.prontoEm).toBe('2026-08-29T23:00:00.000Z')
    expect(t.porQueNaoFechou).toEqual([])
    expect(t.atendidos).toContain('a publicação chegou ao ar')
  })

  it('entrega parada mostra o motivo e data nula', async () => {
    const v = await registrarSePronto(deps(), { ...PRONTA, deployState: 'falhou' })
    const t = paraTela({ projeto: 'gitorch', pedido: 42, entrega: 7, veredito: v, prontoEm: null })
    expect(t.pronto).toBe(false)
    expect(t.prontoEm).toBeNull()
    expect(t.porQueNaoFechou).toEqual(['foi mesclada, mas ainda não chegou ao ar'])
  })
})
