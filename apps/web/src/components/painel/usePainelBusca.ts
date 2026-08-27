'use client'
// Hook fino de busca do painel: orquestra painel-api.ts (HTTP) e
// painel-estados.ts (as 3 respostas honestas), ambos testados. O hook em si
// não tem teste — só cola os dois módulos.
//
// Modo demo: NEXT_PUBLIC_PAINEL_DEMO === '1' → devolve o `demo` passado, com
// `demo: true` para a tela mostrar o selo. É o que deixa navegar sem servidor.
import { useCallback, useEffect, useRef, useState } from 'react'
import { buscar } from './painel-api'
import { classificar, erroPara } from './painel-estados'

export const PAINEL_DEMO = process.env.NEXT_PUBLIC_PAINEL_DEMO === '1'
/** Liga as telas da leva 2 (ritmo/entregas/histórico). Sem isto elas ficam no
 *  exemplo com selo e NÃO tentam a rota (evita 404 no console). */
export const PAINEL_LEVA2 = process.env.NEXT_PUBLIC_PAINEL_LEVA2 === '1'

/** Erro de rota que ainda não existe no servidor (leva 2). 404 e 501. */
function rotaAusente(e: unknown): boolean {
  const s = (e as { status?: number })?.status
  return s === 404 || s === 501
}

interface Resultado<T> {
  estado: 'carregando' | 'indisponivel' | 'vazio' | 'ok'
  dados: T | null
  erro?: Error
  demo?: boolean
}

export interface EstadoBuscaHook<T> extends Resultado<T> {
  recarregar: () => void
}

interface OpcoesBusca<Bruto, T> {
  /** O que a tela mostra em modo demo (e no fallback de rota ausente). */
  demo?: T
  /** Transforma o corpo cru da API no shape que a tela usa. */
  mapear?: (bruto: Bruto) => T
  /** Diz se o resultado conta como "vazio de verdade". */
  vazio?: (dados: T) => boolean
  /** Re-busca a cada N ms enquanto a tela está aberta. */
  intervalo?: number
  /**
   * Quando a rota ainda não existe no servidor (404/501 — telas da leva 2),
   * mostra o `demo` com `demo: true` (a tela desenha o selo "dado de exemplo").
   * O selo some sozinho quando a rota passar a responder. Só vale para
   * "rota ausente" — erro de rede/5xx continua virando `indisponivel`.
   */
  exemploQuandoAusente?: boolean
}

export function usePainelBusca<T = unknown, Bruto = unknown>(
  caminho: string,
  opcoes: OpcoesBusca<Bruto, T> = {}
): EstadoBuscaHook<T> {
  const { demo, intervalo } = opcoes
  // `mapear`/`vazio`/`demo` chegam como literais (nova identidade a cada
  // render). A ref segura a versão mais recente sem re-armar `rodar` — sempre
  // atualizada num effect, nunca durante o render.
  const opts = useRef(opcoes)
  useEffect(() => {
    opts.current = opcoes
  })

  const mostraExemplo =
    demo !== undefined && (PAINEL_DEMO || (opcoes.exemploQuandoAusente && !PAINEL_LEVA2))
  const [r, setR] = useState<Resultado<T>>(
    mostraExemplo
      ? { estado: 'ok', dados: demo as T, demo: true }
      : { estado: 'carregando', dados: null }
  )

  const rodar = useCallback(async () => {
    const o = opts.current
    // Modo demo global OU tela da leva 2 ainda desligada: mostra o exemplo com
    // selo sem tentar a rota (nada de 404 no console). O selo some sozinho
    // quando NEXT_PUBLIC_PAINEL_LEVA2 ligar.
    if ((PAINEL_DEMO || (o.exemploQuandoAusente && !PAINEL_LEVA2)) && o.demo !== undefined) {
      setR({ estado: 'ok', dados: o.demo, demo: true })
      return
    }
    setR((a) => (a.estado === 'ok' ? a : { estado: 'carregando', dados: null }))
    try {
      const bruto = await buscar<Bruto>(caminho)
      const dados = (o.mapear ? o.mapear(bruto) : (bruto as unknown as T)) as T
      const c = classificar({ bruto: dados, vazio: o.vazio })
      setR({ estado: c.estado, dados: c.dados })
    } catch (e) {
      if (o.exemploQuandoAusente && o.demo !== undefined && rotaAusente(e)) {
        setR({ estado: 'ok', dados: o.demo, demo: true })
        return
      }
      setR({ estado: 'indisponivel', dados: null, erro: erroPara(e).erro })
    }
  }, [caminho])

  useEffect(() => {
    let vivo = true
    const tick = () => {
      if (vivo) void rodar()
    }
    tick()
    if (!intervalo) {
      return () => {
        vivo = false
      }
    }
    const id = setInterval(tick, intervalo)
    return () => {
      vivo = false
      clearInterval(id)
    }
  }, [rodar, intervalo])

  return { ...r, recarregar: rodar }
}
