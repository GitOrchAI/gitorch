'use client'
// Projetos: cada projeto ligado ao GitOrch. AO VIVO (/api/projects). A tela
// mostra o que a rota entrega — nome, última atividade, volume de tarefas,
// se está ativo. Saúde e "agentes ligados" não vêm dessa rota ainda; em vez
// de inventar, a tela omite. Portado de TelaRepositorios.jsx.
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Ad } from './PainelIcons'
import { Cabeca, Card, Estado } from './PainelUI'
import { Estados } from './PainelEstados'

interface ProjetoBruto {
  id: string
  name: string
  description?: string | null
  isActive?: boolean
  updatedAt: string
  _count?: { missions?: number; events?: number }
}
interface ProjetoView {
  id: string
  nome: string
  full: string
  ativo: boolean
  ultima: string
  tarefas: number
}

function tempoRelativo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return `há ${d} dia${d > 1 ? 's' : ''}`
}

export function TelaProjetos() {
  const r = usePainelBusca<ProjetoView[], { data?: ProjetoBruto[] }>(ROTAS.repos, {
    mapear: (b) =>
      (b.data ?? []).map((p) => ({
        id: p.id,
        nome: p.name,
        full: p.description || p.name,
        ativo: p.isActive ?? true,
        ultima: tempoRelativo(p.updatedAt),
        tarefas: p._count?.missions ?? 0,
      })),
    vazio: (d) => d.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Projetos">
        Cada projeto ligado ao GitOrch, com o volume de tarefas e quando saiu a última atividade.
      </Cabeca>

      <Estados
        r={r}
        o_que="a lista de projetos"
        vazio="Nenhum projeto ligado ainda. Conclua o setup para ligar o primeiro."
      >
        {(lista) => (
          <div className="ad-3">
            {lista.map((p) => (
              <Card key={p.id}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.025em' }}>
                      {p.nome}
                    </div>
                    <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 4 }}>
                      {p.full}
                    </div>
                  </div>
                  <Estado d={p.ativo ? 'go' : 'idle'}>{p.ativo ? 'Ativo' : 'Pausado'}</Estado>
                </div>

                <div style={{ display: 'flex', gap: 22, marginTop: 18 }}>
                  <div>
                    <span className="ad-label">Tarefas no total</span>
                    <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
                      {p.tarefas}
                    </div>
                  </div>
                  <div>
                    <span className="ad-label">Última atividade</span>
                    <div style={{ fontSize: 14, fontWeight: 500, paddingTop: 3 }}>{p.ultima}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                  <button className="ad-btn g sm">
                    Abrir no GitHub <Ad n="ext" s={13} />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Estados>

      <Card titulo="Adicionar projeto">
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
          Seu plano permite até 5 projetos na nuvem. Para um repositório de organização, o app do
          GitHub precisa ser instalado na conta dona do repositório.
        </p>
        <button className="ad-btn a" style={{ marginTop: 16 }}>
          <Ad n="plus" s={15} />
          Ligar outro projeto
        </button>
      </Card>
    </>
  )
}
