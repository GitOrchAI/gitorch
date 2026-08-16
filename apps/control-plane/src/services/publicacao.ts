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

  return {
    estado: 'no-ar',
    etapas,
    enderecos: [],
    motivo: `todas as etapas de "${mecanismo.nome}" terminaram (sucesso, ou pulo esperado de reversão).`,
  }
}

async function acompanharPorDeployment(
  mecanismo: Extract<Mecanismo, { tipo: 'deployment' }>,
  shaDaMescla: string,
  lerPublicacoes: (ambiente: string, sha: string) => Promise<PublicacaoDeclarada[]>,
  lerEstadosDaPublicacao: (idDaPublicacao: number) => Promise<EstadoDaPublicacao[]>
): Promise<VereditoDaPublicacao> {
  const etapas: Array<{ nome: string; resultado: string }> = []
  const enderecos: string[] = []

  // Sem placeholder de "sem-publicacao" aqui: `no-ar` tem a MAIOR severidade
  // numérica (é o melhor caso, só vence quando nada pior foi visto), então
  // um valor inicial dentro da própria escala nunca poderia ser batido por
  // ele. `null` representa "nenhum ambiente processado ainda" de verdade.
  let piorEstado: 'falhou' | 'publicando' | 'sem-publicacao' | 'no-ar' | null = null
  let motivo = `nenhum ambiente publicou o commit mesclado (${shaDaMescla}).`

  const registrar = (
    estado: 'falhou' | 'publicando' | 'sem-publicacao' | 'no-ar',
    porque: string
  ): void => {
    if (piorEstado === null || SEVERIDADE[estado] < SEVERIDADE[piorEstado]) {
      piorEstado = estado
      motivo = porque
    }
  }

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
      registrar('sem-publicacao', `nenhuma publicação em "${ambiente}" para o commit mesclado.`)
      continue
    }

    // Se houver mais de uma publicação declarada para o mesmo ambiente e
    // commit (reexecução manual, por exemplo), o id mais alto é o mais
    // recente — o GitHub numera deployments de forma sequencial.
    const publicacao = publicacoes.reduce((mais, atual) => (atual.id > mais.id ? atual : mais))
    const estados = await lerEstadosDaPublicacao(publicacao.id)
    const estadoMaisNovo = estados[0]

    if (!estadoMaisNovo) {
      etapas.push({ nome: `Publicação em ${ambiente}`, resultado: 'sem-estado' })
      registrar(
        'publicando',
        `publicação em "${ambiente}" foi criada mas ainda não relatou estado.`
      )
      continue
    }

    etapas.push({ nome: `Publicação em ${ambiente}`, resultado: estadoMaisNovo.state })

    if (estadoMaisNovo.state === 'success') {
      if (estadoMaisNovo.environment_url) {
        enderecos.push(estadoMaisNovo.environment_url)
      }
      registrar('no-ar', `"${ambiente}" está no ar.`)
    } else if (ESTADOS_DE_FALHA.has(estadoMaisNovo.state)) {
      registrar('falhou', `publicação em "${ambiente}" terminou em "${estadoMaisNovo.state}".`)
    } else if (ESTADOS_EM_ANDAMENTO.has(estadoMaisNovo.state)) {
      registrar('publicando', `publicação em "${ambiente}" ainda está "${estadoMaisNovo.state}".`)
    } else if (estadoMaisNovo.state === 'inactive') {
      // Uma publicação inativa foi substituída por outra mais nova — não é
      // falha (nada deu errado), mas também não está mais no ar agora.
      registrar(
        'sem-publicacao',
        `publicação em "${ambiente}" ficou inativa — foi substituída por outra.`
      )
    } else {
      registrar(
        'sem-publicacao',
        `publicação em "${ambiente}" está em estado desconhecido ("${estadoMaisNovo.state}").`
      )
    }
  }

  // `mecanismo.ambientes` nunca vem vazio (a Tarefa 12 só devolve `tipo:
  // 'deployment'` quando há pelo menos um ambiente declarado) — o fallback
  // abaixo é só defensivo, para o tipo nunca escapar como `null`.
  return { estado: piorEstado ?? 'sem-publicacao', etapas, enderecos, motivo }
}
