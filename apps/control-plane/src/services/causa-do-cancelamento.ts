// L4-T17 — medido AO VIVO em loureng/patinhas-3d-crafts (05/09/2026): 8 PRs
// abertos, 5 com vários checks cancelados e NENHUM parecer do QA — param em
// silêncio. Causa provada no run 33943490885 do PR #3945: o workflow do
// cliente tem um job de qualidade (lint, tipagem, formatação) com um passo
// `if: failure()` que roda `gh run cancel` no PRÓPRIO run. O passo que
// falhou foi "Prettier (formatação consistente)" — e o cancelamento em
// cadeia derruba todo o resto.
//
// A armadilha: o job que causou tudo TERMINA marcado `cancelled` no nível do
// PRÓPRIO job (não `failure`) — o pedido de cancelamento do run alcança
// aquele job antes de o GitHub fechar a conclusão dele como falha. A API de
// check-runs (`/commits/{sha}/check-runs`, a que o produto já consulta hoje)
// nunca mostra os passos — só a API de jobs do Actions
// (`GET /repos/{o}/{r}/actions/jobs/{id}`, que usa o MESMO id do check-run)
// devolve `steps[]` com o passo que falhou de verdade.
//
// Este módulo separa a DECISÃO (pura, testável com fixture, sem rede) da
// BUSCA (I/O, testável com um fetcher falso) — mesmo padrão de
// incidente-ci.ts (`coletarAchadosDeInfra` recebe `fetchImpl`).

import { neutralizarTextoDeTerceiros } from './decisao-de-automacao.js'

/** Conclusões de STEP que provam falha real — mesmo conjunto de incidente-ci.ts. */
const CONCLUSOES_DE_FALHA_REAL = new Set(['failure', 'timed_out', 'startup_failure'])

/** Conclusões de JOB que não escondem passo nenhum que interesse investigar. */
const CONCLUSOES_QUE_NAO_PRECISAM_DE_PASSOS = new Set(['success', 'neutral', 'skipped'])

/** Um passo (step) de um job do GitHub Actions. */
export interface PassoDoJob {
  name: string
  conclusion?: string | null | undefined
  /** ISO de quando o passo terminou — usado para achar QUEM falhou primeiro. */
  completedAt?: string | null | undefined
}

/** Um job do GitHub Actions, com os passos JÁ buscados (ou ainda não). */
export interface JobComPassos {
  name: string
  conclusion?: string | null | undefined
  /** `undefined` quando os passos ainda não foram buscados para este job. */
  steps?: readonly PassoDoJob[] | undefined
}

/**
 * Um check-run, reduzido ao que basta para decidir SE vale a pena buscar os
 * passos. `id` é o MESMO id do job na API de Actions — GitHub reusa o
 * espaço de ids entre as duas APIs, então não precisa de outra correlação
 * (nem parsear `details_url`).
 */
export interface JobDoGithub {
  id: number
  name: string
  conclusion?: string | null | undefined
}

export interface CulpadoDoCancelamento {
  job: string
  passo: string
}

/**
 * Resultado de `acharCulpadoDoCancelamento` / `investigarCancelamentoEmCadeia`:
 *
 *  - `{ encontrado: false }` — nenhum passo, em nenhum job, prova falha real
 *    (cancelamento SEM culpa: push novo ou concorrência derrubando tudo).
 *  - `{ encontrado: true, ambiguo: false, job, passo }` — exatamente um
 *    passo se destaca como "o mais antigo" entre os que falharam de
 *    verdade: é a causa.
 *  - `{ encontrado: true, ambiguo: true, candidatos }` — HÁ falha real (um
 *    ou mais passos), mas não existe critério confiável para apontar QUAL
 *    foi a causa raiz (achado 2/3 da revisão, ver `acharCulpadoDoCancelamento`
 *    abaixo). Continua sendo uma reprovação real — só a explicação nomeia
 *    todos os candidatos em vez de escolher um ao acaso.
 */
export type ResultadoDoCulpado =
  | { encontrado: false }
  | ({ encontrado: true; ambiguo: false } & CulpadoDoCancelamento)
  | { encontrado: true; ambiguo: true; candidatos: readonly CulpadoDoCancelamento[] }

/** A metade de `ResultadoDoCulpado` que `frasarCausaDoCancelamento` sabe explicar. */
type CulpadoEncontrado = Extract<ResultadoDoCulpado, { encontrado: true }>

function temHorarioValido(completedAt: string | null | undefined): completedAt is string {
  return typeof completedAt === 'string' && completedAt.length > 0
}

/**
 * Acha o job/passo que REALMENTE falhou em meio a jobs cancelados.
 *
 * Quando mais de um job tem um passo com falha real — o job-gate que só
 * confere "os outros passaram?" (padrão comum em CI com trava cruzada)
 * também acaba falhando, mas como CONSEQUÊNCIA, não como causa —, o
 * critério é QUEM FALHOU PRIMEIRO: o passo cujo `completedAt` é o mais
 * antigo entre os que provam falha real. Não precisa reconhecer "isto é um
 * job-gate" pelo nome, só saber que a causa raiz sempre termina ANTES do
 * sintoma.
 *
 * Dois jeitos de o critério do relógio FALHAR, achados na revisão:
 *
 *  1. (achado 2) Passo sem `completedAt` nunca pode "ganhar" por default de
 *     comparação — texto vazio ordena antes de qualquer data ISO real, o
 *     que fazia um passo SEM horário virar "o mais antigo" sem nenhuma
 *     evidência de que terminou primeiro. Só concorrem pelo posto de "mais
 *     antigo" os passos que TÊM horário; um passo sem horário nunca ganha
 *     de um que tem.
 *  2. (achado 3) Dois (ou mais) passos podem terminar no MESMO instante —
 *     ou, no limite, NENHUM candidato ter horário nenhum. Nesses dois
 *     casos não existe critério confiável para desempatar: a única
 *     diferença restante seria a ordem de chegada da resposta da API
 *     (`jobs`/`steps`), que não tem relação causal nenhuma com quem
 *     realmente falhou primeiro. Mais honesto declarar `ambiguo: true`
 *     com todos os candidatos do que apontar um ao acaso.
 */
export function acharCulpadoDoCancelamento(jobs: readonly JobComPassos[]): ResultadoDoCulpado {
  const candidatos: Array<{ job: JobComPassos; passo: PassoDoJob }> = []
  for (const job of jobs) {
    for (const passo of job.steps ?? []) {
      if (CONCLUSOES_DE_FALHA_REAL.has(passo.conclusion ?? '')) {
        candidatos.push({ job, passo })
      }
    }
  }
  if (candidatos.length === 0) return { encontrado: false }
  if (candidatos.length === 1) {
    const unico = candidatos[0]!
    return { encontrado: true, ambiguo: false, job: unico.job.name, passo: unico.passo.name }
  }

  const comHorario = candidatos.filter((c) => temHorarioValido(c.passo.completedAt))
  const empatarComoAmbiguo = (
    lista: ReadonlyArray<{ job: JobComPassos; passo: PassoDoJob }>
  ): ResultadoDoCulpado => ({
    encontrado: true,
    ambiguo: true,
    candidatos: lista.map((c) => ({ job: c.job.name, passo: c.passo.name })),
  })

  // Nenhum candidato tem horário: não sobra NENHUM critério (nem data, nem
  // outro campo confiável) — a ordem de chegada da API não conta.
  if (comHorario.length === 0) return empatarComoAmbiguo(candidatos)

  const maisCedo = comHorario.reduce((a, b) =>
    a.passo.completedAt!.localeCompare(b.passo.completedAt!) <= 0 ? a : b
  )
  const empatados = comHorario.filter((c) => c.passo.completedAt === maisCedo.passo.completedAt)
  if (empatados.length > 1) return empatarComoAmbiguo(empatados)

  return { encontrado: true, ambiguo: false, job: maisCedo.job.name, passo: maisCedo.passo.name }
}

/** L4-T17 (achado 4): teto de tamanho do nome de job/passo dentro do
 *  parecer — bem menor que os 2000 caracteres da resposta livre inteira
 *  (`TETO_DE_CARACTERES_DA_RESPOSTA_LIVRE`, decisao-de-automacao.ts): nome
 *  de job/passo nunca precisa ser um texto longo, e um workflow hostil não
 *  pode inflar o comentário público com um `name:` gigante. */
export const TETO_DE_CARACTERES_DO_NOME_NO_PARECER = 200

/**
 * L4-T17 (achado 4) — SEGURANÇA: nome de job e de passo vêm CRUS do arquivo
 * de workflow do cliente (quem escreveu o YAML escolhe o `name:`) e vão
 * para um comentário PÚBLICO na proposta/PR do cliente. Sem tratamento, um
 * nome como `"@alguem urgente"` faz o GitHub resolver a menção e notificar
 * uma conta de verdade — o MESMO risco que `sanitizarRespostaLivre`
 * (services/decisao-de-automacao.ts) já trata para a resposta livre do
 * dono. Reaproveita o mesmo núcleo (`neutralizarTextoDeTerceiros`): teto de
 * tamanho PRÓPRIO (bem menor — ver constante acima) + menção/comando
 * neutralizados. NÃO reaproveita o bloco de citação (`> ` por linha): esse
 * formato é para um texto autônomo virando um parágrafo citado; aqui o
 * nome entra NO MEIO de uma frase, e "> " ali quebraria a leitura sem
 * proteger nada a mais.
 *
 * Depois de neutralizado, o nome ainda entra em marcação de código (crase):
 * no GitHub, menção e o resto da formatação markdown não são interpretados
 * DENTRO de um code span — segunda camada, defesa em profundidade (mesma
 * doutrina do resto do produto: a checagem mora na PORTA, não só em quem
 * produz o valor). Uma crase LITERAL no nome do cliente quebraria esse
 * span cedo demais (`"abc\`def"` viraria código `abc` + texto solto
 * "def\`") — por isso troca crase por um acento agudo visualmente parecido
 * ANTES de embrulhar. Essa troca é só estética: a neutralização de
 * menção/comando já rodou antes dela e não depende do code span para
 * valer — mesmo o trecho que "escapasse" do span continua sem menção
 * funcional.
 */
function nomeSeguroParaComentario(nome: string): string {
  const neutralizado = neutralizarTextoDeTerceiros(nome, TETO_DE_CARACTERES_DO_NOME_NO_PARECER)
  const semCrase = neutralizado.replace(/`/g, '´')
  return `\`${semCrase}\``
}

/**
 * Monta, em português simples e sem jargão de integração contínua, a frase
 * que explica a causa a quem vai consertar. O nome do passo já vem em
 * português do próprio workflow do cliente (quem escreveu o YAML escolheu
 * esse nome) — citar ele direto já basta, sem tentar adivinhar sinônimo.
 * Nomes sempre saem sanitizados (achado 4, `nomeSeguroParaComentario`).
 *
 * Quando o resultado é ambíguo (achado 3: mais de um passo falhou de
 * verdade, sem critério confiável para dizer qual foi primeiro), a frase
 * DIZ isso — lista os candidatos em vez de apontar um sozinho como se
 * fosse certeza.
 */
export function frasarCausaDoCancelamento(culpado: CulpadoEncontrado): string {
  if (!culpado.ambiguo) {
    return (
      `A verificação automática parou no passo ${nomeSeguroParaComentario(culpado.passo)} — ` +
      `dentro de ${nomeSeguroParaComentario(culpado.job)} — e o resto foi cancelado por ` +
      `consequência, não por outro defeito.`
    )
  }
  const lista = culpado.candidatos
    .map((c) => `${nomeSeguroParaComentario(c.passo)} (em ${nomeSeguroParaComentario(c.job)})`)
    .join('; ')
  return (
    `A verificação automática foi cancelada com mais de um passo falhando ao mesmo tempo — ` +
    `${lista} — sem um jeito confiável de saber qual foi a causa raiz e qual foi ` +
    `consequência. O resto foi cancelado junto.`
  )
}

/** L4-T17 (achado 5): uma chamada de rede por job não-passante, todas ao
 *  mesmo tempo, vira uma rajada de dezenas de chamadas simultâneas contra o
 *  MESMO token do GitHub quando o workflow do cliente usa matriz ou muitos
 *  shards. Teto pequeno e explícito — não é ajuste fino de performance, é
 *  produto: nunca martelar a API do cliente com mais que isto em voo ao
 *  mesmo tempo. */
export const LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO = 4

/**
 * Roda `tarefa` para cada item de `itens`, no máximo `limite` de cada vez —
 * nunca todas ao mesmo tempo. Cada `tarefa` já é best-effort (quem chama
 * decide o que fazer com uma falha, normalmente com `.catch`); este laço só
 * limita QUANTAS rodam simultaneamente, nunca decide o que fazer com uma
 * falha individual — por isso uma tarefa que rejeita ainda derruba
 * `Promise.all` mais abaixo se o chamador não tratar a rejeição antes.
 */
async function mapComLimiteDeConcorrencia<T, R>(
  itens: readonly T[],
  limite: number,
  tarefa: (item: T) => Promise<R>
): Promise<R[]> {
  const resultados: R[] = new Array(itens.length)
  let proximoIndice = 0
  const trabalhador = async (): Promise<void> => {
    while (proximoIndice < itens.length) {
      const indice = proximoIndice++
      resultados[indice] = await tarefa(itens[indice] as T)
    }
  }
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, trabalhador)
  await Promise.all(trabalhadores)
  return resultados
}

/**
 * Busca os passos de cada job que NÃO passou (best-effort: um job cuja
 * busca falhar entra como "sem passos", nunca derruba a investigação
 * inteira) e devolve o culpado, se houver.
 *
 * Só busca passos dos jobs candidatos — sucesso/neutro/skipped não escondem
 * passo nenhum que interesse, e pedir os passos deles seria gastar chamada
 * de rede à toa. As buscas rodam com um teto de concorrência (achado 5,
 * `LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO`) — nunca todas ao mesmo tempo.
 */
export async function investigarCancelamentoEmCadeia(
  jobs: readonly JobDoGithub[],
  buscarPassosDoJob: (jobId: number) => Promise<readonly PassoDoJob[]>
): Promise<ResultadoDoCulpado> {
  const candidatos = jobs.filter(
    (j) => !CONCLUSOES_QUE_NAO_PRECISAM_DE_PASSOS.has(j.conclusion ?? '')
  )
  if (candidatos.length === 0) return { encontrado: false }
  const comPassos = await mapComLimiteDeConcorrencia(
    candidatos,
    LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO,
    async (job) => ({
      job,
      steps: await buscarPassosDoJob(job.id).catch(() => [] as readonly PassoDoJob[]),
    })
  )
  return acharCulpadoDoCancelamento(
    comPassos.map(({ job, steps }) => ({ name: job.name, conclusion: job.conclusion, steps }))
  )
}
