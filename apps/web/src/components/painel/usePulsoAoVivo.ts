'use client'
// Pulso ao vivo pelo SSE que já existe (/api/events). A rota /painel/pulso
// (nova) dá o estado inicial; este hook mantém a faixa "andando agora" viva a
// cada evento. onerror → esfria a faixa (verde vira âmbar). Portado de
// ad-api.jsx (usePulsoAoVivo).
import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../../lib/api'
import { ROTAS, descreverEventoSSE } from './painel-api'
import { PAINEL_DEMO } from './usePainelBusca'

export interface PulsoVivo {
  /** frase de tempo ("agora", "há 2 minutos", ...); null = nenhum sinal ainda */
  ultimo: string | null
  o_que: string | null
  quente: boolean
}

export function usePulsoAoVivo(inicial: PulsoVivo | null): PulsoVivo | null {
  const [p, setP] = useState<PulsoVivo | null>(inicial)

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
      // Sem SSE: a faixa fica no último estado conhecido (o da rota /painel/pulso).
    }
    return () => es?.close()
  }, [])

  return p
}
