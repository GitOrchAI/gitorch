// Acompanha se o commit que acabou de ser mesclado realmente chegou ao ar —
// e não outro, mais antigo, que ficou preso na fila do executor.
//
// A armadilha, registrada na memória do projeto: com executor próprio lento
// e cancelamento de execução em fila, a publicação pode rodar para um commit
// ANTIGO. Já aconteceu de a mescla entrar e a publicação subir a versão
// anterior, deixando o site sem a correção — e ninguém percebeu. Por isso
// toda resposta aqui casa o commit da publicação (`head_sha` da execução, ou
// `sha` da publicação declarada) com o commit da mescla antes de dizer
// qualquer coisa. Sem essa comparação, dizer "publicado" é mentira.
//
// Segunda armadilha: o estado GERAL de uma execução de workflow fica
// "na fila" até tudo terminar — por isso o veredito olha as ETAPAS
// (os nomes dos jobs contam a história: build → deploy staging → smoke →
// gate → deploy prod → smoke prod), não só o resultado do conjunto.
//
// Terceira armadilha: quando o sinal é de deployment, um ambiente que não é
// produção pode falhar sem que o site em produção tenha caído — reportar o
// PIOR estado entre todos os ambientes esconde uma publicação em produção
// que deu certo atrás de um staging vermelho. O veredito segue PRODUÇÃO
// quando dá para saber qual ambiente é ela (`production_environment`, do
// próprio dado de publicação); falhas fora de produção viram observação
// visível nas etapas, não o veredito. Sem informação de produção (o caminho
// de workflow, que não tem objetos de deployment nenhum), o pior-vence
// continua sendo o padrão honesto.
//
// Quarta armadilha: um job cujo NOME diz que publica (deploy/publish/
// release/ship) voltando "skipped" não é o mesmo "skipped" normal de um job
// de reversão — reversão pular é o esperado quando nada deu errado; um job
// de publicação pular é a publicação não ter rodado. Contar isso como
// sucesso seria mentir que algo foi ao ar.
//
// Nenhuma chamada de rede é feita aqui — as leituras são injetadas (Tarefa
// 12 descobre o mecanismo; esta tarefa só interpreta o que já foi lido).

import type { Mecanismo } from './mecanismo-de-publicacao.js'

/**
 * Cadência da vigília pós-merge (Tarefa 17, R6 do controlador): de quanto em
 * quanto tempo uma sessão mesclada, ainda sem veredito de publicação, é
 * reexaminada. Mesma ordem de grandeza da vigília de sessões do dev
 * assíncrono — perguntar ao GitHub a cada tique do relógio (1 minuto)
 * gastaria a quota do cliente sem que nada tivesse mudado desde a última
 * olhada. Vive aqui (não em `scheduler.ts`) porque é o relógio E o teste
 * (`pos-merge.test.ts`) que precisam dela — nunca o número solto em nenhum
 * dos dois lados.
 */
export const CADENCIA_DE_PUBLICACAO_MS = 10 * 60_000

/**
 * Achado 1 da revisão da Tarefa 17: o primeiro tique depois do merge não tem
 * carência nenhuma (`deployCheckedAt` ainda nulo, a sessão é examinada de
 * imediato). No caminho de DEPLOYMENT, quando o CD ainda não criou o objeto
 * de publicação para o commit recém-mesclado, TODOS os ambientes respondem
 * "zero evidência" — e sem esta janela isso virava, na hora, o veredito
 * FINAL `sem-publicacao`: a sessão fechava em silêncio, sem avisar ninguém,
 * dizendo "este repositório não publica" justamente enquanto a publicação
 * estava começando. "Ainda não" e "nunca" são vereditos diferentes; esta
 * janela é o que separa um do outro.
 *
 * CRÍTICO 2 da revisão final da branch: a suposição original era que o
 * caminho de WORKFLOW não precisava desta janela, porque histórico normal
 * (repositório que já publicou antes) sempre resolveria em `commit-errado`
 * — uma saída segura de graça. Falso para o caso de histórico VAZIO: um
 * repositório que acabou de ganhar o workflow de publicação (inclusive se
 * fomos NÓS que o criamos) não tem execução NENHUMA ainda, e sem esta janela
 * isso virava `sem-publicacao` FINAL no primeiro tique — a mesma mentira que
 * esta janela existe para impedir no caminho de deployment, só que por outra
 * porta. `esperaSemEvidenciaMs` (agora `desdeAMescla` em
 * `acompanharPublicacao`) por isso também é usado por `acompanharPorWorkflow`
 * — ver `semEvidenciaDeTodoAmbiente` em `VereditoDaPublicacao`.
 *
 * Trinta minutos = três ciclos de `CADENCIA_DE_PUBLICACAO_MS` (dez minutos
 * cada — a cadência da própria vigília pós-merge, que também governa de
 * quanto em quanto tempo a sessão é reexaminada): folgado o bastante para um
 * pipeline de CD real (build → testes → imagem → deploy) registrar o
 * primeiro objeto de deployment, algo que normalmente leva minutos, não
 * dezenas de minutos, mesmo em pipelines lentos — e curto o bastante para o
 * dono ainda saber no mesmo dia que algo não publicou, em vez de esperar
 * indefinidamente (o dead end OPOSTO, que esta janela também existe para
 * evitar: ver `semEvidenciaDeTodoAmbiente` e `acompanharPorDeployment`).
 */
export const JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS = 30 * 60_000

/**
 * CRÍTICO 1 da revisão final da branch: teto para o estado `commit-errado`
 * (caminho de WORKFLOW) — mesmo espírito de `MAX_TENTATIVAS_DE_MERGE`
 * (qa-rails-mission.ts) e `TETO_DE_ESPERA_MS` (vigia-da-verificacao.ts): toda
 * espera sem fim declarado neste produto precisa de uma saída.
 *
 * `sessoesParaAcompanharPublicacao` (pos-merge.ts) trata `commit-errado` como
 * NÃO-final de propósito — a maioria dos casos se resolve sozinha: a
 * PRÓXIMA execução do CD já é a do commit certo (executor em fila lento,
 * execução antiga cancelada). Mas há repositórios em que a execução mais
 * recente NUNCA vai casar com o commit mesclado: um CD com filtro de
 * `paths` que não inclui o diff desta entrega, um gatilho só por tag, ou um
 * histórico grande o bastante para a nossa execução cair fora da primeira
 * página consultada (`per_page=10`). Nesses casos, sem teto, a sessão fica
 * aberta para sempre, e o GitHub é consultado a cada
 * `CADENCIA_DE_PUBLICACAO_MS` para sempre.
 *
 * O DOBRO de `JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS` (uma hora, seis ciclos
 * de dez minutos): aqui já existe PROVA de atividade real — uma execução
 * aconteceu, só que para outro commit — o que dá mais chance de se resolver
 * sozinho do que silêncio total (zero evidência), por isso merece mais
 * paciência que aquela janela. Ainda assim curto o bastante para o dono
 * saber no mesmo dia, em vez de a sessão nunca fechar.
 */
export const TETO_DE_COMMIT_ERRADO_MS = 60 * 60_000

/**
 * Achado da revisão pós-Leva A ("o teto que criamos cobre UM estado; os
 * vizinhos continuam sem saída"): teto ABSOLUTO da vigília pós-merge,
 * medido desde a mescla — o backstop que fecha a CLASSE inteira de "estado
 * que nunca sai sozinho", não mais um caso isolado por vez.
 *
 * `TETO_DE_COMMIT_ERRADO_MS` (uma hora) e
 * `JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS` (trinta minutos) já fecham dois
 * casos ESPECÍFICOS — mas pelo menos três vizinhos continuavam sem teto
 * nenhum: `falhou` (um CD que falha e ninguém manda rodar de novo);
 * `publicando` quando já existe EVIDÊNCIA real da publicação mas ela fica
 * parada num estado como "waiting" do GitHub — um ambiente com regra de
 * proteção esperando aprovador humano nunca é "zero evidência", então a
 * janela de tolerância nunca se aplicava a ele; e uma leitura ao GitHub que
 * falha PARA SEMPRE (instalação revogada, 403 permanente) — nesse último a
 * sessão nem chega a produzir um veredito de `acompanharPublicacao`, então
 * quem aplica este teto é sempre quem CHAMA esta função (scheduler.ts),
 * nunca ela sozinha.
 *
 * Vinte e quatro horas: doze vezes o pior caso já coberto (o teto de
 * `commit-errado`, 1h) — folga suficiente para um aprovador humano de
 * verdade agir dentro do MESMO dia útil, ou até a manhã seguinte, sem que
 * isso vire alarme falso contra um CD que está funcionando exatamente como
 * configurado (é o próprio risco que motivou este valor maior, em vez de
 * copiar a mesma ordem de grandeza dos tetos específicos). Curto o
 * bastante para o dono nunca passar mais de um dia sem saber que uma
 * entrega mesclada não teve a publicação confirmada. Os tetos por estado
 * continuam dando o veredito mais rápido e mais específico quando se
 * aplicam; este é só o BACKSTOP — entra quando nenhum dos outros resolveu
 * a tempo.
 */
export const TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS = 24 * 60 * 60_000

/**
 * `GET /repos/{o}/{r}/actions/workflows/{arquivo}/runs` — e também o formato
 * de `GET /repos/{o}/{r}/actions/runs/{id}`. Assinatura provada ao vivo
 * contra a API do GitHub.
 */
export type ExecucaoDeWorkflow = {
  id: number
  name: string
  event: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null
  head_branch: string
  head_sha: string
  run_started_at: string
}

/**
 * `GET /repos/{o}/{r}/actions/runs/{id}/jobs` — os nomes dos jobs contam a
 * história (build → deploy staging → smoke → gate → deploy prod → smoke
 * prod).
 */
export type EtapaDaExecucao = {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null
}

/** `GET /repos/{o}/{r}/deployments?environment=&sha=` — já filtrado pelo commit. */
export type PublicacaoDeclarada = {
  id: number
  environment: string
  sha: string
  production_environment: boolean
  transient_environment: boolean
}

/** `GET /repos/{o}/{r}/deployments/{id}/statuses` — mais novo primeiro. */
export type EstadoDaPublicacao = {
  state:
    'waiting' | 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive' | string
  environment: string
  environment_url: string | null
  created_at: string
}

export type VereditoDaPublicacao = {
  estado: 'no-ar' | 'publicando' | 'falhou' | 'commit-errado' | 'sem-publicacao'
  etapas: Array<{ nome: string; resultado: string }>
  enderecos: string[]
  motivo: string
  /**
   * Achado 1 da revisão da Tarefa 17: `true` quando NENHUMA publicação foi
   * achada para o commit mesclado (zero evidência, não apenas um resultado
   * ruim) — no caminho de DEPLOYMENT, em NENHUM dos ambientes declarados; no
   * caminho de WORKFLOW (CRÍTICO 2 da revisão final), quando o histórico do
   * workflow de publicação está inteiramente VAZIO. É o sinal de quando
   * `desdeAMescla` (`acompanharPublicacao`) decide começar a contar a janela
   * de tolerância (`JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS`).
   *
   * No caminho de deployment, `false` sempre que QUALQUER ambiente tiver
   * alguma publicação encontrada — mesmo inativa ou em estado desconhecido,
   * porque isso já é evidência real de que algo aconteceu, não "ainda não
   * aconteceu nada". No caminho de workflow, `false` quando existe QUALQUER
   * execução no histórico (mesmo que seja de outro commit — `commit-errado`
   * é evidência de atividade real, governada pelo teto separado
   * `TETO_DE_COMMIT_ERRADO_MS`, não por esta janela).
   */
  semEvidenciaDeTodoAmbiente: boolean
}

/**
 * Fecha, de forma uniforme, qualquer estado que `TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS`
 * alcançou sem um veredito final — não importa se veio de `acompanharPublicacao`
 * (`falhou`, `publicando`, `commit-errado`) ou de uma leitura ao GitHub que
 * nunca chegou a funcionar (`ultimaObservacao` descreve em texto livre o que
 * aconteceu, para os dois casos — é a "última coisa que vimos" que o dono lê).
 *
 * Sempre `sem-publicacao`: é o mesmo veredito FINAL que os outros dois
 * caminhos de "não confirmamos" já usam (mecanismo inexistente, janela de
 * zero evidência esgotada) — reaproveitar em vez de inventar um sexto estado
 * evita espalhar mais um literal por `SEVERIDADE`, `ESTADOS_FINAIS`
 * (pos-merge.ts) e todo switch que já trata `VereditoDaPublicacao['estado']`.
 */
export function fecharPorTetoAbsoluto(args: {
  desdeAMescla: number
  ultimaObservacao: string
}): VereditoDaPublicacao {
  const horas = Math.round(args.desdeAMescla / 3_600_000)
  return {
    estado: 'sem-publicacao',
    etapas: [],
    enderecos: [],
    motivo:
      `mesclamos e acompanhamos por ${horas}h sem conseguir confirmar que a publicação chegou ` +
      `ao ar. Última coisa que vimos: ${args.ultimaObservacao}.`,
    semEvidenciaDeTodoAmbiente: false,
  }
}

/** Conclusões de etapa que representam um término normal (não é falha). */
const CONCLUSOES_SEM_FALHA = new Set(['success', 'skipped'])

/**
 * Palavras que, no NOME de um job, indicam que ele publica de fato — não
 * apenas verifica (build/test/lint) nem reverte. Lista nomeada e exportada
 * de propósito, no mesmo espírito do `VOCABULARIO_DE_VERIFICACAO` da Tarefa
 * 12 (`mecanismo-de-publicacao.ts`): quem precisar reconhecer mais um termo
 * de publicação mexe só aqui.
 *
 * Limite conhecido: é correspondência de palavra inteira sobre o nome do
 * job, não uma lista fechada de jobs reais — um job de publicação nomeado
 * fora deste vocabulário (ex.: "Sobe pro ar") não é reconhecido, e um
 * `skipped` nele continua sendo tratado como normal. Igualmente, um job que
 * apenas MENCIONA uma dessas palavras sem publicar nada (raro, mas
 * possível) seria falsamente marcado como suspeito.
 */
export const VOCABULARIO_DE_PUBLICACAO = ['deploy', 'publish', 'release', 'ship'] as const

const PADRAO_JOB_DE_PUBLICACAO = new RegExp(`\\b(${VOCABULARIO_DE_PUBLICACAO.join('|')})\\b`, 'i')

/**
 * Jobs de reversão/rollback: pular é o comportamento NORMAL quando nada deu
 * errado (a etapa só roda em caso de falha) — nunca suspeito, mesmo que o
 * nome também contenha uma palavra do vocabulário de publicação (ex.:
 * "Rollback do deploy").
 */
const PADRAO_JOB_DE_REVERSAO = /\b(rollback|revert)\b/i

/**
 * Um job de publicação que voltou "skipped" não prova que a publicação
 * rodou — ao contrário de um job de reversão pulado (o normal), ou de um
 * job qualquer sem nome de publicação (irrelevante para a prova).
 */
function jobDePublicacaoFoiPulado(etapa: EtapaDaExecucao): boolean {
  if (etapa.status !== 'completed' || etapa.conclusion !== 'skipped') {
    return false
  }
  if (PADRAO_JOB_DE_REVERSAO.test(etapa.name)) {
    return false
  }
  return PADRAO_JOB_DE_PUBLICACAO.test(etapa.name)
}

/** Estados de publicação (deployment) que ainda estão em andamento. */
const ESTADOS_EM_ANDAMENTO = new Set(['waiting', 'queued', 'in_progress', 'pending'])

/** Estados de publicação (deployment) que representam falha de fato. */
const ESTADOS_DE_FALHA = new Set(['failure', 'error'])

/**
 * Ordem de severidade ao combinar o resultado de vários ambientes num único
 * veredito: uma falha em qualquer ambiente domina sobre os demais, do mesmo
 * jeito que uma etapa com `failure` domina sobre um conjunto majoritariamente
 * verde no caminho de workflow.
 */
const SEVERIDADE: Record<'falhou' | 'publicando' | 'sem-publicacao' | 'no-ar', number> = {
  falhou: 0,
  publicando: 1,
  'sem-publicacao': 2,
  'no-ar': 3,
}

export async function acompanharPublicacao(args: {
  mecanismo: Mecanismo
  shaDaMescla: string
  /** Lê as execuções recentes do workflow de publicação (arquivo já resolvido pela Tarefa 12). */
  lerExecucoes: (arquivo: string) => Promise<ExecucaoDeWorkflow[]>
  /** Lê os jobs de uma execução específica. */
  lerEtapas: (idDaExecucao: number) => Promise<EtapaDaExecucao[]>
  /** Lê as publicações declaradas de um ambiente, já filtradas pelo commit. */
  lerPublicacoes: (ambiente: string, sha: string) => Promise<PublicacaoDeclarada[]>
  /** Lê os estados de uma publicação declarada, mais novo primeiro. */
  lerEstadosDaPublicacao: (idDaPublicacao: number) => Promise<EstadoDaPublicacao[]>
  /**
   * Há quanto tempo (ms) o merge desta entrega aconteceu — o mesmo relógio
   * usado tanto para a janela de tolerância de zero evidência
   * (`JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS`, os dois caminhos) quanto para
   * o teto de `commit-errado` (`TETO_DE_COMMIT_ERRADO_MS`, caminho de
   * workflow). Quem mede esse tempo é quem chama esta função (scheduler.ts,
   * a partir de `stateCheckedAt` — Importante 5 da revisão final: sobrevive
   * a reinício do processo); esta função só decide com base nele — nunca lê
   * hora nem toca banco.
   *
   * Omitido: nenhuma das duas checagens de tempo dispara — cada uma cai no
   * comportamento de sempre (a janela de zero evidência finaliza na hora, o
   * teto de commit-errado nunca finaliza sozinho), preservado para quem não
   * passa este argumento (a maioria dos testes deste arquivo).
   */
  desdeAMescla?: number
}): Promise<VereditoDaPublicacao> {
  const { mecanismo, shaDaMescla, desdeAMescla } = args

  if (mecanismo.tipo === 'nenhum') {
    return {
      estado: 'sem-publicacao',
      etapas: [],
      enderecos: [],
      motivo: 'este repositório não tem mecanismo de publicação declarado.',
      semEvidenciaDeTodoAmbiente: false,
    }
  }

  if (mecanismo.tipo === 'workflow') {
    return acompanharPorWorkflow(
      mecanismo,
      shaDaMescla,
      args.lerExecucoes,
      args.lerEtapas,
      desdeAMescla
    )
  }

  return acompanharPorDeployment(
    mecanismo,
    shaDaMescla,
    args.lerPublicacoes,
    args.lerEstadosDaPublicacao,
    desdeAMescla
  )
}

async function acompanharPorWorkflow(
  mecanismo: Extract<Mecanismo, { tipo: 'workflow' }>,
  shaDaMescla: string,
  lerExecucoes: (arquivo: string) => Promise<ExecucaoDeWorkflow[]>,
  lerEtapas: (idDaExecucao: number) => Promise<EtapaDaExecucao[]>,
  desdeAMescla: number | undefined
): Promise<VereditoDaPublicacao> {
  // A API lista as execuções mais recentes primeiro — por isso a primeira
  // que bater com o commit da mescla já é a que importa.
  const execucoes = await lerExecucoes(mecanismo.arquivo)
  const execucaoDoCommit = execucoes.find((e) => e.head_sha === shaDaMescla)

  if (!execucaoDoCommit) {
    const execucaoMaisRecente = execucoes[0]
    if (!execucaoMaisRecente) {
      // CRÍTICO 2 da revisão final: histórico vazio não distingue "ainda não
      // publicou" de "nunca vai publicar" — a mesma janela de tolerância do
      // caminho de deployment agora também governa aqui. Sem ela, um
      // repositório que acabou de ganhar o workflow de publicação tinha o
      // veredito FINAL `sem-publicacao` no primeiro tique depois do merge, a
      // sessão fechando calada ~1 minuto após mesclar.
      if (desdeAMescla !== undefined && desdeAMescla < JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS) {
        return {
          estado: 'publicando',
          etapas: [],
          enderecos: [],
          motivo:
            `ainda não há nenhuma execução de "${mecanismo.nome}" registrada para o commit ` +
            `mesclado (${shaDaMescla}); aguardando dentro da janela de tolerância (esperando ` +
            `há ${Math.round(desdeAMescla / 60_000)} min de ` +
            `${Math.round(JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS / 60_000)} min).`,
          semEvidenciaDeTodoAmbiente: true,
        }
      }
      return {
        estado: 'sem-publicacao',
        etapas: [],
        enderecos: [],
        motivo: `nenhuma execução de "${mecanismo.nome}" foi encontrada ainda para o commit mesclado.`,
        semEvidenciaDeTodoAmbiente: true,
      }
    }
    // CRÍTICO 1 da revisão final: sem teto, `commit-errado` nunca é tratado
    // como final por `sessoesParaAcompanharPublicacao` (pos-merge.ts) de
    // propósito — a maioria dos casos se resolve sozinha (a próxima
    // execução já é do commit certo). Mas quando o CD tem filtro de
    // `paths`, dispara só por tag, ou a execução certa nunca cai na primeira
    // página consultada, a execução mais recente NUNCA vai casar — sem
    // teto, a sessão ficava aberta e o GitHub era consultado para sempre.
    if (desdeAMescla !== undefined && desdeAMescla >= TETO_DE_COMMIT_ERRADO_MS) {
      return {
        estado: 'sem-publicacao',
        etapas: [],
        enderecos: [],
        motivo:
          `mesclamos, e não conseguimos confirmar a publicação deste commit: a execução mais ` +
          `recente de "${mecanismo.nome}" continua sendo de outro commit ` +
          `(${execucaoMaisRecente.head_sha}) depois de ${Math.round(desdeAMescla / 60_000)} min ` +
          `de espera — pode ser um filtro de caminho no CD, um gatilho só por tag, ou o ` +
          `repositório ter execuções demais para a nossa aparecer na primeira página consultada.`,
        semEvidenciaDeTodoAmbiente: false,
      }
    }
    // A armadilha central desta tarefa: existe execução recente, mas de
    // OUTRO commit — com executor lento e cancelamento em fila, a
    // publicação pode estar rodando (ou ter rodado) para uma versão antiga.
    // Dizer "no ar" aqui seria mentira.
    return {
      estado: 'commit-errado',
      etapas: [],
      enderecos: [],
      motivo: `a execução mais recente de "${mecanismo.nome}" é de outro commit (${execucaoMaisRecente.head_sha}), possivelmente uma versão antiga presa na fila — não do commit mesclado (${shaDaMescla}).`,
      semEvidenciaDeTodoAmbiente: false,
    }
  }

  const etapasBrutas = await lerEtapas(execucaoDoCommit.id)
  const etapas = etapasBrutas.map((e) => ({ nome: e.name, resultado: e.conclusion ?? e.status }))

  // `skipped` é normal (etapas de reversão só rodam quando algo falha) e
  // NÃO é falha — por isso só conta como falha uma etapa concluída cuja
  // conclusão não é nem `success` nem `skipped`.
  const etapaComFalha = etapasBrutas.find(
    (e) =>
      e.status === 'completed' && e.conclusion !== null && !CONCLUSOES_SEM_FALHA.has(e.conclusion)
  )
  if (etapaComFalha) {
    return {
      estado: 'falhou',
      etapas,
      enderecos: [],
      motivo: `a etapa "${etapaComFalha.name}" terminou com "${etapaComFalha.conclusion}".`,
      semEvidenciaDeTodoAmbiente: false,
    }
  }

  // O estado GERAL da execução fica "na fila" até tudo terminar — por isso
  // aqui se olha etapa por etapa, não o resultado do conjunto.
  const etapaEmAndamento = etapasBrutas.find((e) => e.status !== 'completed')
  if (etapaEmAndamento) {
    return {
      estado: 'publicando',
      etapas,
      enderecos: [],
      motivo: `a etapa "${etapaEmAndamento.name}" ainda não terminou.`,
      semEvidenciaDeTodoAmbiente: false,
    }
  }

  // Um job de PUBLICAÇÃO pulado não é o "skipped normal" de uma reversão —
  // é a publicação não tendo rodado. Não é falha de desenvolvimento (nada
  // quebrou) nem sucesso (nada foi ao ar): é "sem prova de publicação".
  const jobDePublicacaoPulado = etapasBrutas.find(jobDePublicacaoFoiPulado)
  if (jobDePublicacaoPulado) {
    return {
      estado: 'sem-publicacao',
      etapas,
      enderecos: [],
      motivo: `a etapa "${jobDePublicacaoPulado.name}" publica e foi pulada — não há prova de que a publicação rodou para o commit mesclado.`,
      semEvidenciaDeTodoAmbiente: false,
    }
  }

  return {
    estado: 'no-ar',
    etapas,
    enderecos: [],
    motivo: `todas as etapas de "${mecanismo.nome}" terminaram (sucesso, ou pulo esperado de reversão).`,
    semEvidenciaDeTodoAmbiente: false,
  }
}

/** Os quatro estados de ambiente possíveis no caminho de deployment (fora `commit-errado`, que só existe no caminho de workflow). */
type EstadoDeAmbiente = keyof typeof SEVERIDADE

/** O resultado de checar UM ambiente, junto da informação de produção quando ela existir. */
type ResultadoDoAmbiente = {
  estado: EstadoDeAmbiente
  motivo: string
  /**
   * `true` só quando uma publicação FOI encontrada para este ambiente e ela
   * declarou (`production_environment`) ser o ambiente de produção. Sem
   * publicação nenhuma encontrada, não dá para saber — fica `false`, e o
   * ambiente não entra na decisão orientada por produção (cai no
   * pior-vence geral, como antes).
   */
  producao: boolean
  /**
   * Achado 1 da revisão da Tarefa 17: `true` só na leitura mais crua
   * possível — NENHUMA publicação declarada para este ambiente e commit
   * (`publicacoes.length === 0`, depois do filtro de defesa pelo commit). É
   * diferente de "publicação inativa" ou "estado desconhecido": nesses dois
   * casos um objeto de deployment EXISTIU, o que já é evidência de que algo
   * aconteceu. Aqui não existiu nada — pode ser "o CD ainda não chegou lá"
   * (achado 1), e é isso que decide se o veredito deste ambiente pode virar
   * FINAL agora ou precisa esperar a janela de tolerância.
   */
  evidenciaZero: boolean
}

async function acompanharPorDeployment(
  mecanismo: Extract<Mecanismo, { tipo: 'deployment' }>,
  shaDaMescla: string,
  lerPublicacoes: (ambiente: string, sha: string) => Promise<PublicacaoDeclarada[]>,
  lerEstadosDaPublicacao: (idDaPublicacao: number) => Promise<EstadoDaPublicacao[]>,
  desdeAMescla: number | undefined
): Promise<VereditoDaPublicacao> {
  const etapas: Array<{ nome: string; resultado: string }> = []
  const enderecos: string[] = []
  const resultados: ResultadoDoAmbiente[] = []

  for (const ambiente of mecanismo.ambientes) {
    // O pedido de leitura já é filtrado pelo commit (`sha=` na consulta) —
    // ainda assim a resposta é revalidada aqui: casar o commit é a regra
    // que não pode falhar nesta tarefa, e não deve depender só de quem
    // implementa a leitura ter filtrado direito.
    const publicacoes = (await lerPublicacoes(ambiente, shaDaMescla)).filter(
      (p) => p.sha === shaDaMescla
    )

    if (publicacoes.length === 0) {
      etapas.push({ nome: `Publicação em ${ambiente}`, resultado: 'sem-publicacao' })
      resultados.push({
        estado: 'sem-publicacao',
        motivo: `nenhuma publicação em "${ambiente}" para o commit mesclado.`,
        producao: false,
        evidenciaZero: true,
      })
      continue
    }

    // Se houver mais de uma publicação declarada para o mesmo ambiente e
    // commit (reexecução manual, por exemplo), o id mais alto é o mais
    // recente — o GitHub numera deployments de forma sequencial.
    const publicacao = publicacoes.reduce((mais, atual) => (atual.id > mais.id ? atual : mais))
    const producao = publicacao.production_environment
    const estados = await lerEstadosDaPublicacao(publicacao.id)
    const estadoMaisNovo = estados[0]

    if (!estadoMaisNovo) {
      etapas.push({ nome: `Publicação em ${ambiente}`, resultado: 'sem-estado' })
      resultados.push({
        estado: 'publicando',
        motivo: `publicação em "${ambiente}" foi criada mas ainda não relatou estado.`,
        producao,
        evidenciaZero: false,
      })
      continue
    }

    etapas.push({ nome: `Publicação em ${ambiente}`, resultado: estadoMaisNovo.state })

    if (estadoMaisNovo.state === 'success') {
      if (estadoMaisNovo.environment_url) {
        enderecos.push(estadoMaisNovo.environment_url)
      }
      resultados.push({
        estado: 'no-ar',
        motivo: `"${ambiente}" está no ar.`,
        producao,
        evidenciaZero: false,
      })
    } else if (ESTADOS_DE_FALHA.has(estadoMaisNovo.state)) {
      resultados.push({
        estado: 'falhou',
        motivo: `publicação em "${ambiente}" terminou em "${estadoMaisNovo.state}".`,
        producao,
        evidenciaZero: false,
      })
    } else if (ESTADOS_EM_ANDAMENTO.has(estadoMaisNovo.state)) {
      resultados.push({
        estado: 'publicando',
        motivo: `publicação em "${ambiente}" ainda está "${estadoMaisNovo.state}".`,
        producao,
        evidenciaZero: false,
      })
    } else if (estadoMaisNovo.state === 'inactive') {
      // Uma publicação inativa foi substituída por outra mais nova — não é
      // falha (nada deu errado), mas também não está mais no ar agora. É
      // evidência REAL de que algo aconteceu (nunca "zero evidência" — o
      // achado 1 não se aplica aqui).
      resultados.push({
        estado: 'sem-publicacao',
        motivo: `publicação em "${ambiente}" ficou inativa — foi substituída por outra.`,
        producao,
        evidenciaZero: false,
      })
    } else {
      resultados.push({
        estado: 'sem-publicacao',
        motivo: `publicação em "${ambiente}" está em estado desconhecido ("${estadoMaisNovo.state}").`,
        producao,
        evidenciaZero: false,
      })
    }
  }

  // Achado 1 da revisão da Tarefa 17: quando NENHUM ambiente tem publicação
  // nenhuma para este commit (zero evidência em todos, não um resultado
  // ruim), "ainda não" e "nunca" são o mesmo dado — só o tempo decorrido os
  // separa. Dentro da janela de tolerância, o veredito honesto é "ainda
  // publicando" (não-final, reexaminado na próxima cadência); esgotada a
  // janela, cai para a agregação normal abaixo, que resolve em
  // `sem-publicacao` (final) pelas mesmas regras de sempre.
  const todosSemEvidencia = resultados.length > 0 && resultados.every((r) => r.evidenciaZero)
  if (
    todosSemEvidencia &&
    desdeAMescla !== undefined &&
    desdeAMescla < JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS
  ) {
    return {
      estado: 'publicando',
      etapas,
      enderecos: [],
      motivo:
        `ainda não há publicação registrada para o commit mesclado (${shaDaMescla}) em ` +
        `nenhum dos ambientes declarados (${mecanismo.ambientes.join(', ')}); aguardando ` +
        `dentro da janela de tolerância (esperando há ${Math.round(desdeAMescla / 60_000)} ` +
        `min de ${Math.round(JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS / 60_000)} min).`,
      semEvidenciaDeTodoAmbiente: true,
    }
  }

  // Quando algum ambiente se declarou produção, o veredito segue SÓ os
  // ambientes de produção (pior-vence entre eles, para o caso raro de mais
  // de um) — um staging vermelho não pode esconder uma produção no ar, e o
  // inverso (produção vermelha atrás de um staging verde) também não pode
  // ser escondido. As falhas fora de produção continuam visíveis em
  // `etapas`, só não decidem o veredito. Sem NENHUM ambiente de produção
  // identificável (nenhuma publicação encontrada, ou a leitura real nunca
  // declara `production_environment`), cai no pior-vence entre TODOS os
  // ambientes — o mesmo comportamento de antes desta correção, o padrão
  // honesto para quando não dá para distinguir produção do resto.
  const resultadosDeProducao = resultados.filter((r) => r.producao)
  const base = resultadosDeProducao.length > 0 ? resultadosDeProducao : resultados

  // `mecanismo.ambientes` nunca vem vazio (a Tarefa 12 só devolve `tipo:
  // 'deployment'` quando há pelo menos um ambiente declarado), então `base`
  // sempre tem ao menos um elemento — o `null` inicial abaixo é só para o
  // tipo nunca escapar sem essa garantia expressa em código.
  let piorEstado: EstadoDeAmbiente | null = null
  let motivo = `nenhum ambiente publicou o commit mesclado (${shaDaMescla}).`
  for (const r of base) {
    if (piorEstado === null || SEVERIDADE[r.estado] < SEVERIDADE[piorEstado]) {
      piorEstado = r.estado
      motivo = r.motivo
    }
  }

  return {
    estado: piorEstado ?? 'sem-publicacao',
    etapas,
    enderecos,
    motivo,
    semEvidenciaDeTodoAmbiente: todosSemEvidencia,
  }
}
