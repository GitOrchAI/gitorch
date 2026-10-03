import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TelaRepositorio } from './TelaRepositorio'
import * as usePainelBuscaModulo from './usePainelBusca'
import * as painelProjetoModulo from './painel-projeto'
import { ROTAS } from './painel-api'

describe('TelaRepositorio (GITORCH-REPO-T3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('anexa filtroDeProjeto(projeto) à rota quando há projeto selecionado', () => {
    vi.spyOn(painelProjetoModulo, 'projetoAtual').mockReturnValue('gitorch')
    vi.spyOn(painelProjetoModulo, 'projetoNoServidor').mockReturnValue('gitorch')

    const usePainelBuscaSpy = vi.spyOn(usePainelBuscaModulo, 'usePainelBusca').mockReturnValue({
      estado: 'ok',
      dados: {
        itens: [
          {
            tipo: 'pr',
            numero: 42,
            origem: 'github',
            proximoPasso: 'Aguardando review',
            projeto: 'gitorch',
          },
        ],
      },
      recarregar: vi.fn(),
    })

    renderToStaticMarkup(<TelaRepositorio />)

    expect(usePainelBuscaSpy).toHaveBeenCalledWith(
      `${ROTAS.repositorio}?projeto=gitorch`,
      expect.any(Object)
    )
  })

  it('chama a rota sem query param quando projeto é null (Todos os projetos)', () => {
    vi.spyOn(painelProjetoModulo, 'projetoAtual').mockReturnValue(null)
    vi.spyOn(painelProjetoModulo, 'projetoNoServidor').mockReturnValue(null)

    const usePainelBuscaSpy = vi.spyOn(usePainelBuscaModulo, 'usePainelBusca').mockReturnValue({
      estado: 'ok',
      dados: {
        itens: [
          {
            tipo: 'issue',
            numero: 10,
            origem: 'telegram',
            proximoPasso: 'Planejamento',
            projeto: 'patinhas',
          },
        ],
      },
      recarregar: vi.fn(),
    })

    renderToStaticMarkup(<TelaRepositorio />)

    expect(usePainelBuscaSpy).toHaveBeenCalledWith(ROTAS.repositorio, expect.any(Object))
  })

  it('renderiza o chip com pn-chip exibindo item.projeto quando em modo "Todos os projetos"', () => {
    vi.spyOn(painelProjetoModulo, 'projetoAtual').mockReturnValue(null)
    vi.spyOn(painelProjetoModulo, 'projetoNoServidor').mockReturnValue(null)

    vi.spyOn(usePainelBuscaModulo, 'usePainelBusca').mockReturnValue({
      estado: 'ok',
      dados: {
        itens: [
          {
            tipo: 'issue',
            numero: 99,
            origem: 'jira',
            proximoPasso: 'Implementar',
            projeto: 'alpha-corp',
          },
        ],
      },
      recarregar: vi.fn(),
    })

    const html = renderToStaticMarkup(<TelaRepositorio />)

    expect(html).toContain('pn-chip')
    expect(html).toContain('alpha-corp')
  })

  it('NÃO renderiza o chip do projeto quando um projeto específico está selecionado', () => {
    vi.spyOn(painelProjetoModulo, 'projetoAtual').mockReturnValue('alpha-corp')
    vi.spyOn(painelProjetoModulo, 'projetoNoServidor').mockReturnValue('alpha-corp')

    vi.spyOn(usePainelBuscaModulo, 'usePainelBusca').mockReturnValue({
      estado: 'ok',
      dados: {
        itens: [
          {
            tipo: 'issue',
            numero: 99,
            origem: 'jira',
            proximoPasso: 'Implementar',
            projeto: 'alpha-corp',
          },
        ],
      },
      recarregar: vi.fn(),
    })

    const html = renderToStaticMarkup(<TelaRepositorio />)

    expect(html).not.toContain('pn-chip')
  })
})
