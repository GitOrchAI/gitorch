import { test, expect, describe, vi } from 'vitest'
import { garantirSprintDosProjetos } from './garantir-sprint-dos-projetos.js'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'

/* eslint-disable @typescript-eslint/no-explicit-any */

const projeto = (over: Record<string, any> = {}) => ({
  id: 'p1',
  name: 'gitorch',
  wingId: 'GitOrchAI/gitorch',
  autonomia: 'cuidar',
  sprintDias: null,
  ...over,
})

/** As dependências que o serviço recebe — todas injetadas, nada global. */
function deps(over: Record<string, any> = {}) {
  return {
    listarProjetos: vi.fn().mockResolvedValue([projeto()]),
    credencialDoProjeto: vi.fn().mockResolvedValue({ token: 'tok', origem: 'app' as const }),
    quadroDoProjeto: vi
      .fn()
      .mockResolvedValue({ acao: 'usar', quadro: { id: 'PVT_1', title: 'q' } }),
    garantir: vi.fn().mockResolvedValue({ estado: 'criado', fieldId: 'f1', motivo: 'criei' }),
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...over,
  }
}

describe('garantirSprintDosProjetos', () => {
  test('o caminho de produção CHAMA a garantia — o defeito era ela ser órfã', async () => {
    // Até 30/08/2026 garantirSprintNoQuadro existia, era testada e NENHUM
    // caminho de produção a chamava. O campo Sprint nunca nascia e o painel
    // dizia "sem sprint" para sempre. Este teste existe para que isso não
    // volte a acontecer em silêncio.
    const d = deps()
    const r = await garantirSprintDosProjetos(d as any)

    expect(d.garantir).toHaveBeenCalledTimes(1)
    expect(r.resultados[0]).toMatchObject({ projeto: 'gitorch', estado: 'criado' })
  })

  test('a duração é a DO CLIENTE quando ele escolheu', async () => {
    const d = deps({ listarProjetos: vi.fn().mockResolvedValue([projeto({ sprintDias: 14 })]) })
    await garantirSprintDosProjetos(d as any)
    expect(d.garantir.mock.calls[0]![1]).toMatchObject({ duracaoEmDias: 14 })
  })

  test('sem escolha, vale o padrão do produto (3)', async () => {
    const d = deps()
    await garantirSprintDosProjetos(d as any)
    expect(d.garantir.mock.calls[0]![1]).toMatchObject({ duracaoEmDias: 3 })
  })

  test('"só olhar" NÃO escreve no quadro do cliente', async () => {
    // A guarda tem que barrar ANTES de qualquer escrita: recusar no meio
    // deixaria o quadro do cliente pela metade.
    const d = deps({
      listarProjetos: vi.fn().mockResolvedValue([projeto({ autonomia: 'so_olhar' })]),
      garantir: vi
        .fn()
        .mockRejectedValue(
          new EscritaNaoAutorizadaError('organizar', 'so_olhar', 'sugerir', 'nível não permite')
        ),
    })

    const r = await garantirSprintDosProjetos(d as any)

    expect(r.resultados[0]).toMatchObject({ projeto: 'gitorch', estado: 'recusado' })
    expect(r.resultados[0]?.motivo).toContain('nível')
  })

  test('projeto sem credencial é DITO, não silenciado', async () => {
    const d = deps({ credencialDoProjeto: vi.fn().mockResolvedValue(null) })
    const r = await garantirSprintDosProjetos(d as any)

    expect(d.garantir).not.toHaveBeenCalled()
    expect(r.resultados[0]).toMatchObject({ estado: 'sem_credencial' })
  })

  test('quadro que não dá para usar não vira sprint inventada', async () => {
    // 'criar', 'escolher' e 'sem_acesso' são respostas legítimas que NÃO dão
    // um quadro certo — inventar um aqui seria pior que não fazer nada.
    for (const acao of ['criar', 'escolher', 'sem_acesso']) {
      const d = deps({ quadroDoProjeto: vi.fn().mockResolvedValue({ acao, motivo: 'x' }) })
      const r = await garantirSprintDosProjetos(d as any)
      expect(d.garantir, `acao=${acao}`).not.toHaveBeenCalled()
      expect(r.resultados[0]?.estado, `acao=${acao}`).toBe('sem_quadro')
    }
  })

  test('um projeto que falha NÃO derruba os outros', async () => {
    const d = deps({
      listarProjetos: vi
        .fn()
        .mockResolvedValue([projeto({ name: 'a' }), projeto({ id: 'p2', name: 'b' })]),
      garantir: vi
        .fn()
        .mockRejectedValueOnce(new Error('502 do GraphQL'))
        .mockResolvedValueOnce({ estado: 'ja_pronto', fieldId: 'f', iteracoes: 2, motivo: 'ok' }),
    })

    const r = await garantirSprintDosProjetos(d as any)

    expect(r.resultados).toHaveLength(2)
    expect(r.resultados[0]?.estado).toBe('falhou')
    expect(r.resultados[1]?.estado).toBe('ja_pronto')
  })

  test('quadro de conta pessoal: diz a saída, não um "falhou" genérico', async () => {
    // O App do produto não enxerga quadro de conta pessoal — permissão que ele
    // não tem e nunca vai ter. Chamar isso de falha mandaria alguém procurar um
    // defeito inexistente e esconderia do dono a única coisa que resolve.
    const d = deps({
      garantir: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub GraphQL request failed: Resource not accessible by integration')
        ),
    })

    const r = await garantirSprintDosProjetos(d as any)

    expect(r.resultados[0]?.estado).toBe('sem_credencial')
    expect(r.resultados[0]?.motivo).toContain('conta pessoal')
    expect(r.resultados[0]?.motivo).toContain('sua própria credencial')
    // Não polui o log de avisos: não é defeito nosso.
    expect(d.log.warn).not.toHaveBeenCalled()
  })

  test('idempotente: quadro já pronto não é tocado', async () => {
    const d = deps({
      garantir: vi.fn().mockResolvedValue({
        estado: 'ja_pronto',
        fieldId: 'f1',
        iteracoes: 3,
        motivo: 'já tinha',
      }),
    })
    const r = await garantirSprintDosProjetos(d as any)
    expect(r.resultados[0]?.estado).toBe('ja_pronto')
  })

  test('em série, nunca em paralelo', async () => {
    // Dois projetos do mesmo dono compartilham a credencial. Em paralelo, uma
    // renovação de token no meio da outra derruba as duas — foi o defeito que
    // matou a conta do Codex em 26/08.
    const ordem: string[] = []
    const d = deps({
      listarProjetos: vi
        .fn()
        .mockResolvedValue([projeto({ name: 'a' }), projeto({ id: 'p2', name: 'b' })]),
      garantir: vi.fn().mockImplementation(async (_c: unknown, args: any) => {
        ordem.push('entrou:' + args.projectId)
        await new Promise((r) => setTimeout(r, 5))
        ordem.push('saiu:' + args.projectId)
        return { estado: 'criado', fieldId: 'f', motivo: 'ok' }
      }),
    })

    await garantirSprintDosProjetos(d as any)

    // Se fosse paralelo, os dois "entrou" viriam antes dos "saiu".
    expect(ordem[0]).toMatch(/^entrou:/)
    expect(ordem[1]).toMatch(/^saiu:/)
  })
})
