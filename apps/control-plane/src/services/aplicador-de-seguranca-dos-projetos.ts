// A etapa que aplica, de verdade, as melhorias de segurança que o GitHub oferece
// no repositório de cada projeto. Roda depois da medição (a nota de segurança),
// em segundo plano, e é cuidadosa por construção:
//
//  - UM projeto por passada, o que está há mais tempo sem passada;
//  - dentro do projeto, no máximo UMA melhoria por passada (um pull request é
//    uma melhoria, ainda que leve três chamadas), em ordem fixa;
//  - pelo menos 30 min entre duas passadas do mesmo projeto (6 h sem
//    administração, 1 h quando falta credencial ou a sondagem falhou);
//  - antes de qualquer leitura, as travas de projeto: interruptor geral, lista
//    de projetos e autonomia "cuidar" nos DOIS campos. Projeto barrado não gasta
//    nem uma chamada;
//  - cada escrita relê antes e confirma depois, guarda o estado anterior e deixa
//    no painel o texto de COMO DESFAZER;
//  - todo erro vira um estado explícito (recusado, indisponível, falhou,
//    incerto); nenhum vira "aplicado" por engano.
//
// Uma falha daqui nunca derruba o tique nem impede a medição da nota.

import type { Prisma } from '@prisma/client'
import type {
  PrismaDeFichas,
  PrismaDoAplicador,
  PrismaDoDesfazer,
} from './prisma-de-fichas-de-seguranca.js'
import { buildFreeTextOption } from './telegram-bot.js'
import {
  aplicarMelhoriaDeSeguranca,
  melhoriaNaListaBranca,
} from './aplicar-melhoria-de-seguranca.js'
import {
  acompanharPrDeSeguranca,
  comoDesfazerDaMelhoria,
  conferirConfiguracaoAplicada,
  desfazerMelhoriaDeSeguranca,
  ehRegistroDoPr,
  executarAlternativaDeSenhas,
  executarMelhoriaDeConfiguracao,
  executarPermissoesMinimas,
  textoSeguroParaOPainel,
  type ContextoDeExecucao,
  type EstadoDaMelhoria,
  type MelhoriaDeConfiguracao,
  type RegistroDaMelhoria,
  type RegistroDoPr,
  type ResultadoDaAplicacao,
} from './executores-de-seguranca.js'
import { criarEscritorDeSeguranca, type RitmoDeEscrita } from './escritor-de-seguranca.js'
import { erroDaRespostaDoGitHub } from './erro-do-github.js'
import {
  donoDoRepositorio,
  freioDeCotaAtivo,
  pularSeFreioDeCotaAtivo,
  registrarFreioDeCota,
} from './freio-de-cota-do-github.js'
import {
  aplicacaoDeSegurancaLigada,
  idBaseDaMelhoria,
  melhoriaDeSegurancaLigada,
  projetoNaAllowlistDaSeguranca,
  type Ambiente,
} from './interruptores-de-seguranca.js'
import { criarLeitorDeSeguranca, campoDe, erroDeRedeSeguro } from './leitor-de-seguranca.js'
import {
  chaveDoEventoDaMelhoria,
  idDasPermissoesMinimas,
  planejarMelhorias,
  proximaTentativaApos,
  textoDoEventoDaMelhoria,
  type Candidata,
} from './melhorias-de-seguranca.js'
import { registrarNoPainelSeForNovo } from './registro-no-painel.js'
import {
  gravarSondagem,
  invalidarSondagem,
  obterSondagem,
  type CredencialDaSondagem,
  type SondagemDoRepositorio,
} from './sondagem-de-seguranca.js'
import { limparSurrogatesEmJson, mascararCredenciais, mensagemDoErro } from './texto-seguro.js'
import { repositorioValido } from './nota-de-seguranca.js'
import { podeEscrever } from '@gitorch/cadence'
import { caminhoDeWorkflowValido } from './workflows-de-seguranca.js'

export const INTERVALO_ENTRE_PASSADAS_MS = 30 * 60_000
export const INTERVALO_SEM_ADMIN_MS = 6 * 60 * 60_000
export const INTERVALO_SEM_CREDENCIAL_MS = 60 * 60_000
export const ORCAMENTO_DA_APLICACAO_MS = 120_000
/** Folga da reserva do projeto além do orçamento da passada. */
const FOLGA_DA_RESERVA_MS = 60_000

/**
 * Os projetos com passada em andamento neste processo. Uma segunda chamada que
 * chegue enquanto a primeira não terminou escolhe outro projeto (ou nenhum): duas
 * passadas nunca aplicam a mesma melhoria ao mesmo tempo. Entre processos, a
 * reserva gravada na ficha faz o mesmo papel (ver `passadaDoProjeto`).
 */
const projetosEmPassada = new Set<string>()

const MAX_ACOMPANHAMENTOS_POR_PASSADA = 3
const MAX_PERGUNTAS_POR_PASSADA = 2

export const PREFIXO_DA_PERGUNTA_DE_PERMISSOES = 'seguranca-permissoes:'
export const RESPOSTA_PODE_APLICAR_NO_DEPLOY = 'permissoes-deploy-aplicar'
export const RESPOSTA_MANTER_O_DEPLOY = 'permissoes-deploy-manter'
export const RESPOSTA_EXPLICAR_O_DEPLOY = 'permissoes-deploy-explicar'

export interface ProjetoParaAplicar {
  id: string
  /** `dono/repo`. */
  wingId: string
  userId: string | null
  autonomia: string | null
  autonomiaDeSeguranca: string | null
}

/** Só o que o aplicador precisa do serviço de perguntas ao dono. */
export interface AgentQuestionAskerDeSeguranca {
  ask: (
    userId: string,
    projectId: string,
    input: {
      text: string
      options?: Array<{ label: string; value: string }>
      dedupKey?: string
    }
  ) => Promise<unknown>
}

export type { PrismaDoAplicador } from './prisma-de-fichas-de-seguranca.js'

export type ResultadoDaPassadaDeAplicacao =
  | 'nada-a-fazer'
  | 'aplicou'
  | 'sem-melhoria'
  | 'sem-credencial'
  | 'sem-sondagem'
  | 'freio'
  | 'abandonado'
  | 'falhou'

export interface ResumoDaAplicacao {
  resultado: ResultadoDaPassadaDeAplicacao
  repositorio: string | null
  /** A melhoria que a passada tentou (quando tentou uma). */
  melhoria: string | null
  estado: EstadoDaMelhoria | null
}

// ------------------------------------------------------------------ ficha

const TIPO_DA_FICHA = 'melhorias'

interface FichaDeMelhorias {
  proximaPassadaEm: string | null
  melhorias: Record<string, RegistroDaMelhoria>
}

const ESTADOS: readonly string[] = [
  'aplicado',
  'aguardando-revisao',
  'aguardando-dono',
  'recusado',
  'indisponivel',
  'incerto',
  'falhou',
  'desfeito',
  'dispensado',
]

function ehRegistro(v: unknown): v is RegistroDaMelhoria {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof campoDe(v, 'estado') === 'string' &&
    ESTADOS.includes(campoDe(v, 'estado') as string) &&
    typeof campoDe(v, 'atualizadoEm') === 'string' &&
    typeof campoDe(v, 'motivo') === 'string' &&
    typeof campoDe(v, 'desfazer') === 'string' &&
    typeof campoDe(v, 'tentativas') === 'number' &&
    (campoDe(v, 'pr') === undefined || ehRegistroDoPr(campoDe(v, 'pr')))
  )
}

export function lerFichaDeMelhorias(estado: unknown): FichaDeMelhorias {
  const vazia: FichaDeMelhorias = { proximaPassadaEm: null, melhorias: {} }
  if (typeof estado !== 'object' || estado === null) return vazia
  const proxima = campoDe(estado, 'proximaPassadaEm')
  const bruto = campoDe(estado, 'melhorias')
  const melhorias: Record<string, RegistroDaMelhoria> = {}
  if (typeof bruto === 'object' && bruto !== null) {
    for (const [id, registro] of Object.entries(bruto)) {
      if (melhoriaNaListaBranca(id) && ehRegistro(registro)) melhorias[id] = registro
    }
  }
  return {
    proximaPassadaEm:
      typeof proxima === 'string' && !Number.isNaN(Date.parse(proxima)) ? proxima : null,
    melhorias,
  }
}

async function salvarFicha(
  prisma: PrismaDeFichas,
  projectId: string,
  ficha: FichaDeMelhorias
): Promise<void> {
  const estado = limparSurrogatesEmJson({
    versao: 1,
    proximaPassadaEm: ficha.proximaPassadaEm,
    melhorias: ficha.melhorias,
  }) as unknown as Prisma.InputJsonObject
  await prisma.repoItem.upsert({
    where: { projectId_tipo_numero: { projectId, tipo: TIPO_DA_FICHA, numero: 0 } },
    create: { projectId, tipo: TIPO_DA_FICHA, numero: 0, estado },
    update: { estado },
  })
}

// ------------------------------------------------------------------ elegibilidade

/** Pode receber alguma escrita? As mesmas travas de projeto de `aplicarMelhoriaDeSeguranca`, antes de gastar uma leitura. */
export function projetoPodeReceberMelhorias(projeto: ProjetoParaAplicar, env: Ambiente): boolean {
  return (
    repositorioValido(projeto.wingId) &&
    aplicacaoDeSegurancaLigada(env) &&
    projetoNaAllowlistDaSeguranca(projeto, env) &&
    podeEscrever(projeto.autonomia, 'mesclar').pode &&
    podeEscrever(projeto.autonomiaDeSeguranca, 'mesclar').pode
  )
}

// ------------------------------------------------------------------ a passada

export interface DepsDoAplicador {
  prisma: PrismaDoAplicador
  projetos: ProjetoParaAplicar[]
  agora: () => Date
  /**
   * As credenciais que alcançam o repositório, na ordem de preferência
   * (cliente/dono primeiro). Servem à LEITURA e à configuração por API, nunca a
   * pull request. O token global do produto (`GITORCH_GITHUB_TOKEN`) não entra
   * aqui: nenhuma escrita do aplicador o usa.
   */
  credenciais: (projeto: ProjetoParaAplicar) => Promise<CredencialDaSondagem[]>
  /**
   * A credencial do App (instalação) que assina TODO pull request do aplicador.
   * `null` = sem o App neste repositório, e então nenhum pull request é aberto.
   */
  tokenDoApp: (projeto: ProjetoParaAplicar) => Promise<string | null>
  /** Só leitura: o `fetch` sem permissão de escrita. */
  fetchDeLeitura: typeof fetch
  /** O `fetch` de escrita DO PROJETO: já amarrado à guarda de autonomia. */
  fetchDeEscrita: (projeto: ProjetoParaAplicar) => typeof fetch
  /** O ritmo de escrita do processo (pausa mínima entre escritas). */
  ritmo: RitmoDeEscrita
  agentQuestion: AgentQuestionAskerDeSeguranca | null
  env?: Ambiente
  intervaloMs?: number
  orcamentoMs?: number
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

interface DadosDoRegistro {
  estado: EstadoDaMelhoria
  motivo: string
  anterior?: unknown
  pr?: RegistroDoPr
  limitada?: boolean
}

function aplicarResultadoNaSondagem(
  sondagem: SondagemDoRepositorio,
  id: string,
  resultado: ResultadoDaAplicacao
): SondagemDoRepositorio {
  const novo: SondagemDoRepositorio = { ...sondagem }
  const virou =
    resultado.estado === 'aplicado'
      ? 'ligado'
      : resultado.estado === 'indisponivel'
        ? 'indisponivel'
        : null
  if (virou === null) return novo
  switch (id) {
    case 'alertas-de-dependencias':
      novo.alertasDeDependencias = virou
      break
    case 'atualizacoes-de-seguranca':
      novo.atualizacoesDeSeguranca = virou
      break
    case 'varredura-de-senhas':
      novo.segredos = virou
      novo.bloqueioDePush = virou
      break
    case 'varredura-de-codigo':
      novo.varreduraDeCodigo = virou
      break
    case 'permissao-padrao-do-workflow':
      if (virou === 'ligado') novo.permissaoDoWorkflow = 'read'
      break
  }
  return novo
}

/** Uma passada: escolhe UM projeto elegível e vencido e cuida dele. Nunca lança. */
export async function aplicarMelhoriasDeSegurancaDosProjetos(
  deps: DepsDoAplicador
): Promise<ResumoDaAplicacao> {
  const env = deps.env ?? process.env
  const intervaloMs = deps.intervaloMs ?? INTERVALO_ENTRE_PASSADAS_MS
  const orcamentoMs = deps.orcamentoMs ?? ORCAMENTO_DA_APLICACAO_MS
  const info = (m: string) => {
    try {
      deps.onInfo?.(`[Scheduler] ${m}`)
    } catch {
      // um log que quebra não derruba a passada
    }
  }
  const aviso = (m: string) => {
    try {
      deps.onWarn?.(`[Scheduler] ${m}`)
    } catch {
      // idem
    }
  }
  const nada: ResumoDaAplicacao = {
    resultado: 'nada-a-fazer',
    repositorio: null,
    melhoria: null,
    estado: null,
  }

  try {
    const elegiveis = deps.projetos.filter((p) => projetoPodeReceberMelhorias(p, env))
    if (elegiveis.length === 0) return nada

    const fichasBrutas = await deps.prisma.repoItem.findMany({
      where: { projectId: { in: elegiveis.map((p) => p.id) }, tipo: TIPO_DA_FICHA, numero: 0 },
      select: { projectId: true, estado: true },
    })
    const fichas = new Map(fichasBrutas.map((f) => [f.projectId, lerFichaDeMelhorias(f.estado)]))
    const agora = deps.agora()
    const jaAvisados = new Set<string>()

    let bloqueadosPeloFreio = 0
    const vencidos = elegiveis
      .map((projeto) => ({ projeto, ficha: fichas.get(projeto.id) ?? lerFichaDeMelhorias(null) }))
      .filter(
        ({ projeto, ficha }) =>
          !projetosEmPassada.has(projeto.id) &&
          (ficha.proximaPassadaEm === null || Date.parse(ficha.proximaPassadaEm) <= agora.getTime())
      )
      .sort(
        (a, b) =>
          Date.parse(a.ficha.proximaPassadaEm ?? '1970-01-01') -
          Date.parse(b.ficha.proximaPassadaEm ?? '1970-01-01')
      )
      .filter(({ projeto }) => {
        const emFreio = pularSeFreioDeCotaAtivo({
          etapa: 'aplicarMelhoriasDeSeguranca',
          repositorio: projeto.wingId,
          agora,
          jaAvisados,
          info,
        })
        if (emFreio) bloqueadosPeloFreio += 1
        return !emFreio
      })
    const escolhido = vencidos[0]
    if (!escolhido) return bloqueadosPeloFreio > 0 ? { ...nada, resultado: 'freio' } : nada

    // Sem nenhum `await` entre a escolha e a marca: a segunda chamada já a enxerga.
    projetosEmPassada.add(escolhido.projeto.id)
    try {
      return await passadaDoProjeto({
        deps,
        env,
        projeto: escolhido.projeto,
        ficha: escolhido.ficha,
        intervaloMs,
        orcamentoMs,
        info,
        aviso,
      })
    } finally {
      projetosEmPassada.delete(escolhido.projeto.id)
    }
  } catch (erro) {
    aviso(`aplicarMelhoriasDeSeguranca falhou: ${erroDeRedeSeguro(erro, '')}`)
    return { ...nada, resultado: 'falhou' }
  }
}

async function passadaDoProjeto(args: {
  deps: DepsDoAplicador
  env: Ambiente
  projeto: ProjetoParaAplicar
  ficha: FichaDeMelhorias
  intervaloMs: number
  orcamentoMs: number
  info: (m: string) => void
  aviso: (m: string) => void
}): Promise<ResumoDaAplicacao> {
  const { deps, env, projeto, ficha, info, aviso } = args
  const repositorio = projeto.wingId
  const dono = donoDoRepositorio(repositorio)
  const resumo = (
    resultado: ResultadoDaPassadaDeAplicacao,
    melhoria: string | null = null,
    estado: EstadoDaMelhoria | null = null
  ): ResumoDaAplicacao => ({ resultado, repositorio, melhoria, estado })

  const controle = new AbortController()
  const temporizador = setTimeout(() => controle.abort(), args.orcamentoMs)
  /** As credenciais desta passada: nenhuma mensagem que as cite vai adiante. */
  let segredos: string[] = []

  const agendar = async (ms: number): Promise<void> => {
    ficha.proximaPassadaEm = new Date(deps.agora().getTime() + ms).toISOString()
    try {
      await salvarFicha(deps.prisma, projeto.id, ficha)
    } catch (erro) {
      aviso(
        `aplicar segurança em ${repositorio}: não consegui gravar a ficha: ${erroDeRedeSeguro(erro, '')}`
      )
    }
  }

  try {
    // Reserva o projeto antes de ler ou escrever qualquer coisa: se este processo
    // morrer no meio, ou se outro processo escolher projetos agora, o projeto só volta
    // a ser candidato depois do orçamento. Sem a reserva gravada, nada é escrito.
    ficha.proximaPassadaEm = new Date(
      deps.agora().getTime() + args.orcamentoMs + FOLGA_DA_RESERVA_MS
    ).toISOString()
    try {
      await salvarFicha(deps.prisma, projeto.id, ficha)
    } catch (erro) {
      aviso(
        `aplicar segurança em ${repositorio}: não consegui reservar o projeto: ${erroDeRedeSeguro(erro, '')}`
      )
      return resumo('falhou')
    }

    const credenciais = await deps.credenciais(projeto)
    const tokenDoApp = await deps.tokenDoApp(projeto)
    segredos = [...credenciais.map((c) => c.token), ...(tokenDoApp !== null ? [tokenDoApp] : [])]
    if (credenciais.length === 0) {
      aviso(
        `aplicar segurança: nenhuma credencial alcança ${repositorio}; tenta de novo mais tarde`
      )
      await agendar(INTERVALO_SEM_CREDENCIAL_MS)
      return resumo('sem-credencial')
    }

    const aoReceberRespostaRuim = (resposta: Response): void => {
      if (resposta.status !== 403 && resposta.status !== 429) return
      registrarFreioDeCota(
        dono,
        erroDaRespostaDoGitHub(`GitHub ${resposta.status} (${repositorio})`, resposta),
        deps.agora()
      )
    }
    const fetchDaPassada: typeof fetch = async (input, init) => {
      if (freioDeCotaAtivo(dono, deps.agora())) throw new Error('freio de cota do GitHub ativo')
      const sinal = init?.signal ? AbortSignal.any([init.signal, controle.signal]) : controle.signal
      return deps.fetchDeLeitura(input, { ...init, signal: sinal })
    }

    const obtida = await obterSondagem({
      prisma: deps.prisma,
      projectId: projeto.id,
      repositorio,
      credenciais,
      fetchImpl: fetchDaPassada,
      agora: deps.agora(),
      exigirAdmin: true,
      aoReceberRespostaRuim,
      onWarn: (m) => aviso(mascararCredenciais(m, segredos)),
    })
    if (controle.signal.aborted) {
      await agendar(args.intervaloMs)
      return resumo('abandonado')
    }
    if (obtida === null) {
      await agendar(INTERVALO_SEM_CREDENCIAL_MS)
      return resumo('sem-sondagem')
    }
    let sondagem = obtida.sondagem
    let sondagemInvalidada = false
    const credencial = obtida.credencial

    const ctx: ContextoDeExecucao = {
      repositorio,
      token: credencial.token,
      tokenDoApp,
      escritor: criarEscritorDeSeguranca({
        repositorio,
        fetchImpl: deps.fetchDeEscrita(projeto),
        ritmo: deps.ritmo,
        aoReceberRespostaRuim,
      }),
      ler: criarLeitorDeSeguranca({
        repositorio,
        token: credencial.token,
        fetchImpl: fetchDaPassada,
        aoReceberRespostaRuim,
      }),
      sondagem,
      agora: deps.agora(),
    }

    const registrar = async (id: string, resultado: DadosDoRegistro): Promise<void> => {
      const anterior = ficha.melhorias[id]
      const agoraIso = deps.agora().toISOString()
      const pr: RegistroDoPr | undefined = resultado.pr ?? anterior?.pr
      const dadoAnterior = resultado.anterior ?? anterior?.anterior
      const registro: RegistroDaMelhoria = {
        estado: resultado.estado,
        atualizadoEm: agoraIso,
        proximaTentativaEm:
          resultado.estado === 'recusado' ||
          resultado.estado === 'indisponivel' ||
          resultado.estado === 'falhou'
            ? proximaTentativaApos(resultado.estado, deps.agora(), resultado.limitada === true)
            : null,
        tentativas: (anterior?.tentativas ?? 0) + (resultado.estado === 'aguardando-dono' ? 0 : 1),
        motivo: textoSeguroParaOPainel(resultado.motivo, segredos),
        ...(dadoAnterior !== undefined ? { anterior: dadoAnterior } : {}),
        ...(pr ? { pr } : {}),
        desfazer: comoDesfazerDaMelhoria(id, repositorio),
      }
      ficha.melhorias[id] = registro
      try {
        await salvarFicha(deps.prisma, projeto.id, ficha)
      } catch (erro) {
        aviso(
          `aplicar segurança em ${repositorio}: não consegui gravar a ficha: ${erroDeRedeSeguro(erro, '')}`
        )
      }
      if (anterior?.estado === resultado.estado && anterior.motivo === registro.motivo) return
      try {
        await registrarNoPainelSeForNovo({
          prisma: deps.prisma,
          projectId: projeto.id,
          chave: chaveDoEventoDaMelhoria(repositorio, id, resultado.estado),
          texto: textoDoEventoDaMelhoria({
            repositorio,
            id,
            estado: resultado.estado,
            motivo: registro.motivo,
            desfazer: registro.desfazer,
          }),
        })
      } catch (erro) {
        aviso(
          `aplicar segurança em ${repositorio}: não consegui gravar no painel: ${erroDeRedeSeguro(erro, '')}`
        )
      }
    }

    const atualizarSondagem = async (
      id: string,
      resultado: ResultadoDaAplicacao
    ): Promise<void> => {
      sondagem = aplicarResultadoNaSondagem(sondagem, id, resultado)
      // Cache invalidado nesta passada (um PR foi mesclado): não o sobrescreve com a leitura velha.
      if (sondagemInvalidada) return
      try {
        await gravarSondagem(deps.prisma, projeto.id, sondagem)
      } catch (erro) {
        aviso(
          `aplicar segurança em ${repositorio}: não consegui gravar a sondagem: ${erroDeRedeSeguro(erro, '')}`
        )
      }
    }

    // O dono liberou algum workflow de deploy/CD?
    const liberados = new Set<string>()
    for (const [id, registro] of Object.entries(ficha.melhorias)) {
      if (
        registro.estado !== 'aguardando-dono' ||
        !id.startsWith('permissoes-minimas-dos-workflows:')
      )
        continue
      const caminho = id.slice('permissoes-minimas-dos-workflows:'.length)
      const resposta = await deps.prisma.agentQuestion.findFirst({
        where: {
          projectId: projeto.id,
          dedupKey: dedupKeyDaPergunta(repositorio, caminho),
          status: 'answered',
          answer: RESPOSTA_PODE_APLICAR_NO_DEPLOY,
        },
        select: { id: true },
      })
      if (resposta) liberados.add(caminho)
    }

    const plano = planejarMelhorias({
      sondagem,
      registros: ficha.melhorias,
      liberadosPeloDono: liberados,
      agora: deps.agora(),
    })

    // 1) Só leitura: confirmar o que ficou incerto e acompanhar os pull requests abertos.
    for (const { id } of plano.conferir.slice(0, MAX_ACOMPANHAMENTOS_POR_PASSADA)) {
      const base = idBaseDaMelhoria(id)
      if (
        base === null ||
        base === 'alternativa-de-varredura-de-senhas' ||
        base === 'permissoes-minimas-dos-workflows'
      )
        continue
      const r = await conferirConfiguracaoAplicada(base as MelhoriaDeConfiguracao, ctx)
      if (r.estado !== 'incerto') {
        await registrar(id, r)
        if (r.estado === 'aplicado') await atualizarSondagem(id, r)
      }
    }
    for (const { id, registro } of plano.acompanhar.slice(0, MAX_ACOMPANHAMENTOS_POR_PASSADA)) {
      const r = await acompanharPrDeSeguranca(registro, ctx)
      if (r.estado === 'aplicado' || r.estado === 'dispensado') {
        await registrar(id, { estado: r.estado, motivo: r.motivo })
        if (r.estado === 'aplicado') {
          try {
            await invalidarSondagem(deps.prisma, projeto.id)
            sondagemInvalidada = true
          } catch (erro) {
            aviso(
              `aplicar segurança em ${repositorio}: não consegui invalidar a sondagem: ${erroDeRedeSeguro(erro, '')}`
            )
          }
        }
      }
    }

    // 2) Workflows de deploy/CD: nunca mexe sem o dono; pergunta uma vez.
    let perguntados = 0
    for (const workflow of plano.perguntas) {
      if (perguntados >= MAX_PERGUNTAS_POR_PASSADA) break
      const id = idDasPermissoesMinimas(workflow.caminho)
      const dedupKey = dedupKeyDaPergunta(repositorio, workflow.caminho)
      try {
        const existente = await deps.prisma.agentQuestion.findFirst({
          where: { projectId: projeto.id, dedupKey, status: { in: ['open', 'answered'] } },
          select: { id: true },
        })
        if (existente) {
          await registrar(id, { estado: 'aguardando-dono', motivo: 'a pergunta ao dono já existe' })
          continue
        }
        if (projeto.userId === null || deps.agentQuestion === null) {
          aviso(
            `aplicar segurança em ${repositorio}: sem como perguntar ao dono sobre ${workflow.caminho}`
          )
          continue
        }
        perguntados += 1
        await deps.agentQuestion.ask(
          projeto.userId,
          projeto.id,
          montarPerguntaDePermissoesDoDeploy(repositorio, workflow.caminho)
        )
        await registrar(id, {
          estado: 'aguardando-dono',
          motivo: `perguntei ao dono se posso adicionar permissões mínimas em ${workflow.caminho}`,
        })
      } catch (erro) {
        aviso(
          `aplicar segurança em ${repositorio}: não consegui perguntar ao dono sobre ${workflow.caminho}: ${erroDeRedeSeguro(erro, '')}`
        )
      }
    }

    // 3) Workflows que o GitOrch decidiu não mexer: fica no painel, com o motivo.
    for (const nao of plano.naoMexidos) {
      await registrar(nao.id, { estado: 'dispensado', motivo: `não mexi: ${nao.motivo}` })
    }

    // 4) UMA melhoria por passada.
    for (const candidata of plano.candidatas) {
      if (controle.signal.aborted) break
      const base = idBaseDaMelhoria(candidata.id)
      if (base === null || !melhoriaDeSegurancaLigada(base, env)) continue

      const feito = await aplicarMelhoriaDeSeguranca({
        projeto,
        melhoria: candidata.id,
        autonomia: projeto.autonomia,
        autonomiaDeSeguranca: projeto.autonomiaDeSeguranca,
        env,
        aplicar: () => executarCandidata(candidata, ctx),
      })
      if (!feito.executado) {
        info(`aplicar segurança em ${repositorio}: ${candidata.id} barrada (${feito.bloqueadoPor})`)
        break
      }
      await registrar(candidata.id, feito.resultado)
      await atualizarSondagem(candidata.id, feito.resultado)
      await agendar(sondagem.comAdmin ? args.intervaloMs : INTERVALO_SEM_ADMIN_MS)
      return resumo('aplicou', candidata.id, feito.resultado.estado)
    }

    if (controle.signal.aborted) {
      await agendar(args.intervaloMs)
      return resumo('abandonado')
    }
    await agendar(sondagem.comAdmin ? args.intervaloMs : INTERVALO_SEM_ADMIN_MS)
    return resumo('sem-melhoria')
  } catch (erro) {
    if (controle.signal.aborted) {
      await agendar(args.intervaloMs)
      return resumo('abandonado')
    }
    aviso(
      `aplicar segurança em ${repositorio} falhou: ${mascararCredenciais(mensagemDoErro(erro), segredos)}`
    )
    await agendar(INTERVALO_SEM_CREDENCIAL_MS)
    return resumo('falhou')
  } finally {
    clearTimeout(temporizador)
  }
}

async function executarCandidata(
  candidata: Candidata,
  ctx: ContextoDeExecucao
): Promise<ResultadoDaAplicacao> {
  const base = idBaseDaMelhoria(candidata.id)
  switch (base) {
    case 'alertas-de-dependencias':
    case 'atualizacoes-de-seguranca':
    case 'varredura-de-senhas':
    case 'varredura-de-codigo':
    case 'permissao-padrao-do-workflow':
      return executarMelhoriaDeConfiguracao(base, ctx)
    case 'alternativa-de-varredura-de-senhas':
      return executarAlternativaDeSenhas(ctx)
    case 'permissoes-minimas-dos-workflows':
      if (!candidata.workflow || !caminhoDeWorkflowValido(candidata.workflow.caminho)) {
        return { estado: 'dispensado', motivo: 'o alvo da melhoria não é um workflow válido' }
      }
      return executarPermissoesMinimas(ctx, candidata.workflow, {
        liberadoPeloDono: candidata.liberadoPeloDono === true,
      })
    case null:
      return { estado: 'dispensado', motivo: 'melhoria desconhecida' }
  }
}

// ------------------------------------------------------------------ a pergunta ao dono

export function dedupKeyDaPergunta(repositorio: string, caminho: string): string {
  return `${PREFIXO_DA_PERGUNTA_DE_PERMISSOES}${repositorio}:${caminho}`
}

/** 3 opções objetivas + a aberta, como toda pergunta ao dono. */
export function montarPerguntaDePermissoesDoDeploy(
  repositorio: string,
  caminho: string
): { text: string; options: Array<{ label: string; value: string }>; dedupKey: string } {
  return {
    text:
      `O workflow ${caminho} de ${repositorio} publica ou entrega o projeto e não declara permissions, ` +
      'então o token dele pode ter escrita demais. Reduzir para só leitura é mais seguro, mas se algum passo ' +
      'do deploy precisar escrever (publicar pacote, criar release, comentar), a publicação pode quebrar. ' +
      'Posso abrir um pull request que adiciona "permissions: contents: read" a ele? Eu não mexo em deploy sem a sua resposta.',
    options: [
      { label: 'Pode abrir o pull request', value: RESPOSTA_PODE_APLICAR_NO_DEPLOY },
      { label: 'Deixe como está, eu cuido', value: RESPOSTA_MANTER_O_DEPLOY },
      { label: 'Me explique o risco antes', value: RESPOSTA_EXPLICAR_O_DEPLOY },
      buildFreeTextOption(),
    ],
    dedupKey: dedupKeyDaPergunta(repositorio, caminho),
  }
}

// ------------------------------------------------------------------ desfazer

/**
 * Desfaz uma melhoria que o GitOrch aplicou neste projeto e deixa o registro e o
 * painel em "desfeito". Não passa pelas travas de aplicação (desfazer reduz o que
 * o GitOrch fez), mas a escrita continua atrás da guarda de autonomia do `fetch`
 * recebido.
 */
export async function desfazerMelhoriaDoProjeto(deps: {
  prisma: PrismaDoDesfazer
  projeto: ProjetoParaAplicar
  melhoria: string
  credenciais: CredencialDaSondagem[]
  /** A credencial do App que assina o fechamento e a reversão de pull requests. */
  tokenDoApp: string | null
  fetchDeLeitura: typeof fetch
  fetchDeEscrita: typeof fetch
  ritmo: RitmoDeEscrita
  agora: () => Date
  onWarn?: (mensagem: string) => void
}): Promise<{ desfeito: boolean; motivo: string; pr?: RegistroDoPr }> {
  const repositorio = deps.projeto.wingId
  const segredos = [
    ...deps.credenciais.map((c) => c.token),
    ...(deps.tokenDoApp !== null ? [deps.tokenDoApp] : []),
  ]
  try {
    if (!melhoriaNaListaBranca(deps.melhoria)) {
      return { desfeito: false, motivo: 'melhoria fora da lista permitida' }
    }
    const bruta = await deps.prisma.repoItem.findUnique({
      where: {
        projectId_tipo_numero: { projectId: deps.projeto.id, tipo: TIPO_DA_FICHA, numero: 0 },
      },
    })
    const ficha = lerFichaDeMelhorias(bruta?.estado)
    const registro = ficha.melhorias[deps.melhoria]
    if (!registro)
      return { desfeito: false, motivo: 'o GitOrch não aplicou esta melhoria neste projeto' }

    const obtida = await obterSondagem({
      prisma: deps.prisma,
      projectId: deps.projeto.id,
      repositorio,
      credenciais: deps.credenciais,
      fetchImpl: deps.fetchDeLeitura,
      agora: deps.agora(),
      exigirAdmin: true,
      ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    })
    if (obtida === null) return { desfeito: false, motivo: 'não consegui ler o repositório' }

    const ctx: ContextoDeExecucao = {
      repositorio,
      token: obtida.credencial.token,
      tokenDoApp: deps.tokenDoApp,
      escritor: criarEscritorDeSeguranca({
        repositorio,
        fetchImpl: deps.fetchDeEscrita,
        ritmo: deps.ritmo,
      }),
      ler: criarLeitorDeSeguranca({
        repositorio,
        token: obtida.credencial.token,
        fetchImpl: deps.fetchDeLeitura,
      }),
      sondagem: obtida.sondagem,
      agora: deps.agora(),
    }
    const r = await desfazerMelhoriaDeSeguranca(deps.melhoria, registro, ctx)
    if (!r.desfeito) return r

    ficha.melhorias[deps.melhoria] = {
      ...registro,
      estado: 'desfeito',
      atualizadoEm: deps.agora().toISOString(),
      proximaTentativaEm: null,
      motivo: textoSeguroParaOPainel(r.motivo, segredos),
      ...(r.pr ? { pr: r.pr } : {}),
    }
    await salvarFicha(deps.prisma, deps.projeto.id, ficha)
    await registrarNoPainelSeForNovo({
      prisma: deps.prisma,
      projectId: deps.projeto.id,
      chave: chaveDoEventoDaMelhoria(repositorio, deps.melhoria, 'desfeito'),
      texto: textoDoEventoDaMelhoria({
        repositorio,
        id: deps.melhoria,
        estado: 'desfeito',
        motivo: textoSeguroParaOPainel(r.motivo, segredos),
        desfazer: registro.desfazer,
      }),
    })
    await invalidarSondagem(deps.prisma, deps.projeto.id)
    return r
  } catch (erro) {
    return {
      desfeito: false,
      motivo: `erro ao desfazer: ${mascararCredenciais(mensagemDoErro(erro), segredos)}`,
    }
  }
}
