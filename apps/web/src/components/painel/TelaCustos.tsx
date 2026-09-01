'use client'
// Custos e limites: você usa a sua própria assinatura de cada ferramenta. O
// que o painel controla é quanto de cada cota já foi gasto.
//
// A cota dos motores é AO VIVO, lida de engine_connections pelo relógio. Até
// 30/08/2026 esta tela dizia "Nenhum motor conectado ainda." com o banco
// cheio: a rota caía num default que devolvia lista vazia, e vazio é um estado
// plausível demais para alguém desconfiar. Agora a resposta separa "não há
// motor" de "não consegui ler", e a tela mostra os dois de forma diferente.
//
// Motor caído RELIGA AQUI (01/09/2026). Até hoje esta tela oferecia um link
// para `/setup`: o dono clicava para religar o Codex e era despejado noutra
// tela. O login assistido agora roda no próprio card, pelo mesmo fluxo do
// passo 7 do assistente — um só, compartilhado, em conexao-de-motor.ts.
//
// Os KPIs de topo, o esforço por projeto e o plano seguem de exemplo (leva 2).
// Portado de TelaCustos.jsx.
import { useSyncExternalStore } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Kpi, Barra } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'
import type { MotorCota } from './painel-tipos'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'
import { ReligarMotor } from './ReligarMotor'

interface Distribuicao {
  mediana: number
  p90: number
  maximo: number
}
interface CicloView {
  entregas: number
  dePrimeira: number
  cutucadas: Distribuicao
  tentativas: Distribuicao
  falhasDeMerge: Distribuicao
  horasAteFechar: Distribuicao | null
  naoMedido: string[]
}

/** Quando a cota foi lida, em linguagem de gente. */
function quandoFoiLido(iso: string | null): string {
  if (!iso) return 'nunca foi lida'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 2) return 'lida agora'
  if (min < 60) return `lida há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `lida há ${h} h`
  return `lida há ${Math.round(h / 24)} d`
}

/**
 * Um motor, com o estado que foi MEDIDO.
 *
 * Duas regras que este card existe para cumprir:
 * 1. `null` não vira 0. "Não sei quanto foi usado" exibido como 0% faria o dono
 *    achar que tem a cota inteira — o oposto da verdade.
 * 2. Motor caído aparece dito. O assistente já mostrou "Codex Conectado" com o
 *    motor morto havia uma hora, e quem descobriu foi o dono, não o produto.
 */
function MotorCard({ m, aoReligar }: { m: MotorCota; aoReligar: () => void }) {
  const semNumero = m.sessao == null && m.semana == null
  // TRÊS estados, não dois. Um motor com a conexão revogada, expirada ou com
  // erro cai em `nao_conectado` — e a versão anterior desta tela o desenhava
  // igual a um motor saudável que só não mede consumo. Era o "Codex Conectado
  // com o motor morto" de novo, com outra roupa.
  const fora = m.precisaReligar || m.estado === 'nao_conectado'
  const rotulo = m.precisaReligar ? 'precisa religar' : 'não está conectado'
  const explicacao = m.precisaReligar
    ? 'a credencial venceu e a renovação automática não deu conta'
    : 'este motor não está conectado agora'

  return (
    <div>
      <div className="pn-brow">
        <b>{m.nome}</b>
        {fora ? (
          // `--gl-sev` é o token de severidade do painel. A versão anterior
          // usava `var(--gl-bad, #A32C22)`, e `--gl-bad` não existe em lugar
          // nenhum: caía sempre no literal, fixo nos dois temas, com contraste
          // insuficiente no escuro — o aviso mais importante da tela era o
          // texto menos legível dela.
          <span className="num" style={{ color: 'var(--gl-sev)' }}>
            {rotulo}
          </span>
        ) : null}
      </div>

      {fora ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5, color: 'var(--gl-faint)' }}>{explicacao}</div>
          {/*
            O caminho para religar SEM tocar em SSH e SEM SAIR DAQUI.

            A versão anterior mandava para `/setup` com o rótulo "Religar no
            assistente". Era honesto — e era o defeito. O dono clicou para
            religar o Codex, foi parar noutra tela e escreveu: "Serviço mal
            pensado." Um rótulo honesto CONFESSA a navegação; não a conserta.

            Agora o login assistido acontece aqui, no mesmo fluxo do passo 7
            (components/setup/conexao-de-motor.ts, compartilhado com o
            assistente — uma cópia divergiria na primeira mudança). Ao voltar,
            a tela RELÊ a cota do servidor em vez de supor que deu certo.
          */}
          <ReligarMotor motor={m} aoConectar={aoReligar} />
        </div>
      ) : semNumero ? (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--gl-faint)' }}>
          {/*
            "não consegui ler" e não "não reporta consumo": são fatos
            diferentes, com causas e ações opostas. O tipo diz `null = não sei`,
            e traduzir isso numa afirmação sobre a CAPACIDADE do motor seria
            afirmar o que o produto não sabe.
          */}
          não consegui ler a cota deste motor — {quandoFoiLido(m.lidoEm)}
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
          {/* O rótulo carrega o "%" — a barra sozinha desenhava "27 / 100", que
              o dono lê como "27 de 100 coisas". O denominador 100 é nosso, não
              de um teto que algum motor tenha informado. */}
          {m.sessao != null ? (
            <Barra usado={m.sessao} limite={100} nome={`sessão · ${m.sessao}% usado`} />
          ) : null}
          {m.semana != null ? (
            <Barra usado={m.semana} limite={100} nome={`semana · ${m.semana}% usado`} />
          ) : null}
          <div style={{ fontSize: 12.5, color: 'var(--gl-faint)' }}>{quandoFoiLido(m.lidoEm)}</div>
        </div>
      )}
    </div>
  )
}

/** Um número medido, com a mediana em destaque e a cauda ao lado. */
function Medida({ rotulo, d, sufixo }: { rotulo: string; d: Distribuicao; sufixo?: string }) {
  return (
    <div>
      <span className="pn-label">{rotulo}</span>
      <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
        {d.mediana}
        {sufixo ?? ''}
      </div>
      <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
        {/* A cauda ao lado da mediana, sempre. A mediana sozinha esconde a dor,
            e a média sozinha esconde o caso típico — as duas juntas é que
            descrevem o ciclo. */}
        90% abaixo de {d.p90}
        {sufixo ?? ''} · pior {d.maximo}
        {sufixo ?? ''}
      </div>
    </div>
  )
}

/**
 * Quanto o ciclo custa, contando o retrabalho.
 *
 * O raciocínio do dono: "se o modelo é 20x melhor que humano, mas teve 5
 * retrabalhos, o ganho real não é 20x". Por isso a conta desconta o retrabalho
 * — e por isso o número vem do NOSSO banco, nunca de um multiplicador de fora.
 */
function ONossoCiclo() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<CicloView, CicloView>(ROTAS.ciclo + filtroDeProjeto(projeto), {
    vazio: (d) => d.entregas === 0,
  })

  return (
    <Card
      titulo="O nosso ciclo, com o retrabalho descontado"
      sub="Medido no seu banco, não estimado."
    >
      <Estados
        r={r}
        o_que="a medição do ciclo"
        vazio="Nenhuma entrega ainda para medir. A conta aparece com a primeira."
      >
        {(c) => (
          <>
            <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
              <div>
                <span className="pn-label">Saem de primeira</span>
                <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
                  {Math.round((c.dePrimeira / c.entregas) * 100)}%
                </div>
                <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
                  {c.dePrimeira} de {c.entregas}, sem ninguém empurrar
                </div>
              </div>
              <Medida rotulo="Cutucadas por entrega" d={c.cutucadas} />
              <Medida rotulo="Falhas ao mesclar" d={c.falhasDeMerge} />
              {c.horasAteFechar && (
                <Medida rotulo="Horas até fechar" d={c.horasAteFechar} sufixo="h" />
              )}
            </div>

            {/* Um travessão sem explicação é indistinguível de zero para quem
                lê. O que não dá para medir aparece dito. */}
            {c.naoMedido.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <span className="pn-label">Ainda não consigo medir</span>
                <ul
                  style={{
                    margin: '6px 0 0',
                    paddingLeft: 18,
                    fontSize: 13,
                    color: 'var(--gl-muted)',
                  }}
                >
                  {c.naoMedido.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Estados>
    </Card>
  )
}

interface CotaView {
  motores: MotorCota[]
  cotaLida: boolean
  motivoDaCota: string | null
}

export function TelaCustos() {
  const motores = usePainelBusca<
    CotaView,
    { motores?: MotorCota[]; cotaLida?: boolean; motivoDaCota?: string | null }
  >(ROTAS.agentes, {
    mapear: (b) => ({
      motores: b.motores ?? [],
      // Ausente = resposta antiga: trata como não-lida em vez de afirmar que
      // leu. Nunca supor que a leitura aconteceu.
      cotaLida: b.cotaLida ?? false,
      motivoDaCota: b.motivoDaCota ?? null,
    }),
    // "Vazio" só quando o produto REALMENTE leu e não achou motor. Se não
    // conseguiu ler, isso não é vazio — é não saber, e tem tela própria.
    vazio: (d) => d.cotaLida && d.motores.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Custos e limites">
        Você usa a sua própria assinatura de cada ferramenta. O que o painel controla é quanto de
        cada cota já foi gasto, para nenhum motor travar no meio de uma entrega.
      </Cabeca>

      <ONossoCiclo />

      <p className="pn-eyebrow">
        Resumo do mês
        <SeloDemo mostrar />
      </p>
      <div className="pn-kpis">
        <Kpi l="Tarefas hoje" v={55} n="somando todos os motores" />
        <Kpi l="Motor mais perto do teto" v="95%" n="Antigravity · 38 de 40" tone="w" destaque />
        <Kpi l="Entregas no mês" v={16} n="média de 4 por semana" tone="g" />
        <Kpi l="Repositórios ativos" v={3} n="do teto de 5 do seu plano" />
      </div>

      <Card titulo="Cota de cada motor" sub="quanto já foi usado da sessão de agora e da semana">
        <Estados r={motores} o_que="as cotas dos motores" vazio="Nenhum motor conectado ainda.">
          {(d) =>
            !d.cotaLida ? (
              // Não é a mesma coisa que "não há motor", e não pode parecer.
              // E tem saída: a regra escrita do painel é que "não consegui
              // saber" oferece botão, ao contrário de "não tem nada".
              <div style={{ fontSize: 13, color: 'var(--gl-muted)' }}>
                <p style={{ margin: 0 }}>
                  {d.motivoDaCota ?? 'Não consegui ler a cota dos seus motores agora'}. Prefiro
                  dizer que não sei a mostrar um número que pode estar errado.
                </p>
                <button
                  className="pn-btn a sm"
                  style={{ marginTop: 10 }}
                  onClick={() => motores.recarregar()}
                >
                  Tentar de novo
                </button>
              </div>
            ) : (
              <div className="pn-3">
                {d.motores.map((m) => (
                  <MotorCard key={m.id} m={m} aoReligar={motores.recarregar} />
                ))}
              </div>
            )
          }
        </Estados>
      </Card>

      <Card flush titulo="Onde o esforço foi este mês" sub={<SeloDemo mostrar />}>
        <div className="pn-tw">
          <table>
            <thead>
              <tr>
                <th>Projeto</th>
                <th>Tarefas</th>
                <th>Fatia do esforço</th>
                <th>Entregas</th>
              </tr>
            </thead>
            <tbody>
              {DEMO.custoPorRepo.map((r) => (
                <tr key={r.repo}>
                  <td>
                    <b>{r.repo}</b>
                  </td>
                  <td className="num pn-nowrap">{r.tarefas}</td>
                  <td style={{ minWidth: 200 }}>
                    <div className="pn-brow">
                      <span className="num">{r.pct}%</span>
                    </div>
                    <div className="pn-bar" style={{ marginTop: 4 }}>
                      <i style={{ width: r.pct + '%' }} />
                    </div>
                  </td>
                  <td className="num pn-nowrap">{r.entregas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card titulo="Seu plano" sub={<SeloDemo mostrar />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 200 }}>
            <span className="pn-label">Plano atual</span>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              {DEMO.plano}
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              R$ 249 por repositório, por mês
            </div>
          </div>
          <div style={{ minWidth: 200 }}>
            <span className="pn-label">Cobrança deste mês</span>
            <div className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              R$ 747
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              3 repositórios ativos
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button className="pn-btn g">Ver faturas</button>
            <button className="pn-btn">Mudar de plano</button>
          </div>
        </div>
      </Card>
    </>
  )
}
