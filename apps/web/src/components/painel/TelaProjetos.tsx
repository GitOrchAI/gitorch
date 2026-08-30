'use client'
// Projetos: cada projeto ligado ao GitOrch. AO VIVO (/api/projects). A tela
// mostra o que a rota entrega — nome, última atividade, volume de tarefas,
// se está ativo. Saúde e "agentes ligados" não vêm dessa rota ainda; em vez
// de inventar, a tela omite. Portado de TelaRepositorios.jsx.
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { useSyncExternalStore } from 'react'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'
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

/** Uma linha da leitura, do jeito que a rota entrega. */
interface LeituraBruta {
  projeto: string
  repo: string
  disponivel: boolean
  motivo?: string
  privado?: boolean
  linguagem?: string | null
  pedidosAbertos?: number
  entregasAbertas?: number
  quadros?: { total: number; vivos: number; comSprint: number; naoConsigoVer?: boolean }
  ramoPrincipal?: string | null
  temVerificacao?: boolean
  ultimoCommit?: string | null
}

/** Um número da leitura. Sem valor, mostra travessão — nunca zero por engano. */
function Conta({ rotulo, valor }: { rotulo: string; valor: number | null | undefined }) {
  return (
    <div>
      <span className="pn-label">{rotulo}</span>
      <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
        {typeof valor === 'number' ? valor : '—'}
      </div>
    </div>
  )
}

/**
 * O que o GitOrch já leu de cada repositório.
 *
 * Conta o que está lá; não julga. Sem nota, sem "saúde do repositório", sem
 * estimativa — o dono já barrou número que ninguém definiu, e diagnóstico
 * inventado é pior que diagnóstico nenhum.
 */
function OQueEuJaLi() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<LeituraBruta[], { leituras?: LeituraBruta[] }>(
    `${ROTAS.leitura}${filtroDeProjeto(projeto)}`,
    { mapear: (b) => b.leituras ?? [], vazio: (d) => d.length === 0 }
  )

  return (
    <Card titulo="O que eu já li">
      <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
        Assim que um repositório entra, eu leio o que já existe nele. Isto é a contagem — não é
        avaliação nem nota.
      </p>
      <Estados r={r} o_que="a leitura dos repositórios" vazio="Nenhum repositório para ler ainda.">
        {(lista) => (
          <div className="pn-3">
            {lista.map((l) => (
              <Card key={l.repo}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.025em' }}>
                      {l.projeto}
                    </div>
                    <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 4 }}>
                      {l.repo}
                    </div>
                  </div>
                  {l.disponivel ? (
                    <Estado d="go">Li</Estado>
                  ) : (
                    <Estado d="idle">Não consegui ler</Estado>
                  )}
                </div>

                {l.disponivel ? (
                  <>
                    <div style={{ display: 'flex', gap: 22, marginTop: 18, flexWrap: 'wrap' }}>
                      <Conta rotulo="Pedidos abertos" valor={l.pedidosAbertos} />
                      <Conta rotulo="Entregas abertas" valor={l.entregasAbertas} />
                      {/* Quando o GitHub diz que há quadros e não deixa ver
                          quais, mostrar o total com o aviso é honesto; mostrar
                          "0 vivos" seria dizer que ele não tem quadro. */}
                      <Conta
                        rotulo={l.quadros?.naoConsigoVer ? 'Quadros (não consigo ver)' : 'Quadros'}
                        valor={l.quadros?.naoConsigoVer ? l.quadros.total : l.quadros?.vivos}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 10,
                        marginTop: 18,
                        flexWrap: 'wrap',
                        fontSize: 13,
                        color: 'var(--gl-muted)',
                      }}
                    >
                      <span>{l.linguagem ?? 'linguagem não identificada'}</span>
                      <span>·</span>
                      <span>
                        {l.ramoPrincipal ? `ramo ${l.ramoPrincipal}` : 'sem commit ainda'}
                      </span>
                      <span>·</span>
                      <span>
                        {l.temVerificacao
                          ? 'com verificação automática'
                          : 'sem verificação automática'}
                      </span>
                      <span>·</span>
                      {/* "Tem quadro" e "tem sprint" são coisas diferentes: o
                          quadro do gitorch existe e NÃO tem campo de sprint, e
                          o do Jardim tinha o campo com zero ciclos. */}
                      <span>
                        {l.quadros?.naoConsigoVer
                          ? 'não enxergo os quadros deste repositório'
                          : (l.quadros?.comSprint ?? 0) > 0
                            ? 'quadro com sprint configurada'
                            : (l.quadros?.vivos ?? 0) > 0
                              ? 'quadro sem sprint'
                              : 'sem quadro'}
                      </span>
                    </div>
                  </>
                ) : (
                  // Repositório que não respondeu NÃO vira zero: zero faria o
                  // dono achar que ele está vazio.
                  <p style={{ margin: '14px 0 0', fontSize: 13.5, color: 'var(--gl-muted)' }}>
                    {l.motivo ?? 'não consegui ler este repositório agora'}
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </Estados>
    </Card>
  )
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
          <div className="pn-3">
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
                    <span className="pn-label">Tarefas no total</span>
                    <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
                      {p.tarefas}
                    </div>
                  </div>
                  <div>
                    <span className="pn-label">Última atividade</span>
                    <div style={{ fontSize: 14, fontWeight: 500, paddingTop: 3 }}>{p.ultima}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                  <button className="pn-btn g sm">
                    Abrir no GitHub <Ad n="ext" s={13} />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Estados>

      <OQueEuJaLi />

      <Card titulo="Adicionar projeto">
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
          Seu plano permite até 5 projetos na nuvem. Para um repositório de organização, o app do
          GitHub precisa ser instalado na conta dona do repositório.
        </p>
        <button className="pn-btn a" style={{ marginTop: 16 }}>
          <Ad n="plus" s={15} />
          Ligar outro projeto
        </button>
      </Card>
    </>
  )
}
