'use client'
// Pulso: o estado inicial vem da rota /painel/pulso (nova); o SSE de
// /api/events mantém a faixa "andando agora" viva a cada evento. onerror →
// esfria a faixa (verde vira âmbar). Portado de ad-api.jsx (usePulsoAoVivo).
import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../../lib/api'
import { ROTAS, buscar, descreverEventoSSE } from './painel-api'
import { PAINEL_DEMO } from './usePainelBusca'
import type { PulsoPayload } from './painel-tipos'

export interface PulsoVivo {
  /** frase de tempo ("agora", "há 2 min", ...); null = nenhum sinal ainda */
  ultimo: string | null
  o_que: string | null
  quente: boolean
}

function fraseDeTempo(haSegundos: number | null): string | null {
  if (haSegundos == null) return null
  if (haSegundos < 60) return 'agora'
  const min = Math.floor(haSegundos / 60)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} dia(s)`
}

export function usePulsoAoVivo(): PulsoVivo | null {
  const [p, setP] = useState<PulsoVivo | null>(null)

  // Estado inicial pela rota /painel/pulso.
  useEffect(() => {
    if (PAINEL_DEMO) return
    let vivo = true
    buscar<PulsoPayload>(ROTAS.pulso)
      .then((d) => {
        if (vivo) {
          setP({ ultimo: fraseDeTempo(d.ha_segundos), o_que: d.descricao, quente: d.quente })
        }
      })
      .catch(() => {
        /* sem rota de pulso: a faixa fica no que o SSE trouxer (ou "nenhum sinal") */
      })
    return () => {
      vivo = false
    }
  }, [])

  // SSE mantém a faixa viva.
  useEffect(() => {
    if (PAINEL_DEMO) return
    let es: EventSource | undefined
    try {
      es = new EventSource(`${API_BASE_URL}${ROTAS.eventos}`, { withCredentials: true })
      es.onmessage = (ev) => {
        setP({ ultimo: 'agora', o_que: descreverEventoSSE(ev.data), quente: true })
      }
      es.onerror = () => {
        setP((a) => (a ? { ...a, quente: false } : a))
      }
    } catch {
      /* sem SSE: a faixa fica no estado da rota /painel/pulso */
    }
    return () => es?.close()
  }, [])

  return p
}
