'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Maximize2, X } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import {
  computeNodePositions,
  radiusForNodeCount,
  nodeRadiusForType,
  edgeOpacityForRel,
  parseAggregatedCount,
  type Vec3,
} from './graph3d-layout'

export interface RepoGraph3DNode {
  id: string
  label: string
  file: string
  type: string
  health: 'good' | 'warn' | 'bad'
}
export interface RepoGraph3DEdge {
  source: string
  target: string
  rel: string
}

interface RepoGraph3DProps {
  nodes: RepoGraph3DNode[]
  edges: RepoGraph3DEdge[]
  /** `truncated` do GraphExportResult — mostra o banner de agregação. */
  truncated: boolean
}

const MOBILE_BREAKPOINT = 768
const DEFAULT_COLORS = { good: '#0c8b57', warn: '#b8730c', bad: '#e5484d', ink: '#101116' }

/** Ponte de tema: Three.js não lê CSS. Lê os tokens `--gl-*` reais (tema
 * ao vivo) e reage a troca de tema (atributo `data-theme` no `.gl` root, OU
 * preferência do SO quando não há toggle explícito). */
function useThemeColors(): typeof DEFAULT_COLORS {
  const [colors, setColors] = useState(DEFAULT_COLORS)

  useEffect(() => {
    const root = document.querySelector('.gl') as HTMLElement | null
    if (!root) return undefined

    const read = (): void => {
      const style = getComputedStyle(root)
      const v = (name: string, fallback: string): string =>
        style.getPropertyValue(name).trim() || fallback
      setColors({
        good: v('--gl-accent-ink', DEFAULT_COLORS.good),
        warn: v('--gl-warn', DEFAULT_COLORS.warn),
        bad: v('--gl-sev', DEFAULT_COLORS.bad),
        ink: v('--gl-ink', DEFAULT_COLORS.ink),
      })
    }
    read()

    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', read)

    return () => {
      observer.disconnect()
      media.removeEventListener('change', read)
    }
  }, [])

  return colors
}

function healthColor(health: RepoGraph3DNode['health'], colors: typeof DEFAULT_COLORS): string {
  if (health === 'good') return colors.good
  if (health === 'warn') return colors.warn
  return colors.bad
}

function GraphNodes({
  nodes,
  positions,
  colors,
  selectedId,
  onSelect,
}: {
  nodes: RepoGraph3DNode[]
  positions: Map<string, Vec3>
  colors: typeof DEFAULT_COLORS
  selectedId: string | null
  onSelect: (node: RepoGraph3DNode) => void
}): React.JSX.Element {
  return (
    <>
      {nodes.map((n) => {
        const p = positions.get(n.id)
        if (!p) return null
        const selected = n.id === selectedId
        const color = healthColor(n.health, colors)
        return (
          <mesh
            key={n.id}
            position={[p.x, p.y, p.z]}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation()
              onSelect(n)
            }}
          >
            <sphereGeometry args={[nodeRadiusForType(n.type) * (selected ? 1.5 : 1), 12, 12]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={selected ? 0.9 : 0.3}
            />
          </mesh>
        )
      })}
    </>
  )
}

function GraphEdges({
  edges,
  positions,
  colors,
}: {
  edges: RepoGraph3DEdge[]
  positions: Map<string, Vec3>
  colors: typeof DEFAULT_COLORS
}): React.JSX.Element {
  const segments = useMemo(() => {
    const out: Array<{ a: Vec3; b: Vec3; opacity: number }> = []
    for (const e of edges) {
      const a = positions.get(e.source)
      const b = positions.get(e.target)
      if (!a || !b) continue
      out.push({ a, b, opacity: edgeOpacityForRel(e.rel) })
    }
    return out
  }, [edges, positions])

  return (
    <>
      {segments.map((s, i) => (
        <line key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array([s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z]), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={colors.ink} transparent opacity={s.opacity * 0.5} />
        </line>
      ))}
    </>
  )
}

class GraphErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(err: unknown): void {
    console.warn('[RepoGraph3D] erro ao renderizar o grafo 3D, caindo pro fallback em tabela', err)
  }

  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

/**
 * Grafo 3D interativo do diagnóstico (F1 — Onda 3, "momento mágico"). Puro
 * componente de apresentação: quem busca o grafo e decide loading/erro/vazio
 * é StepDiagnosis — aqui só desenha, given nodes/edges/truncated.
 */
export default function RepoGraph3D({
  nodes,
  edges,
  truncated,
}: RepoGraph3DProps): React.JSX.Element {
  const { t } = useLanguage()
  const colors = useThemeColors()
  const [selected, setSelected] = useState<RepoGraph3DNode | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = (): void => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Trava o scroll do body enquanto o grafo está fullscreen — o modal já
  // cobre a viewport inteira; sem isto, arrastar dentro dele ainda rolaria a
  // página atrás.
  useEffect(() => {
    if (!fullscreen) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [fullscreen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (fullscreen) setFullscreen(false)
      else setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const positions = useMemo(() => computeNodePositions(nodes), [nodes])
  const camDistance = useMemo(() => radiusForNodeCount(nodes.length) * 2.2, [nodes.length])
  // No mobile, fora do fullscreen, o canvas é decorativo (sem gesto de
  // câmera) — nunca compete com o scroll da página (mini-spec, Onda 3).
  const controlsEnabled = !isMobile || fullscreen

  return (
    <GraphErrorBoundary fallback={<GraphFallbackNote t={t} />}>
      <div className={`wz-graph3d${fullscreen ? ' wz-graph3d-fullscreen' : ''}`}>
        {truncated && <div className="wz-graph3d-banner">{t('setup.diagGraphTruncated')}</div>}

        <div className="wz-graph3d-stage">
          <Canvas
            camera={{ position: [0, 0, camDistance], fov: 55 }}
            onPointerMissed={() => setSelected(null)}
          >
            <ambientLight intensity={0.65} />
            <pointLight position={[camDistance, camDistance, camDistance]} intensity={0.9} />
            <GraphEdges edges={edges} positions={positions} colors={colors} />
            <GraphNodes
              nodes={nodes}
              positions={positions}
              colors={colors}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
            <OrbitControls enabled={controlsEnabled} enablePan={fullscreen} makeDefault />
          </Canvas>

          {isMobile && (
            <button
              type="button"
              className="wz-graph3d-expand"
              onClick={() => setFullscreen((f) => !f)}
              aria-label={t(fullscreen ? 'setup.diagGraphCollapse' : 'setup.diagGraphExpand')}
            >
              {fullscreen ? <X size={16} /> : <Maximize2 size={16} />}
              {t(fullscreen ? 'setup.diagGraphCollapse' : 'setup.diagGraphExpand')}
            </button>
          )}
        </div>

        <div className="wz-graph3d-panel">
          {selected ? (
            <>
              <div className="wz-graph3d-panel-title">{t('setup.diagGraphPanelTitle')}</div>
              <div className="wz-graph3d-panel-label gl-mono">{selected.label}</div>
              {selected.type === 'directory' ? (
                <div className="wz-opt-desc">
                  {t('setup.diagGraphPanelDirectory', {
                    count: parseAggregatedCount(selected.label) ?? 0,
                  })}
                </div>
              ) : (
                <div className="wz-opt-desc gl-mono">
                  {t('setup.diagGraphPanelFile')}: {selected.file}
                </div>
              )}
              <div className="wz-opt-desc">
                {t('setup.diagGraphPanelType')}: {selected.type}
              </div>
              <div className={`wz-diag-finding ${selected.health}`} style={{ marginTop: 6 }}>
                {t('setup.diagGraphPanelHealth')}: {selected.health}
              </div>
            </>
          ) : (
            <div className="wz-opt-desc">{t('setup.diagGraphPanelEmpty')}</div>
          )}
        </div>
      </div>
    </GraphErrorBoundary>
  )
}

function GraphFallbackNote({ t }: { t: (key: string) => string }): React.JSX.Element {
  return <p className="wz-opt-desc">{t('setup.diagGraphUnavailable')}</p>
}
