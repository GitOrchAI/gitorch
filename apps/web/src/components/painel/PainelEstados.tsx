// As três respostas honestas do painel, como componentes (a decisão de QUAL
// aparece mora em painel-estados.ts — testada). Portado de ad-estados.jsx.
import type { ReactNode } from 'react'
import { Ad } from './PainelIcons'

export function Carregando({ o_que = 'Carregando' }: { o_que?: string }) {
  return <div className="ad-empty">{o_que}…</div>
}

// "Não consegui saber" é diferente de "não tem nada": esta tem botão de saída.
export function Indisponivel({
  o_que = 'esta informação',
  onTentar,
}: {
  o_que?: string
  onTentar?: () => void
}) {
  return (
    <div className="ad-empty">
      <p style={{ margin: '0 0 14px' }}>Não deu para carregar {o_que} agora.</p>
      {onTentar && (
        <button className="ad-btn g sm" onClick={onTentar}>
          <Ad n="refresh" s={14} />
          Tentar de novo
        </button>
      )}
    </div>
  )
}

export function Vazio({ children }: { children: ReactNode }) {
  return <div className="ad-empty">{children}</div>
}

export interface ResultadoDeBusca<T> {
  estado: 'carregando' | 'indisponivel' | 'vazio' | 'ok'
  dados: T | null
  recarregar?: () => void
}

// Envelope: recebe o resultado de usePainelBusca e decide qual das três aparece.
export function Estados<T>({
  r,
  o_que,
  vazio,
  children,
}: {
  r: ResultadoDeBusca<T>
  o_que?: string
  vazio?: ReactNode
  children: (dados: T) => ReactNode
}) {
  if (r.estado === 'carregando') return <Carregando />
  if (r.estado === 'indisponivel') return <Indisponivel o_que={o_que} onTentar={r.recarregar} />
  if (r.estado === 'vazio') return <Vazio>{vazio}</Vazio>
  return <>{children(r.dados as T)}</>
}

// Selo discreto de "isto é exemplo" — enquanto a rota não existe, a tela diz.
export function SeloDemo({
  mostrar,
  nota = 'dado de exemplo',
}: {
  mostrar: boolean
  nota?: string
}) {
  if (!mostrar) return null
  return (
    <span
      className="ad-tag"
      title="Esta tela ainda não está ligada à API"
      style={{ marginLeft: 8 }}
    >
      {nota}
    </span>
  )
}
