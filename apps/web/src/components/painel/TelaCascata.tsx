'use client'
// MOTORES POR AGENTE — a tela em que o dono monta a cascata.
//
// Cada papel (PO/RA/SM/QA) tem uma FILA de motores: o produto tenta o primeiro
// e, se ele não responder (cota estourada, credencial vencida, modelo fora do
// ar), desce para o próximo. Cada degrau carrega motor + modelo + esforço, e
// tudo é do PROJETO — a cascata mora em Project.runtimeConfig.agents.
//
// AS REGRAS QUE ESTA TELA CUMPRE, e cada uma tem uma conta paga atrás:
//
// · AS OPÇÕES DE MODELO VÊM DO CATÁLOGO, pela rota. Uma lista escrita à mão
//   aqui seria o MESMO defeito que estamos consertando, só que na tela: em
//   31/08 um literal de modelo envelheceu e matou 24 missões em 9h48.
//
// · A COTA APARECE AO LADO DE CADA MOTOR. É o número que faz o dono decidir
//   qual motor merece o primeiro degrau — sem ele isto seria um formulário
//   cego. Ela vem de /api/v1/painel/agentes, a mesma fonte da tela de custos.
//
// · OU DADO REAL, OU SELO, OU NÃO AFIRMA NADA. Não há exemplo nesta tela.
//   Quando o produto não sabe (cota não lida, catálogo não coletado), ele diz
//   que não sabe — `null` nunca vira 0, e vazio nunca vira "está tudo bem".
//
// · CONTROLE QUE NÃO PERSISTE NASCE DESABILITADO, COM O MOTIVO À VISTA. O
//   seletor de esforço do Antigravity é o caso: `agy --model X --effort high` é
//   erro duro do CLI (medido em 01/09/2026) e a rota recusa a gravação.
//
// A lógica toda — chave única de linha, ordenação, o que sobrevive à troca de
// motor, o que vai no PUT — mora em cascata.ts, testada. Aqui é só desenho.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ROTAS, buscar, pedir } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card } from './PainelUI'
import { Carregando, Indisponivel } from './PainelEstados'
import { Ad } from './PainelIcons'
import { assinarProjeto, projetoAtual, projetoNoServidor } from './painel-projeto'
import type { AgentesPayload, MotorCota } from './painel-tipos'
import {
  PAPEIS,
  PAPEL_NA_TELA,
  acharMotor,
  avisosDoCarregamento,
  esforcoNaTela,
  mover,
  mudou,
  nomeDoMotor,
  novoDegrau,
  opcoesDeModelo,
  paraEnvio,
  paraTela,
  removerDegrau,
  trocarEsforco,
  trocarModelo,
  trocarMotor,
  resumoDaCota,
  type CascataPayload,
  type CascataUI,
  type DegrauUI,
  type MotorOpcoes,
  type OpcoesPayload,
  type Papel,
} from './cascata'

/** A bolota de estado, por tom. Ver o comentário de `.pn-casc-*` no globals.css:
 *  a cor é gráfico (piso 3:1); quem diz o fato é a frase ao lado. */
const BOLOTA: Record<string, string> = {
  ok: 'go',
  aviso: 'wait',
  grave: 'block',
  mudo: 'idle',
}

interface ProjetoDoDono {
  id: string
  nome: string
}

/** A cota daquele motor, escrita para decidir. */
function CotaDoMotor({ runtime, agentes }: { runtime: string; agentes: AgentesPayload | null }) {
  const r = resumoDaCota({
    motor: agentes?.motores.find((m: MotorCota) => m.id === runtime),
    // Sem resposta da rota ainda, o honesto é "não sei" — nunca "está tudo
    // bem". `cotaLida: false` é exatamente esse estado.
    cotaLida: agentes ? agentes.cotaLida : false,
    motivoDaCota: agentes ? agentes.motivoDaCota : 'ainda estou lendo a cota dos seus motores',
  })
  return (
    <p className="pn-casc-cota">
      <span className={`pn-d ${BOLOTA[r.tom] ?? 'idle'}`} aria-hidden="true" />
      <span>
        <b>{nomeDoMotor(runtime)}:</b> {r.texto}
      </span>
    </p>
  )
}

function Degrau({
  papel,
  degrau,
  indice,
  total,
  motores,
  agentes,
  aoMudar,
  aoMover,
  aoRemover,
}: {
  papel: Papel
  degrau: DegrauUI
  indice: number
  total: number
  motores: MotorOpcoes[]
  agentes: AgentesPayload | null
  aoMudar: (d: DegrauUI) => void
  aoMover: (direcao: 'cima' | 'baixo') => void
  aoRemover: () => void
}) {
  const motor = acharMotor(motores, degrau.runtime)
  const modelos = opcoesDeModelo(motor, degrau.model)
  const esforco = esforcoNaTela(motor)
  const posicao = indice === 0 ? 'Primeiro a tentar' : `Reserva ${indice}`
  const id = `${papel}-${indice}`

  return (
    <div className={'pn-casc-degrau' + (indice > 0 ? ' reserva' : '')}>
      <div className="pn-casc-topo">
        <span className="pn-tag">{posicao}</span>
        <span className="pn-casc-acoes">
          <button
            type="button"
            className="pn-ico"
            onClick={() => aoMover('cima')}
            disabled={indice === 0}
            aria-label={`Subir: ${posicao} de ${PAPEL_NA_TELA[papel].titulo}`}
            title="Tentar este motor antes"
          >
            <Ad n="chevU" s={16} />
          </button>
          <button
            type="button"
            className="pn-ico"
            onClick={() => aoMover('baixo')}
            disabled={indice === total - 1}
            aria-label={`Descer: ${posicao} de ${PAPEL_NA_TELA[papel].titulo}`}
            title="Tentar este motor depois"
          >
            <Ad n="chevD" s={16} />
          </button>
          <button
            type="button"
            className="pn-btn g sm"
            onClick={aoRemover}
            disabled={total === 1}
            title={
              total === 1
                ? 'Este é o único motor deste agente — sem ele o agente não roda.'
                : 'Tirar este degrau da fila'
            }
          >
            Tirar
          </button>
        </span>
      </div>

      <div className="pn-casc-campos">
        <span>
          <label className="pn-label" htmlFor={`motor-${id}`}>
            Motor
          </label>
          <select
            id={`motor-${id}`}
            className="pn-field"
            value={degrau.runtime}
            onChange={(e) => aoMudar(trocarMotor(degrau, e.target.value, motores))}
          >
            {/* O motor gravado que a rota não conhece continua aparecendo:
                sumir com ele faria o seletor desenhar OUTRO motor, e o dono
                leria como sua uma escolha que nunca fez. */}
            {!motor && degrau.runtime ? (
              <option value={degrau.runtime}>{degrau.runtime} — motor desconhecido</option>
            ) : null}
            {motores.map((m) => (
              <option key={m.runtime} value={m.runtime}>
                {nomeDoMotor(m.runtime)}
              </option>
            ))}
          </select>
        </span>

        <span>
          <label className="pn-label" htmlFor={`modelo-${id}`}>
            Modelo
          </label>
          <select
            id={`modelo-${id}`}
            className="pn-field"
            value={degrau.model}
            disabled={modelos.length === 0}
            title={
              modelos.length === 0
                ? 'Ainda não li o catálogo de modelos deste motor. Enquanto isso, o degrau roda no modelo padrão dele.'
                : undefined
            }
            onChange={(e) => aoMudar(trocarModelo(degrau, e.target.value))}
          >
            <option value="">Padrão do motor</option>
            {modelos.map((m) => (
              <option key={m.valor} value={m.valor} disabled={m.desabilitada}>
                {m.rotulo}
              </option>
            ))}
          </select>
          {modelos.length === 0 && (
            <span className="pn-casc-nota">
              ainda não li o catálogo deste motor — este degrau roda no modelo padrão dele
            </span>
          )}
        </span>

        <span>
          <label className="pn-label" htmlFor={`esforco-${id}`}>
            Esforço
          </label>
          <select
            id={`esforco-${id}`}
            className="pn-field"
            value={degrau.effort}
            disabled={!esforco.habilitado}
            title={esforco.motivo ?? undefined}
            onChange={(e) => aoMudar(trocarEsforco(degrau, e.target.value))}
          >
            <option value="">Padrão do motor</option>
            {esforco.opcoes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {/* O motivo fica VISÍVEL, não só no title: um controle apagado sem
              explicação parece defeito nosso, e o dono fica procurando o que
              ele fez de errado. */}
          {esforco.motivo && <span className="pn-casc-nota">{esforco.motivo}</span>}
        </span>
      </div>

      <CotaDoMotor runtime={degrau.runtime} agentes={agentes} />
    </div>
  )
}

function CascataDoProjeto({ projectId, nome }: { projectId: string; nome: string }) {
  const [opcoes, setOpcoes] = useState<MotorOpcoes[] | null>(null)
  const [salvo, setSalvo] = useState<CascataUI | null>(null)
  const [atual, setAtual] = useState<CascataUI | null>(null)
  const [escolhida, setEscolhida] = useState(false)
  const [avisosDoBanco, setAvisosDoBanco] = useState<string[]>([])
  const [avisosDoServidor, setAvisosDoServidor] = useState<string[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [falhouAoLer, setFalhouAoLer] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [okDeSalvar, setOkDeSalvar] = useState(false)

  // A cota é AO VIVO e é o dado que faz o dono decidir. Mesma rota da tela de
  // custos, relida a cada minuto enquanto esta tela estiver aberta.
  const agentes = usePainelBusca<AgentesPayload>(ROTAS.agentes, { intervalo: 60000 })

  const carregar = useCallback(async () => {
    setFalhouAoLer(false)
    try {
      // As duas juntas: sem as opções não dá para saber o que é modelo válido
      // nem que esforço aquele motor aceita, e a cascata seria desenhada com
      // regras inventadas.
      const [ops, cascata] = await Promise.all([
        buscar<OpcoesPayload>(`/api/projects/${encodeURIComponent(projectId)}/cascata/opcoes`),
        buscar<CascataPayload>(`/api/projects/${encodeURIComponent(projectId)}/cascata`),
      ])
      const motores = ops.motores ?? []
      setOpcoes(motores)
      setEscolhida(Boolean(cascata.escolhida))
      setAvisosDoBanco(avisosDoCarregamento(cascata.agents, motores))
      // Dois estados iguais e SEPARADOS: `salvo` é o que está gravado, `atual`
      // é o que o dono está mexendo. É a diferença entre os dois que acende o
      // botão de salvar — e é ela que impede a tela de dizer "salvo" sem ter
      // salvo nada.
      setSalvo(paraTela(cascata.agents, motores))
      setAtual(paraTela(cascata.agents, motores))
      setErro(null)
    } catch {
      setFalhouAoLer(true)
    }
  }, [projectId])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const temMudanca = useMemo(
    () => (salvo && atual && opcoes ? mudou(salvo, atual, opcoes) : false),
    [salvo, atual, opcoes]
  )

  const mexer = (papel: Papel, fila: DegrauUI[]) => {
    setOkDeSalvar(false)
    setAtual((c) => (c ? { ...c, [papel]: fila } : c))
  }

  const salvar = async () => {
    if (!atual || !opcoes) return
    setSalvando(true)
    setErro(null)
    setOkDeSalvar(false)
    try {
      const r = await pedir<{ avisos?: string[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/cascata`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paraEnvio(atual, opcoes)),
        }
      )
      // O que passa a valer é o que o SERVIDOR aceitou, relido da rota — não o
      // que a tela achou que mandou. Se ele descartar ou ajustar algo, é isso
      // que fica na tela.
      await carregar()
      setAvisosDoServidor(r.avisos ?? [])
      setOkDeSalvar(true)
    } catch (e) {
      const m = e as { status?: number; message?: string }
      setErro(
        m.status === 400
          ? `Esta cascata não foi aceita: ${m.message ?? 'confira os motores e os esforços escolhidos'}.`
          : m.status === 404
            ? 'Este projeto não existe mais.'
            : 'Não consegui salvar agora. Nada mudou.'
      )
    } finally {
      setSalvando(false)
    }
  }

  if (falhouAoLer) {
    return (
      <Card titulo="Motores de cada agente">
        <Indisponivel o_que="a cascata deste projeto" onTentar={() => void carregar()} />
      </Card>
    )
  }
  if (!atual || !opcoes) {
    return (
      <Card titulo="Motores de cada agente">
        <Carregando o_que="Lendo os seus motores e o catálogo de modelos" />
      </Card>
    )
  }

  const avisos = [...avisosDoBanco, ...avisosDoServidor]

  return (
    <>
      <Card titulo={`Como estão seus motores agora`} sub="a cota que o produto acabou de ler">
        <p className="pn-casc-nota" style={{ marginBottom: 12 }}>
          Você usa a sua própria assinatura de cada ferramenta. Quem está com a cota mais folgada
          merece o primeiro degrau — é por isso que este número está aqui e não em outra tela.
        </p>
        <div className="pn-casc">
          {opcoes.map((m) => (
            <CotaDoMotor key={m.runtime} runtime={m.runtime} agentes={agentes.dados} />
          ))}
        </div>
      </Card>

      {avisos.length > 0 && (
        <div className="pn-casc-avisos" role="status">
          <span className="pn-eyebrow">O que está gravado e não vai valer como está</span>
          {avisos.map((a) => (
            <span key={a} className="pn-casc-nota">
              {a}
            </span>
          ))}
        </div>
      )}

      {PAPEIS.map((papel) => {
        const meta = PAPEL_NA_TELA[papel]
        const fila = atual[papel]
        return (
          <Card
            key={papel}
            titulo={`${meta.titulo} (${meta.sigla})`}
            sub={meta.oQueFaz}
            acao={
              <button
                type="button"
                className="pn-btn g sm"
                onClick={() => mexer(papel, novoDegrau(papel, fila, opcoes))}
                disabled={fila.length >= opcoes.length}
                title={
                  fila.length >= opcoes.length
                    ? 'Todos os seus motores já estão na fila deste agente.'
                    : 'Acrescentar mais um motor de reserva'
                }
              >
                <Ad n="plus" s={14} />
                Reserva
              </button>
            }
          >
            <div className="pn-casc">
              {fila.map((d, i) => (
                <Degrau
                  key={d.chave}
                  papel={papel}
                  degrau={d}
                  indice={i}
                  total={fila.length}
                  motores={opcoes}
                  agentes={agentes.dados}
                  aoMudar={(novo) =>
                    mexer(
                      papel,
                      fila.map((x) => (x.chave === d.chave ? novo : x))
                    )
                  }
                  aoMover={(direcao) => mexer(papel, mover(fila, i, direcao))}
                  aoRemover={() => mexer(papel, removerDegrau(fila, i))}
                />
              ))}
            </div>
          </Card>
        )
      })}

      <Card titulo="Salvar">
        <div className="pn-casc-barra">
          <button
            type="button"
            className="pn-btn a"
            onClick={() => void salvar()}
            disabled={!temMudanca || salvando}
            title={
              temMudanca
                ? `Gravar esta cascata no projeto ${nome}`
                : 'Nada mudou desde a última vez que você salvou.'
            }
          >
            {salvando ? 'Salvando…' : 'Salvar a cascata'}
          </button>
          <button
            type="button"
            className="pn-btn g"
            onClick={() => {
              setOkDeSalvar(false)
              setAtual(salvo)
            }}
            disabled={!temMudanca || salvando}
            title="Voltar ao que está gravado"
          >
            Desfazer
          </button>
          <span className="pn-casc-nota">
            {!escolhida
              ? 'Você ainda não escolheu: hoje vale o padrão do produto, e é ele que está desenhado aqui.'
              : `Esta é a cascata gravada no projeto ${nome}.`}
          </span>
        </div>

        {erro && (
          <p className="pn-casc-cota" style={{ marginTop: 12 }}>
            <span className="pn-d block" aria-hidden="true" />
            <span>{erro}</span>
          </p>
        )}
        {okDeSalvar && !erro && (
          <p className="pn-casc-cota" style={{ marginTop: 12 }} role="status">
            <span className="pn-d go" aria-hidden="true" />
            <span>
              Cascata gravada. Vale a partir da próxima missão de cada agente deste projeto.
            </span>
          </p>
        )}
      </Card>
    </>
  )
}

export function TelaCascata() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  // O seletor do topo guarda o NOME do projeto; a cascata é endereçada pelo
  // ID. Esta lista é a ponte, e é a mesma que a tela de pedidos usa.
  const projetos = usePainelBusca<ProjetoDoDono[], { projetos?: ProjetoDoDono[] }>(ROTAS.projetos, {
    mapear: (b) => b.projetos ?? [],
    vazio: (d) => d.length === 0,
  })

  const escolhido =
    projeto && projetos.estado === 'ok'
      ? (projetos.dados ?? []).find((p) => p.nome === projeto)
      : undefined

  return (
    <>
      <Cabeca titulo="Motores por agente">
        Cada agente tem uma fila de motores. O produto tenta o primeiro; se ele não responder — cota
        estourada, credencial vencida, modelo fora do ar — desce para o próximo.
      </Cabeca>

      {!projeto ? (
        <Card titulo="Motores de cada agente">
          <p className="pn-casc-nota">
            A cascata é de cada projeto. Escolha um projeto no seletor do topo para ver e mudar a
            dele.
          </p>
        </Card>
      ) : projetos.estado === 'carregando' ? (
        <Card titulo="Motores de cada agente">
          <Carregando o_que="Procurando o seu projeto" />
        </Card>
      ) : projetos.estado === 'indisponivel' ? (
        <Card titulo="Motores de cada agente">
          <Indisponivel o_que="a sua lista de projetos" onTentar={projetos.recarregar} />
        </Card>
      ) : !escolhido ? (
        <Card titulo="Motores de cada agente">
          {/* Não afirma que o projeto sumiu: afirma o que É verdade — não achei
              este nome na lista que o servidor me deu agora. */}
          <p className="pn-casc-nota">
            Não encontrei o projeto <strong>{projeto}</strong> na sua lista. Escolha outro no
            seletor do topo.
          </p>
        </Card>
      ) : (
        <CascataDoProjeto projectId={escolhido.id} nome={escolhido.nome} />
      )}
    </>
  )
}
