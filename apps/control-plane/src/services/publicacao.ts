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
}): Promise<VereditoDaPublicacao> {
  const { mecanismo, shaDaMescla } = args

  if (mecanismo.tipo === 'nenhum') {
    return {
      estado: 'sem-publicacao',
      etapas: [],
      enderecos: [],
      motivo: 'este repositório não tem mecanismo de publicação declarado.',
    }
  }

  if (mecanismo.tipo === 'workflow') {
    return acompanharPorWorkflow(mecanismo, shaDaMescla, args.lerExecucoes, args.lerEtapas)
  }

  return acompanharPorDeployment(
    mecanismo,
    shaDaMescla,
    args.lerPublicacoes,
    args.lerEstadosDaPublicacao
  )
}

async function acompanharPorWorkflow(
  mecanismo: Extract<Mecanismo, { tipo: 'workflow' }>,
  shaDaMescla: string,
  lerExecucoes: (arquivo: string) => Promise<ExecucaoDeWorkflow[]>,
  lerEtapas: (idDaExecucao: number) => Promise<EtapaDaExecucao[]>
): Promise<VereditoDaPublicacao> {
  // A API lista as execuções mais recentes primeiro — por isso a primeira
  // que bater com o commit da mescla já é a que importa.
  const execucoes = await lerExecucoes(mecanismo.arquivo)
  const execucaoDoCommit = execucoes.find((e) => e.head_sha === shaDaMescla)

  if (!execucaoDoCommit) {
    const execucaoMaisRecente = execucoes[0]
    if (!execucaoMaisRecente) {
      return {
        estado: 'sem-publicacao',
        etapas: [],
        enderecos: [],
        motivo: `nenhuma execução de "${mecanismo.nome}" foi encontrada ainda para o commit mesclado.`,
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
    }
  }

  return {
    estado: 'no-ar',
    etapas,
    enderecos: [],
    motivo: `todas as etapas de "${mecanismo.nome}" terminaram (sucesso, ou pulo esperado de reversão).`,
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
}

async function acompanharPorDeployment(
  mecanismo: Extract<Mecanismo, { tipo: 'deployment' }>,
  shaDaMescla: string,
  lerPublicacoes: (ambiente: string, sha: string) => Promise<PublicacaoDeclarada[]>,
  lerEstadosDaPublicacao: (idDaPublicacao: number) => Promise<EstadoDaPublicacao[]>
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
      })
      continue
    }

    etapas.push({ nome: `Publicação em ${ambiente}`, resultado: estadoMaisNovo.state })

    if (estadoMaisNovo.state === 'success') {
      if (estadoMaisNovo.environment_url) {
        enderecos.push(estadoMaisNovo.environment_url)
      }
      resultados.push({ estado: 'no-ar', motivo: `"${ambiente}" está no ar.`, producao })
    } else if (ESTADOS_DE_FALHA.has(estadoMaisNovo.state)) {
      resultados.push({
        estado: 'falhou',
        motivo: `publicação em "${ambiente}" terminou em "${estadoMaisNovo.state}".`,
        producao,
      })
    } else if (ESTADOS_EM_ANDAMENTO.has(estadoMaisNovo.state)) {
      resultados.push({
        estado: 'publicando',
        motivo: `publicação em "${ambiente}" ainda está "${estadoMaisNovo.state}".`,
        producao,
      })
    } else if (estadoMaisNovo.state === 'inactive') {
      // Uma publicação inativa foi substituída por outra mais nova — não é
      // falha (nada deu errado), mas também não está mais no ar agora.
      resultados.push({
        estado: 'sem-publicacao',
        motivo: `publicação em "${ambiente}" ficou inativa — foi substituída por outra.`,
        producao,
      })
    } else {
      resultados.push({
        estado: 'sem-publicacao',
        motivo: `publicação em "${ambiente}" está em estado desconhecido ("${estadoMaisNovo.state}").`,
        producao,
      })
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

  return { estado: piorEstado ?? 'sem-publicacao', etapas, enderecos, motivo }
}
