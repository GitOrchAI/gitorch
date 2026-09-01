import fp from 'fastify-plugin'
import { FastifyInstance, FastifyBaseLogger } from 'fastify'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import {
  resolveRuntimeChain,
  isFailoverError,
  type ResolverDefaults,
} from '../lib/runtime-resolver.js'
import {
  AgentOrchestrator,
  RuntimeRegistry,
  createCliRuntimeAdapter,
  createPodmanCommandRunner,
  createPythonSdkRuntimeAdapter,
  isF6AgentRole,
  realRuntimeCommandRunner,
  wrapWithHostGitorchPluginGate,
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
  type F6AgentRole,
  type F6AgentRuntime,
  type RuntimeCommandRunner,
  type WorkspaceProvider,
} from '@gitorch/agents'
import type { EngineConnectionService } from '../services/engine-connection.js'
import {
  tetoDiarioBloqueia,
  tetoDiarioSeguraOPapel,
  TIPO_DE_MISSAO_ISENTO_DO_TETO,
} from '../services/teto-diario.js'
import { ensureDefaultSchedules } from '../lib/project-defaults.js'
import {
  LocalWorkspaceProvider,
  WorkspaceManager,
  RemoteWorkspaceProvider,
} from '@gitorch/workspace-engine'
import { createSshCommandRunner } from '@gitorch/agents'
import { buildMissionEnricher, persistMissionMemory } from '../services/mission-context.js'
import { resolveMissionDelivery, type MissionPathKind } from '../services/mission-outcome.js'
import { ClientEnvironmentService } from '../services/environment.js'
import { runPoMissionViaRails } from '../services/po-rails-mission.js'
import { runRaMissionViaRails, runDuvidaTecnicaViaRa } from '../services/ra-rails-mission.js'
import { resolvePoliticaDePerguntasAoDono } from '../services/duvida-do-dev.js'
import {
  runQaMissionViaRails,
  type VigiliaDoJulgamentoOptions,
} from '../services/qa-rails-mission.js'
import { runSmDelegation } from '../services/sm-delegation.js'
import { criarFilaDeJulgamento } from '../services/fila-de-julgamento.js'
import {
  deveAvisarSobreOMotor,
  recadoDeMotorRevogado,
} from '../services/recado-de-motor-revogado.js'
import { livenessCommandFor } from '../services/engine-liveness.js'
import {
  agruparPorProvedor,
  decidirRenovacaoDoMotor,
  ehRevogacaoDefinitiva,
} from '../services/renovar-motores.js'
import { motoresComProvaDeVida } from '../services/prova-de-vida.js'
import {
  pegarATrava,
  soltarATrava,
  VALIDADE_DA_TRAVA_MS,
  type PrismaParaTrava,
} from '../services/trava-de-renovacao.js'
import { criarPassagemDeBastao } from '../services/passar-o-bastao.js'
import { criarRegistroDeMotorMorto } from '../services/motor-em-pausa.js'
import { criarRegistroDeDescanso, type OrigemDoDisparo } from '../services/descanso-apos-vazia.js'
import { tetosDoPlanoDoDev } from '../services/plano-do-dev.js'
import { ESTADOS_TERMINAIS } from '../services/estados-de-sessao.js'
import { executarCicloTerminal } from '../services/executar-ciclo-terminal.js'
import {
  lerAprendizados,
  registrarAprendizado,
  blocoDeContextoDoJules,
  guiaCuradoDoJules,
  type PrismaEventoDoJules,
} from '../services/memoria-do-jules.js'
import { analisarFalhasPendentes } from '../services/analisar-falhas-pendentes.js'
import { runAnaliseDeFalha, type SessaoMorta } from '../services/analise-de-falha-do-dev.js'
import { processarAchadosDeInfra } from '../services/processar-achados-de-infra.js'
import { varrerIncidentesResolvidos } from '../services/fechar-incidente-resolvido.js'
import { runRetroDeInfra } from '../services/retro-de-infra.js'
import {
  decidirAvisoPorJanela,
  JANELA_LIMPA,
  type EstadoDaJanela,
} from '../services/aviso-por-janela.js'
import { decidirAvisoDeTickQuebrado } from '../services/aviso-de-tick-quebrado.js'
import { notificadorDaInstancia } from '../services/banco-atrasado.js'
import { classificarAviso } from '../services/classe-do-aviso.js'

/** ESTEIRA-T11: minutos que a esteira pode ficar travada por vaga antes de avisar. */
const MINUTOS_ATE_ALERTAR_VAGA = 20

/**
 * Minutos que o relógio interno pode ficar rejeitando tique antes de avisar o
 * dono da instância. Bem mais curto que `MINUTOS_ATE_ALERTAR_VAGA`: uma vaga
 * travada é degradação parcial (outros projetos seguem andando); um tique que
 * rejeita é o relógio INTEIRO parado — nenhuma tarefa automática roda, de
 * nenhum projeto, até resolver.
 */
const MINUTOS_ATE_ALERTAR_TICK_QUEBRADO = 5
import type { AchadoDeInfra } from '../services/incidente-ci.js'
import { renderIssueBody } from '../services/backlog-executor.js'
import type { DoDFields } from '@gitorch/cadence'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import {
  abrirSessao,
  sessoesVivas,
  registrarEstado,
  registrarResposta,
  registrarPr,
  registrarAvisoDeRetrabalhoPendente,
  limparAvisoDeRetrabalho,
  contarTentativaDeAviso,
  fecharSessao,
  linhasVivasParaJulgarAbandono,
  linhasVivasParaCicloTerminal,
  issuesComAnalisePendente,
  marcarAnaliseFeitaDaIssue,
  type MotivoDeFechamento,
  registrarInvestigacao,
  nomesDeSessoesVivasDaInstancia,
  registrarPendencia,
  limparPendencia,
  registrarAvisoDeDemora,
  registrarFracassoDeMerge,
  registrarMescla,
  registrarEstadoDaPublicacao,
  registrarCadenciaDePublicacao,
  registrarConsertoDePublicacao,
  registrarVereditoDeAmbiente,
  type PrismaDevSession,
  type LinhaDeSessao,
} from '../services/dev-session-store.js'
import {
  lerHistoricoDoProjeto,
  registrarJulgamento,
  lerJanelaDeBarradas,
  registrarJanelaDeBarradas,
  type PrismaDoHistorico,
} from '../services/historico-de-julgamento.js'
import {
  aguardaSegundaLeituraDoAmbiente,
  decidirConsertoDePublicacao,
  notaDeConserto,
  type EvidenciaDeConserto,
} from '../services/conserto-de-publicacao.js'
import { criarIssueDeDesejo } from '../services/desejo-no-github.js'
import { runDuvidaMissionViaRails } from '../services/duvida-rails-mission.js'
import {
  decidirSobreAPergunta,
  marcarDesistencia,
  marcarRespondida,
} from '../services/pergunta-sem-resposta.js'
import { esperarAVezDeDevolver } from '../services/devolucao-de-credencial.js'
import { varrerArvoreDoPlano } from '../services/fechar-o-pai.js'
import {
  entregasQueMerecemConferencia,
  recadoDeTarefaJaEntregue,
} from '../services/tarefa-entregue-continua-aberta.js'
import { agentLabel } from '../services/agent-label.js'
import {
  reservarAResposta,
  devolverAReserva,
  type PrismaParaReserva,
} from '../services/reservar-a-resposta.js'
import { hashDaMensagem } from '../services/session-watch.js'
import type { StepExecutor } from '../services/role-rails.js'
import {
  corpoDoPedidoDeAviso,
  decidirPedirOAviso,
  jaExisteOPedido,
} from '../services/instalar-aviso-de-publicacao.js'
import { TASK_LABEL } from '../services/sm-delegation.js'
import { sessoesParaAcompanharPublicacao } from '../services/pos-merge.js'
import { descobrirMecanismo, type Mecanismo } from '../services/mecanismo-de-publicacao.js'
import {
  ambientesDeclaradosPeloProjeto,
  JANELA_DA_ENTREGA_RECENTE_MS,
} from '../services/ambiente-declarado.js'
import { duvidaSobreComoPublica } from '../services/duvidas-do-projeto.js'
import {
  comoPublicaDeclarado,
  desfechoDaPublicacao,
  dispensaOlharORepositorio,
} from '../services/como-o-projeto-publica.js'
import type { AgentQuestionService } from '../services/agent-question.js'
import { nomeDaReserva, PREFIXO_DA_RESERVA, semAsReservas } from '../services/reserva-de-vaga.js'
import {
  acompanharPublicacao,
  fecharPorTetoAbsoluto,
  TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
  type ExecucaoDeWorkflow,
  type EtapaDaExecucao,
  type PublicacaoDeclarada,
  type EstadoDaPublicacao,
} from '../services/publicacao.js'
import { fecharTarefaEntregue } from '../services/fechar-tarefa.js'
import {
  testarAmbiente,
  resolveCaminhosDeAmbiente,
  resolveEnderecoDeAmbiente,
} from '../services/qa-de-ambiente.js'
import { buscarComGuarda } from '../services/endereco-seguro.js'
import {
  criarSessaoJules,
  listarSessoesJules,
  consultarSessaoJules,
  responderSessaoJules,
  arquivarSessaoJules,
  aprovarPlanoJules,
  ultimaMensagemDoDevJules,
} from '../services/jules-client.js'
import { vigiarSessoes } from '../services/session-watch.js'
import {
  CADENCIA_DA_VARREDURA_MS,
  fecharPrDoVigia,
  listarPrsAbertosParaOVigia,
  vigiarPrsOrfaos,
} from '../services/vigia-do-pr.js'
import { varrerVagasVazadas } from '../services/reconciliar-vagas.js'
import { sessoesAbandonadas } from '../services/sessao-abandonada.js'
import { medirRetrospectiva, escolherAMelhoria } from '../services/retrospectiva.js'
import { runSmWatchdog, buildTelegramNotifier } from '../services/sm-watchdog.js'
import { resolveNotifyChatId, type NotifiableProject } from '../services/telegram-link.js'
import { acharIncidentesDeInfra } from '../services/incident-sensor.js'
import { mintInstallationToken } from '../services/github-app-token.js'
import {
  resolveBoardColumns,
  resolveSprintDays,
  createCardMover,
} from '../services/board-status.js'
import {
  fetchDoRepositorio,
  guardaPorRepositorio,
  fetchSemPermissao,
} from '../services/guarda-de-autonomia.js'
import { garantirSprintDosProjetos } from '../services/garantir-sprint-dos-projetos.js'
import { garantirSprintNoQuadro, hojeNoFuso } from '../services/garantir-sprint.js'
import {
  ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA,
  levantarTrabalhoAtivo,
  preencherSprintCorrente,
} from '../services/sprint-com-itens.js'
import { decidirQuadro, type DecisaoDeQuadro } from '../services/resolver-quadro.js'
import { registrarSePronto } from '../services/incremento.js'
import { fetchComTeto } from '../services/fetch-com-teto.js'
import {
  ensureAndPersistProjectBoard,
  ensureProjectBoard,
  resolveGithubOwnerId,
  resolveGithubRepositoryId,
  type ResolvedOwner,
} from '../services/onboarding-board.js'
import { lerCredencialDoProjeto } from '../services/project-credential.js'
import {
  resolverCredencialDoDev,
  recadoDaRecusa,
} from '../services/credencial-do-dev-do-cliente.js'
import { provaDeEscritaNoUso } from '../services/acesso-ao-repositorio.js'
import {
  reconferirAcessoDosProjetos,
  projetoEstaSuspensoPorAcesso,
  type ResumoDaReconferencia,
} from '../services/reconferencia-de-acesso.js'
import {
  renovarTokensGithubVencendo,
  trocarRefreshTokenNoGithub,
  type ResumoDaRenovacaoGithub,
} from '../services/github-token-refresh.js'
import { decryptCredential } from '../lib/credential-crypto.js'
import { getEnv } from '../config/env.js'
import { ProjectV2Client } from '@gitorch/github-sync'
import { RailsStepError, RailsExecutionError } from '../services/rails-runner.js'
import { GithubExecutionError } from '../services/github-backlog.js'
import {
  ehCredencialExpirada,
  ehFalhaDeCredencialCorroborada,
  CredencialExpiradaError,
  SemCredencialDoMotorError,
  exigirCredencialDoMotor,
  deveAvisarDeNovo,
} from '../services/credencial-do-motor.js'
import {
  resumoDeErroDoMotor,
  classificarFalhaDoMotor,
  marcarFailoverDoTextoCompleto,
  temMarcaDeFailover,
} from '../services/resumo-de-erro-do-motor.js'
import { escolherModeloVivo } from '../services/catalogo-vivo-de-modelos.js'
import { marcaDePedidoDeLogin } from '../services/motor-que-pede-login.js'
import {
  ehTetoDeUsoDaConta,
  quandoACotaVolta,
  recadoDeTetoDeUso,
} from '../services/teto-de-uso-da-conta.js'
import { umaAcordadaPorCiclo } from '../services/uma-acordada-por-ciclo.js'
import { relogioDaAgenda } from '../services/espalhar-agendas.js'
import { cotasAReler } from '../services/cotas-a-reler.js'
import { modelosARecoletar } from '../services/modelos-a-recoletar.js'
import { canRunMission, shouldAlertForQuota } from '../lib/spend-guard.js'
import { computeConsumption } from '../lib/consumption.js'
import { pipelineCheckEnabled } from '../config/pipeline-check.js'
import { resolveMissionCpus } from '../config/mission-cpus.js'
import { reapOrphanContainers, failOrphanRunningMissions, type ReapResult } from './boot-reaper.js'
import type { Prisma, PrismaClient } from '@prisma/client'
import * as os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/plugins -> raiz do repo -> runtime/
const runtimeScriptPath = path.resolve(__dirname, '../../../../runtime/run_antigravity_sdk.py')

export interface SchedulerOptions {
  // Empty options type
}

// Guardas operacionais: orçamento diário de missões e proteção de memória do host.
const MAX_MISSIONS_PER_DAY = Number(process.env['GITORCH_MAX_MISSIONS_PER_DAY'] ?? '4')
// Teto de missões simultâneas na VM — cobre cadência E o wizard
// (processSetupMissions). Default 1 (seguro pra qualquer install não
// configurada); a VM dev atual (ARM 4CPU/11GB) roda com
// GITORCH_MAX_CONCURRENT=2 (ver .env.example), cada missão sob
// GITORCH_EXEC_LIMITS (execution-limits.ts); sobe mais na VM-MT-SaaS (32GB).
const MAX_CONCURRENT_MISSIONS = Number(process.env['GITORCH_MAX_CONCURRENT'] ?? '1')

/**
 * Quanto tempo um papel fica sem ser acordado, num projeto, depois de uma
 * acordada que voltou VAZIA (`noOp`).
 *
 * O padrão de 30 minutos sai do número medido no banco em 21/08/2026: ~13
 * acordadas vazias de julgamento por hora, empurradas pela vigília de sessão,
 * que reexamina cada sessão viva a cada ~10 minutos. Um descanso menor que
 * esses 10 minutos não cortaria nada; 30 minutos derruba o pior caso de ~13/h
 * para no máximo 2/h por (projeto, papel), sem nunca segurar mais que meia
 * hora uma acordada de relógio.
 *
 * Zero desliga o descanso por completo — a válvula de escape para voltar ao
 * comportamento antigo sem deploy de código.
 */
const DESCANSO_APOS_VAZIA_MS = Number(
  process.env['GITORCH_DESCANSO_APOS_VAZIA_MS'] ?? String(30 * 60_000)
)
const STALE_RUNNING_MS = Number(
  process.env['GITORCH_STALE_RUNNING_MS'] ?? String(2 * 60 * 60 * 1000)
)
// Missão que fica 'pending' além disso (processo morto antes de iniciar) vira failed.
const PENDING_TIMEOUT_MS = Number(
  process.env['GITORCH_PENDING_TIMEOUT_MS'] ?? String(10 * 60 * 1000)
)

interface TriggerResult {
  triggered: boolean
  missionId?: string
  reason?: string
}
// Nomes de modelo aceitos pelo Antigravity CLI (ver `agy models`); configuráveis por ambiente.
//
// REMENDO, e está escrito aqui para ninguém confundir com conserto: trocar a
// string conserta HOJE e quebra de novo na próxima remoção do provedor. O
// conserto de verdade é `escolherModeloVivo` (catalogo-vivo-de-modelos.ts),
// ligado logo abaixo em `modeloVivoParaAMissao` — este literal virou só o ponto
// de partida de quando o catálogo do cliente ainda não foi coletado.
//
// O QUE ACONTECEU: até 01/09/2026 este literal era 'Gemini 3.5 Flash (Medium)'.
// O Google removeu a geração 3.5 em 31/08 entre 16:12 e 23:00, e a partir daí
// 100% das missões que caíam no Antigravity morriam com `invalid model
// selection`. A env `GITORCH_MODEL_FLASH` NÃO está definida no processo real
// (conferido em /proc/<pid>/environ), então quem valia era o literal.
//
// POR QUE 3.7 E NÃO 3.6, e não é gosto: às 16:12 o catálogo tinha 3.5/3.6/3.7;
// às 23:00 só 3.6/3.7. O provedor mantém DUAS gerações Flash e derruba a mais
// velha sem aviso, no meio do dia. Escolher 3.6 é escolher a próxima a cair.
//
// ARMADILHA para quem for conferir: a lista de modelos que aparece DENTRO da
// mensagem de erro do CLI chegava truncada em 4 itens nos nossos logs — e o
// truncamento era NOSSO (ver resumo-de-erro-do-motor.ts), não do CLI. Rodando
// `agy models` de verdade nesta VM em 01/09 vêm 11 modelos. Nunca escolher
// substituto pela lista que aparece no log.
const MODEL_FLASH = process.env['GITORCH_MODEL_FLASH'] ?? 'Gemini 3.7 Flash (Medium)'
const MODEL_PRO = process.env['GITORCH_MODEL_PRO'] ?? 'Gemini 3.1 Pro (Low)'

// PO decide (modelo forte); RA/SM/QA analisam (modelo rápido).
const MODEL_BY_ROLE: Record<F6AgentRole, string> = {
  po: MODEL_PRO,
  ra: MODEL_FLASH,
  sm: MODEL_FLASH,
  qa: MODEL_FLASH,
}

// Padrões da instância para o resolvedor por projeto: motor por papel (config
// do pacote de agentes) e modelo por papel. O projeto sobrescreve via
// project.runtimeConfig.agents.
const RESOLVER_DEFAULTS: ResolverDefaults = {
  runtimeByRole: {
    po: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.po.runtime,
    ra: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.ra.runtime,
    sm: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.sm.runtime,
    qa: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.qa.runtime,
  },
  modelByRole: MODEL_BY_ROLE,
}

/**
 * Uma agenda está "vencida" quando a última ocorrência do cron até `now` é
 * posterior ao último disparo registrado. Puro e testável.
 */
export function isScheduleDue(cron: string, lastTriggeredAt: Date | null, now: Date): boolean {
  const expression = CronExpressionParser.parse(cron, { currentDate: now, tz: 'UTC' })
  const previousOccurrence = expression.prev().toDate()
  if (previousOccurrence > now) return false
  return lastTriggeredAt === null || previousOccurrence > lastTriggeredAt
}

/**
 * Mecânica pura da cascata de onboarding: dada a fila de papéis restante
 * (gravada em Mission.payload.onboardingSequence), decide qual é o próximo
 * papel a disparar e o que resta depois dele. Extraída para ser testável sem
 * subir Prisma/o resto do scheduler — prova a mecânica do encadeamento (Crítico
 * 1, item c) isolada da decisão de entrega (resolveMissionDelivery), que é o
 * único gate que ficava entre uma missão de trilhos concluída e este passo.
 */
export function nextOnboardingStep(
  sequence: F6AgentRole[] | null | undefined
): { role: F6AgentRole; remaining: F6AgentRole[] } | null {
  if (!sequence || sequence.length === 0) return null
  const [role, ...remaining] = sequence
  return { role: role as F6AgentRole, remaining }
}

/**
 * A cascata de onboarding continua enquanto houver fila — inclusive depois de
 * uma missão que não teve trabalho a fazer.
 *
 * Visto em produção: o SM de um projeto recém-registrado não tinha nada para
 * delegar (não havia issues ainda). Isso é um no-op LEGÍTIMO, mas o
 * encadeamento morava dentro do bloco que grava memória — pulado em no-op — e
 * a esteira morreu ali: o QA nunca acordou e o reconhecimento de qualidade
 * nunca aconteceu, sem nenhum erro aparente.
 *
 * São duas decisões independentes: gravar memória depende de ter ENTREGUE;
 * seguir a cascata depende apenas de ainda haver próximo papel.
 */
export function shouldChainOnboarding(args: {
  isNoOp: boolean
  sequence: F6AgentRole[] | null | undefined
}): boolean {
  return nextOnboardingStep(args.sequence) !== null
}

/**
 * Board dos trilhos: só o PRÓPRIO board do projeto (gravado em
 * Project.runtimeConfig.envConfig.GITORCH_PROJECT_BOARD por
 * provisionSetupMission). Achado crítico da revisão pós-merge: esta função
 * NUNCA lê `process.env['GITORCH_PROJECT_BOARD']` (o board global de outro
 * projeto do dono) — de propósito, para que um projeto sem board próprio
 * jamais herde o board alheio, mesmo que a env global esteja setada (era
 * exatamente o vazamento multi-tenant que esta task dizia matar). Pura e
 * testável isolada do resto do dispatch.
 */
export function resolveRailsBoard(project: { runtimeConfig?: unknown }): string | undefined {
  return (
    (project.runtimeConfig as Record<string, unknown> | null)?.['envConfig'] as
      Record<string, unknown> | undefined
  )?.['GITORCH_PROJECT_BOARD'] as string | undefined
}

/**
 * Decide se um erro lançado durante a tentativa de UM motor da cadeia
 * justifica trocar para o PRÓXIMO motor (failover) — usada por
 * `executeMissionWithFailover` no catch de cada tentativa.
 *
 * Extraída como função pura EXPORTADA pelo mesmo motivo de
 * `montarOpcoesDeDelegacao` acima: antes, a classificação vivia só dentro do
 * catch da closure não exportada, e não havia como provar em teste que um
 * caso novo de falha de motor realmente aciona o failover — foi exatamente
 * assim que o bug real escapou (ver abaixo).
 *
 * GithubExecutionError é SEMPRE `false` aqui, por TIPO — nunca por texto: é
 * erro do GITHUB (token/rate-limit do repositório), igual para todos os
 * motores, e failover só repetiria o dano. Isso é checado explicitamente
 * dentro da função (não só confiado à ordem de chamada) porque a mensagem de
 * um GithubExecutionError pode conter palavras do regex de cota/auth (ex.:
 * "403", "rate limit") sem que isso signifique falha de MOTOR — depender só
 * do chamador verificar antes seria frágil a esse tipo de colisão de texto.
 * O chamador ainda quebra o loop nesse caso ANTES de chamar esta função,
 * pelo log e semântica próprios: "erro de execução no GitHub; sem failover".
 *
 * Bug real de produção (loureng/patinhas-3d-crafts, chain=codex>antigravity,
 * falhas diárias desde 12/08): quando o PROCESSO do motor saía com exitCode
 * != 0 (crash, binário ausente, timeout do processo), o passo de trilhos
 * lançava um `Error` genérico. Essa exceção não era `RailsStepError` (que só
 * cobre "o motor respondeu mas o formulário não validou") nem batia no regex
 * de cota/auth de `isFailoverError` — a missão morria sem NUNCA tentar o
 * motor de reserva, e sem sequer logar o aviso de failover.
 * `RailsExecutionError` (rails-runner.ts) fecha essa lacuna: é o tipo que o
 * passo de trilhos agora lança quando o PROCESSO do motor falha, e esta
 * função a reconhece como falha de motor — sem depender de casar texto de
 * mensagem (proibido: um regex mais largo teria o mesmo furo pra qualquer
 * mensagem de erro de processo ainda não prevista).
 *
 * Tarefa 16 (credencial de motor expirada): `CredencialExpiradaError`
 * (credencial-do-motor.ts) entra na mesma lista por TIPO, pelo mesmo motivo
 * de `RailsExecutionError` acima — é igualmente falha de MOTOR (o próximo da
 * cadeia pode ter credencial válida), e o reconhecimento por texto já
 * aconteceu na origem (onde a saída crua do motor existe), não aqui.
 */
/**
 * O modelo da missão CONFERIDO contra o catálogo vivo do motor daquele cliente.
 *
 * Este é o conserto de verdade do defeito que derrubou a frota em 31/08: o
 * produto tinha DOIS TRILHOS que nunca se encontravam. A coleta de modelos
 * grava o catálogo em `engine_connections.models` (só para desenhar a tela), e
 * a escolha do modelo da missão vinha de um literal no código. Quando o Google
 * removeu a geração Gemini 3.5 no meio do dia, o catálogo do banco soube na
 * hora — e a missão continuou pedindo o modelo morto, porque ninguém tinha
 * ligado um trilho no outro. Trocar o literal (feito, ver MODEL_FLASH) conserta
 * hoje; ligar os trilhos é o que impede a próxima remoção de repetir tudo.
 *
 * FAIL-OPEN em TODO caminho de dúvida — sem conexão, sem catálogo, banco fora
 * do ar, catálogo com forma inesperada: segue com o modelo pedido. Catálogo
 * vazio quer dizer "não sei", nunca "o modelo não existe". Uma guarda que
 * parasse a missão por falta de lista trocaria um desperdício (uma missão que
 * falha) por uma paralisação (a esteira inteira parada toda vez que a leitura
 * do banco piscasse) — exatamente o que `filtrarCadeia` já recusa fazer.
 *
 * E quando troca, DIZ. O defeito original durou 9h48 e 24 missões justamente
 * porque ninguém foi avisado de nada.
 */
/**
 * O que a conferência contra o catálogo decidiu para UM degrau da cadeia.
 */
export interface ModeloDaMissao {
  /**
   * O modelo a passar ao motor. `undefined` quer dizer "rode sem `--model`",
   * com o modelo padrão do próprio motor — nunca um palpite nosso.
   */
  modelo: string | undefined
  /**
   * `false` quando o catálogo daquele motor prova que a tentativa é
   * desperdício com resultado conhecido. O degrau é PULADO.
   */
  valeATentativa: boolean
}

export async function modeloVivoParaAMissao(args: {
  prisma: { engineConnection?: { findFirst?: (...args: never[]) => Promise<unknown> } }
  ownerUserId: string | null | undefined
  runtime: string
  desejado: string
  log: { warn: (msg: string) => void }
}): Promise<ModeloDaMissao> {
  const segueComOPedido: ModeloDaMissao = { modelo: args.desejado, valeATentativa: true }
  // Projeto legado sem dono não tem catálogo para consultar — nem vale a ida ao
  // banco.
  if (!args.ownerUserId) return segueComOPedido

  // FAIL-OPEN inclusive no tropeço SÍNCRONO. Um `.catch()` só pega promessa
  // rejeitada; ler `.findFirst` de um `engineConnection` ausente estoura ANTES
  // de existir promessa alguma, e a exceção subiria para a missão. Esta guarda
  // não é paranoia de tipo: a suíte pegou o caso ao vivo.
  const conexoes = args.prisma?.engineConnection
  if (typeof conexoes?.findFirst !== 'function') return segueComOPedido
  const buscar = conexoes.findFirst.bind(conexoes)

  const catalogo = await Promise.resolve()
    .then(() =>
      buscar({
        where: { userId: args.ownerUserId, runtime: args.runtime },
        select: { models: true },
      } as never)
    )
    .then((linha) => (linha as { models?: unknown } | null)?.models)
    .catch(() => undefined)

  // Só lista de texto serve. Qualquer outra forma é tratada como "não sei".
  if (!Array.isArray(catalogo)) return segueComOPedido
  const nomes = catalogo.filter((m): m is string => typeof m === 'string')

  const escolha = escolherModeloVivo({ desejado: args.desejado, catalogo: nomes })
  if (escolha.aviso) {
    args.log.warn(`[Scheduler] modelo de ${args.runtime}: ${escolha.aviso}`)
  }
  return { modelo: escolha.modelo, valeATentativa: escolha.veredito !== 'saiu-do-catalogo' }
}

/**
 * Tira da cadeia os degraus cujo modelo o catálogo do próprio motor prova que
 * não existe mais.
 *
 * ISTO É O CONSERTO DO DEFEITO CENTRAL. Até aqui a cadeia tentava o degrau
 * mesmo sabendo o resultado: em 31/08, 24 missões em 9h48 pagaram um `podman
 * run` inteiro cada uma para receber `invalid model selection` do CLI, com
 * outro motor conectado e ocioso ao lado.
 *
 * NUNCA ESVAZIA A CADEIA, e não é hesitação: é a mesma decisão que
 * `filtrarCadeia` (motor-em-pausa.ts) já tomou neste produto, pela razão
 * escrita lá — ficar sem motor nenhum é trocar desperdício por paralisação.
 * Pular degraus corta três containers queimados para um; pular TODOS pararia a
 * esteira inteira por causa de um catálogo que ninguém conferiu. Quando nenhum
 * degrau vale, o ÚLTIMO é tentado assim mesmo e o log diz que está tentando
 * contra o veredito do catálogo.
 */
export function degrausQueValemATentativa<T extends { valeATentativa: boolean }>(
  degraus: readonly T[]
): { degraus: T[]; pulados: T[] } {
  const valem = degraus.filter((d) => d.valeATentativa)
  if (valem.length > 0) {
    return { degraus: valem, pulados: degraus.filter((d) => !d.valeATentativa) }
  }
  const ultimo = degraus[degraus.length - 1]
  if (!ultimo) return { degraus: [], pulados: [] }
  return { degraus: [ultimo], pulados: degraus.slice(0, -1) }
}

export function isEngineFault(err: unknown, lastError: string): boolean {
  if (err instanceof GithubExecutionError) return false
  return (
    err instanceof RailsStepError ||
    err instanceof RailsExecutionError ||
    err instanceof CredencialExpiradaError ||
    err instanceof SemCredencialDoMotorError ||
    // O veredito tirado do stderr COMPLETO na origem (ver
    // classificarFalhaDoMotor). Vem ANTES do teste por texto de propósito: aqui
    // `lastError` já é o resumo, e decidir por ele é decidir pelo que sobrou do
    // erro. Foi assim que um 401 no byte 674 virou "não é caso de failover".
    temMarcaDeFailover(err) ||
    isFailoverError(lastError)
  )
}

/**
 * Monta as opções de teto e fila que a delegação do SM recebe.
 *
 * Existe como função pura EXPORTADA por um motivo de segurança, não de
 * estilo: é aqui que o teto do plano do dev assíncrono (declarado pelo dono
 * no cadastro — a API do Jules não expõe consulta de cota, ver
 * plano-do-dev.ts) entra no caminho de delegação. Antes desta extração, a
 * montagem vivia dentro de `executeMissionWithFailover` — closure não
 * exportada — e não havia como testar que o teto do plano chega de fato à
 * delegação: uma regressão que reintroduzisse os literais `3`/`15` não
 * quebraria teste nenhum, estourando a cota do cliente em silêncio. Ver
 * scheduler-teto-delegacao.test.ts.
 */
export function montarOpcoesDeDelegacao(args: {
  devPlan: string | null | undefined
  sessoesVivas: LinhaDeSessao[]
  delegadasHoje: number
  /** Sessões vivas na CONTA inteira — usado só para diagnóstico/log. */
  vivasNaConta: number
  /**
   * O que de fato OCUPA uma vaga simultânea na CONTA inteira: só os estados que
   * o Jules ainda está tocando. É este que o teto de simultâneas usa — uma
   * linha aberta em COMPLETED/FAILED já devolveu a vaga no fornecedor.
   */
  ocupamVagaNaConta: number
  /**
   * TODAS as linhas do projeto, vivas e fechadas — a prova de que uma tarefa
   * já foi entregue. `sessoesVivas` não serve aqui: a linha de uma entrega
   * mesclada pode já ter sido fechada, e é justamente essa que precisa barrar
   * a redelegação.
   */
  entregasDoProjeto: Array<{ issueNumber: number; mergeCommitSha?: string | null }>
}): {
  sessoesVivas: LinhaDeSessao[]
  delegadasHoje: number
  vivasNaConta: number
  ocupamVagaNaConta: number
  entregasDoProjeto: Array<{ issueNumber: number; mergeCommitSha?: string | null }>
  tetoConcorrentes: number
  tetoDiario: number
} {
  return {
    sessoesVivas: args.sessoesVivas,
    delegadasHoje: args.delegadasHoje,
    vivasNaConta: args.vivasNaConta,
    ocupamVagaNaConta: args.ocupamVagaNaConta,
    entregasDoProjeto: args.entregasDoProjeto,
    ...tetosDoPlanoDoDev(args.devPlan),
  }
}

/**
 * Monta as opções da família `VigiliaDoJulgamentoOptions` (ver
 * qa-rails-mission.ts) que o julgamento do QA recebe:
 * `registrarPendencia`/`limparPendencia`/`registrarAvisoDeDemora`/
 * `registrarFracassoDeMerge` ligadas ao Prisma real, e `avisarDono` quando
 * um notificador foi montado.
 *
 * Achado 1 da revisão da Tarefa 7: as três primeiras foram ADICIONADAS à
 * interface de `runQaMissionViaRails` mas nunca chegavam a este ponto de
 * disparo — a lógica ficava correta e testada em isolamento
 * (qa-rails-mission.test.ts) e inerte em produção (`pending_since` nunca era
 * gravado, o teto de 90min nunca amadurecia, o dono nunca era avisado).
 *
 * Achado crítico da revisão da Tarefa 10: `registrarFracassoDeMerge` repetiu
 * o MESMO furo — adicionada à interface, nunca ligada aqui. Corrigido no
 * commit anterior; este commit fecha a CLASSE do defeito (ver guarda
 * estrutural abaixo), para não haver uma terceira vez.
 *
 * Função pura EXPORTADA pelo mesmo motivo de `montarOpcoesDeDelegacao`
 * (achado 2 da Tarefa 5): a montagem viveria só dentro de
 * `executeMissionWithFailover`, fechamento não exportado, e uma regressão
 * que voltasse a esquecer uma das opções no call site de
 * `runQaMissionViaRails` não quebraria teste nenhum. Ver
 * scheduler-julgamento-opcoes.test.ts.
 *
 * Guarda estrutural (pós-Tarefa 10, para a classe do defeito não se repetir
 * uma TERCEIRA vez): o tipo de retorno abaixo não é uma lista de nomes
 * copiada à mão — é `Required<Omit<VigiliaDoJulgamentoOptions, 'avisarDono'>>`,
 * DERIVADO da interface em qa-rails-mission.ts. Uma opção nova adicionada
 * àquela família fica, automaticamente, obrigatória neste retorno; esquecer
 * de devolvê-la aqui agora quebra `pnpm --filter @gitorch/control-plane
 * build` (erro "Property is missing"), em vez de compilar em silêncio como
 * aconteceu nas Tarefas 7 e 10. `avisarDono` é a ÚNICA exceção — omitida de
 * propósito quando não há notificador, por isso fica fora do `Required` e
 * como `Pick` optativo, igual sempre foi.
 */
export function montarOpcoesDoJulgamento(args: {
  prisma: PrismaDevSession
  /**
   * O projeto DESTA iteração. Vem pronto porque só quem itera sabe de quem é o
   * repositório: `wingId` não é único global (dois clientes podem cadastrar o
   * mesmo endereço), então procurar o projeto por endereço aqui dentro
   * contaria a reprovação de um dono na conta do outro.
   */
  projectId: string
  avisarDono?: ((mensagem: string) => Promise<boolean>) | undefined
}): Required<Omit<VigiliaDoJulgamentoOptions, 'avisarDono'>> &
  Pick<VigiliaDoJulgamentoOptions, 'avisarDono'> {
  return {
    registrarPendencia: (a) => registrarPendencia({ prisma: args.prisma, ...a }),
    limparPendencia: (a) => limparPendencia({ prisma: args.prisma, ...a }),
    registrarAvisoDeDemora: (a) => registrarAvisoDeDemora({ prisma: args.prisma, ...a }),
    registrarFracassoDeMerge: (a) => registrarFracassoDeMerge({ prisma: args.prisma, ...a }),
    // Mesma marca do conserto: as duas respondem "já pedi isto para esta
    // entrega neste commit?", e duas separadas divergiriam em silêncio.
    registrarConserto: (a) => registrarConsertoDePublicacao({ prisma: args.prisma, ...a }),
    // A conta de "este projeto está travado" é sobre DIAS — o patinhas
    // acumulou dez reprovações seguidas em quatro dias, e nesse intervalo o
    // serviço reiniciou dezenas de vezes. Por isso vive no banco.
    registrarJulgamento: (a) =>
      registrarJulgamento({
        prisma: args.prisma as unknown as PrismaDoHistorico,
        projectId: args.projectId,
        peloPortao: a.peloPortao,
      }),
    lerHistoricoDoProjeto: () =>
      lerHistoricoDoProjeto({
        prisma: args.prisma as unknown as PrismaDoHistorico,
        projectId: args.projectId,
      }),
    // ESTEIRA-T15: dedupe do aviso de "N entregas barradas" — sem isto,
    // decidirSobreOProjeto recalcula a contagem a cada julgamento e cada
    // valor novo (3, 4, 5...) virava um aviso novo no Telegram. Mesmo
    // mecanismo do T11 (aviso-por-janela.ts).
    lerJanelaDeBarradas: () =>
      lerJanelaDeBarradas({
        prisma: args.prisma as unknown as PrismaDoHistorico,
        projectId: args.projectId,
      }),
    registrarJanelaDeBarradas: (estado) =>
      registrarJanelaDeBarradas({
        prisma: args.prisma as unknown as PrismaDoHistorico,
        projectId: args.projectId,
        estado,
      }),
    ...(args.avisarDono ? { avisarDono: args.avisarDono } : {}),
  }
}

/**
 * O que acontece quando uma entrega é de fato mesclada (`aoMesclar`,
 * runQaMissionViaRails/qa-rails-mission.ts).
 *
 * Tarefa 17: ANTES desta mudança, este ponto fechava a linha da vigia na
 * hora (`fecharSessao` com `'merged'`) — a sessão "concluía" no instante do
 * merge e o produto nunca soube se aquele código chegou ao ar. Agora só
 * GRAVA o commit mesclado (`registrarMescla`, dev-session-store.ts); quem
 * fecha é `varrerPublicacoes` (mais abaixo), quando há veredito sobre a
 * publicação.
 *
 * Exportada e testável isoladamente pelo MESMO motivo de
 * `montarOpcoesDoJulgamento` (Tarefas 7 e 10, ver o comentário acima): o
 * call site real dentro de `executeMissionWithFailover` é um fechamento não
 * exportado — uma regressão que voltasse a fechar a sessão aqui (ou
 * esquecesse de gravar o commit mesclado) não quebraria teste nenhum se essa
 * lógica só existisse dentro daquele fechamento. Ver
 * scheduler-pos-merge-opcoes.test.ts.
 *
 * Importante 4 da revisão final da branch: buscava a linha SÓ pelo número do
 * PR e desistia em silêncio numa falha. Mas o número do PR às vezes só é
 * gravado minutos depois do merge — o MESMO atraso que `qa-rails-mission.ts`
 * já documenta e resolve com um recuo pela issue de origem
 * (`linhaDaEntrega`, ali). Nessa janela, `aoMesclarUmaEntrega` não achava a
 * linha, `mergeCommitSha` nunca era gravado, a sessão nunca entrava na
 * vigília de publicação e — como o PR já está mesclado (fechado no GitHub) —
 * o juiz nunca mais veria essa entrega de novo: o capítulo pós-merge inteiro
 * era pulado, calado, para aquela entrega.
 */
export async function aoMesclarUmaEntrega(args: {
  prisma: PrismaDevSession
  projectId: string
  numeroDoPr: number
  mergeCommitSha: string
  agora: Date
  /**
   * A mesma issue de origem que `qa-rails-mission.ts` resolve
   * (`issueDaEntrega`) e agora repassa em `aoMesclar`. `null` quando o
   * recuo que achou a entrega (login do autor) não tem como saber a issue —
   * nesse caso só a busca por PR vale, do mesmo jeito que em
   * `qa-rails-mission.ts`.
   */
  issueNumber?: number | null
  /**
   * Chamado quando NENHUMA das duas buscas acha a linha — nunca em
   * silêncio: sem isto, o capítulo inteiro do pós-merge é pulado para esta
   * entrega e ninguém percebe (produção (achado real): PR mesclado, linha
   * nunca encontrada, sessão nunca fechada).
   */
  onWarn?: (mensagem: string) => void
}): Promise<void> {
  const porNumeroDoPr = await args.prisma.devSession.findFirst({
    where: { projectId: args.projectId, pullRequestNumber: args.numeroDoPr, closedAt: null },
  })
  let linha = porNumeroDoPr
  if (!linha && args.issueNumber != null) {
    linha = await args.prisma.devSession.findFirst({
      where: { projectId: args.projectId, issueNumber: args.issueNumber, closedAt: null },
    })
  }
  if (!linha) {
    args.onWarn?.(
      `merge do PR #${args.numeroDoPr} (commit ${args.mergeCommitSha}) não achou a linha da ` +
        `sessão nem pelo número do PR nem pela issue #${args.issueNumber ?? '?'} — o capítulo ` +
        `pós-merge (vigília de publicação) não vai rodar para esta entrega.`
    )
    return
  }
  await registrarMescla({
    prisma: args.prisma,
    sessionName: linha.sessionName,
    mergeCommitSha: args.mergeCommitSha,
    numeroDoPr: args.numeroDoPr,
    agora: args.agora,
  })
}

/**
 * O filtro das sessões que o julgamento precisa enxergar.
 *
 * Exportado para ser testável: é ele que decide se o QA acha ou não o PR do dev
 * assíncrono, e um erro aqui é silencioso — o QA simplesmente diz que não há PR
 * para julgar, como já aconteceu 85 vezes em produção.
 *
 * Sem teto (`take`) de propósito: `dev_sessions` nunca é apagada (o
 * fechamento é lógico, ver dev-session-store.ts), então qualquer limite de
 * quantidade acabaria escondendo a sessão certa num projeto de operação
 * longa — o mesmo defeito que esta correção existe para matar. Em vez de
 * limitar por quantidade, exclui-se só o que já terminou de verdade: as
 * sessões mescladas, que são as únicas que se acumulam sem limite ao longo
 * do tempo (as demais continuam candidatas até virarem 'merged').
 *
 * - Viva (`closedAt: null`) é candidata natural: pode ganhar PR a qualquer
 *   momento.
 * - Fechada só interessa se ainda tem PR pendente de veredito — é o caso da
 *   sessão abandonada por teto de retomadas (`closedReason: 'abandoned'`) cujo
 *   PR continua aberto no GitHub. `closedReason !== 'merged'` cobre esse caso
 *   (e também 'failed_final'); o `pullRequestNumber` não nulo garante que só
 *   entra quem de fato tem algo a julgar.
 */
export function filtroDeSessoesParaJulgamento(projectId: string): Prisma.DevSessionWhereInput {
  return {
    projectId,
    OR: [{ closedAt: null }, { closedReason: { not: 'merged' }, pullRequestNumber: { not: null } }],
  }
}

/**
 * O que sobra de `sessoesVivas` para a vigia PRÉ-merge (`varrerSessoesDoDev`
 * / `vigiarSessoes`) examinar.
 *
 * Exportada pelo MESMO motivo de `montarOpcoesDeDelegacao` e
 * `filtroDeSessoesParaJulgamento` acima: o call site real vive dentro do
 * fechamento não exportado de `varrerSessoesDoDev`, e uma regressão que
 * voltasse a passar a lista crua de `sessoesVivas` direto para
 * `vigiarSessoes` não quebraria teste nenhum se este filtro só existisse ali
 * dentro.
 *
 * `sessoesVivas` (dev-session-store.ts) continua trazendo TUDO que está
 * `closedAt: null` — inclusive sessão já mesclada — de propósito: a fila de
 * delegação (`montarOpcoesDeDelegacao`, acima, é o OUTRO chamador de
 * `sessoesVivas`) precisa contar essas sessões como ocupadas, senão o SM
 * re-delegaria a MESMA issue enquanto o veredito de publicação (Tarefa 17,
 * `varrerPublicacoes`) ainda está em aberto. Mudar a semântica de
 * `sessoesVivas` na fonte quebraria aquele outro chamador; o filtro por isso
 * mora no CONSUMIDOR pré-merge, não na fonte.
 *
 * A partir do merge (`mergeCommitSha` gravado por `registrarMescla`), a
 * sessão passa a ser propriedade EXCLUSIVA de `varrerPublicacoes` — é ela
 * quem evolui e fecha a linha dali em diante. Sem este filtro, a vigia
 * pré-merge (que só entende estado ANTES do merge, pela cadência própria de
 * `CADENCIA_DE_EXAME_MS`) continuaria interrogando o serviço externo sobre
 * uma entrega que já chegou lá: na melhor das hipóteses, cota gasta à toa;
 * na pior, um `COMPLETED` com PR dispara `julgar` (missão de QA) contra um
 * pull request que já foi mesclado.
 */
export function sessoesParaVigiaPreMerge(sessoes: LinhaDeSessao[]): LinhaDeSessao[] {
  // A RESERVA não existe no dev externo, então perguntar por ela é uma chamada
  // que sempre falha. Pior: a falha não carimba o relógio de exame, então a
  // linha era reconsultada a cada tique — não a cada dez minutos — até a
  // varredura de abandono fechá-la horas depois. Ela sai daqui antes de tudo.
  sessoes = semAsReservas(sessoes)
  return sessoes.filter((sessao) => sessao.mergeCommitSha === null)
}

function buildWorkspaceProvider(app: FastifyInstance): WorkspaceProvider {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor === 'firecracker') {
    app.log.info('[Scheduler] Executor: firecracker (MicroVM por tenant)')
    return new WorkspaceManager()
  }
  if (executor === 'podman') {
    app.log.info('[Scheduler] Executor: podman (container descartável por missão)')
    return new LocalWorkspaceProvider()
  }
  // Default para hosts sem /dev/kvm, onde MicroVM (Firecracker) não é viável.
  app.log.info('[Scheduler] Executor: local-process (sem MicroVM; single-tenant)')
  return new LocalWorkspaceProvider()
}

/** Só o que a resolução do motor versionado lê do ambiente do cliente —
 *  permite injetar um fake nos testes sem tocar Prisma/disco reais, mesmo
 *  padrão de Pick<EngineConnectionService, 'materializeToHome'> acima. */
export type EnvironmentLookup = Pick<ClientEnvironmentService, 'current'>

export interface EngineBinResolution {
  /** Diretório do motor versionado do ambiente (prepend no PATH da execução). */
  dir?: string
  /** Motivo de ter caído no host — SEMPRE presente quando `dir` está ausente. */
  fallbackReason?: string
}

async function defaultBinDirExists(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

/**
 * Resolve `<env>/.gitorch/engines/<runtime>/bin` do AMBIENTE DO CLIENTE — não
 * o binário genérico do host. O bootstrap (W1.2) instala os motores nas
 * versões do manifesto ali dentro e só grava `resourcesLock` no banco quando
 * termina com sucesso (ClientEnvironmentService.bootstrapResources).
 *
 * Fallback SEMPRE explicado (o motivo vai em `fallbackReason`, nunca
 * silencioso): sem ambiente para o usuário, ambiente sem resourcesLock
 * (bootstrap não rodou ou falhou), ou o bin do motor específico não existe em
 * disco (ex.: manifesto não lista aquele runtime, ou o diretório foi
 * removido) — em qualquer um desses casos a missão roda com o binário do
 * host, o comportamento de sempre.
 */
export async function resolveEngineBinDir(
  ownerUserId: string,
  runtime: string,
  environments: EnvironmentLookup,
  pathExists: (dir: string) => Promise<boolean> = defaultBinDirExists
): Promise<EngineBinResolution> {
  const env = await environments.current(ownerUserId)
  if (!env) {
    return { fallbackReason: `usuário ${ownerUserId} sem ambiente provisionado` }
  }
  if (!env.resourcesLock) {
    return {
      fallbackReason: `ambiente ${env.id} (status=${env.status}) sem resourcesLock — bootstrap não rodou ou falhou`,
    }
  }
  const dir = path.join(env.path, '.gitorch', 'engines', runtime, 'bin')
  const exists = await pathExists(dir)
  if (!exists) {
    return { fallbackReason: `bin do motor '${runtime}' não encontrado em ${dir}` }
  }
  return { dir }
}

/**
 * Runner do executor local-process (sem container): materializa a credencial
 * conectada do dono num HOME temporário e a expõe ao processo filho — sem
 * isto, um motor conectado via token colado (ex.: Claude) nunca chegava à
 * missão fora do podman, porque só o entrypoint da imagem exportava
 * `.gitorch/env/*` como variável de ambiente (o local-process não tem
 * entrypoint nenhum). Sem GITORCH_RUNTIME/GITORCH_OWNER_USER_ID no pedido, ou
 * sem conexão do motor, roda inalterado (fallback pras credenciais ambiente
 * do host, comportamento de sempre em modo single-tenant).
 *
 * `environments` (W1.3.1, opcional/injetável) resolve o motor VERSIONADO do
 * ambiente do cliente e o antepõe no PATH da execução — sem ele (ou sem os
 * recursos instalados), cai no binário do host com log claro (`log`).
 */
/**
 * Prepara as montagens de credencial da missão que roda em CONTAINER.
 *
 * Materializa a credencial do dono do projeto (da sua EngineConnection
 * cifrada) num staging temporário, monta SOMENTE-LEITURA em
 * /run/gitorch-credentials, e o entrypoint da imagem a copia para o HOME
 * gravável. O staging é apagado ao fim. Assim a missão de um cliente nunca vê
 * a credencial de outro nem a do host.
 *
 * EXPORTADA, e não mais uma closure dentro do plugin, pelo mesmo motivo de
 * `montarOpcoesDeDelegacao`: o comportamento abaixo é uma DECISÃO de produto
 * (disparar ou não disparar o motor), e decisão de produto sem teste é decisão
 * que volta atrás sozinha na próxima refatoração.
 *
 * SEM CREDENCIAL, NÃO DISPARA. Antes disto o `false` do `materializeToHome`
 * virava um `app.log.warn` e a preparação devolvia `{ mounts: [] }` — o
 * container subia sem credencial nenhuma. Medido no journal de 31/08 (janela de
 * 9h48): 48 vezes. Reproduzido ao vivo no mesmo container, um `codex exec` sem
 * credencial gasta ~15s e morre em `401 Unauthorized`. O produto sabia que ia
 * falhar, escrevia no log que sabia, e disparava assim mesmo — queimando uma
 * rodada da cadeia e um `podman run` inteiro por missão.
 *
 * Parar aqui NÃO é fail-closed: `SemCredencialDoMotorError` é falha de MOTOR
 * (ver isEngineFault/isFailoverError), então a cadeia cai na reserva na hora. A
 * missão anda MAIS rápido do que antes, não menos — o que some é só a rodada
 * queimada no motor que não tinha como atender.
 */
export function criarPreparadorDeMontagens(deps: {
  engineConnections: Pick<EngineConnectionService, 'materializeToHome'>
  stagingBase: string
  log: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}): (request: { env: Record<string, string> }) => Promise<{
  mounts: Array<{ source: string; target: string; readOnly?: boolean }>
  cleanup?: () => Promise<void>
}> {
  return async (request) => {
    const runtime = request.env['GITORCH_RUNTIME']
    const ownerUserId = request.env['GITORCH_OWNER_USER_ID']
    if (!runtime || !ownerUserId) return { mounts: [] }

    // 0700: staging guarda a credencial descriptografada em host compartilhado.
    const dir = path.join(deps.stagingBase, randomUUID())
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const cleanup = async (): Promise<void> => {
      await fs.rm(dir, { recursive: true, force: true })
    }
    try {
      const ok = await deps.engineConnections.materializeToHome(ownerUserId, runtime, dir)
      // Lança SemCredencialDoMotorError: a missão não é despachada para um
      // motor que já se sabe incapaz de autenticar.
      exigirCredencialDoMotor(ok, runtime, ownerUserId)
      // As "mãos" no GitHub: se o dono conectou um token (runtime lógico
      // `github`), ele entra no MESMO staging e vira GH_TOKEN no container
      // (entrypoint). Ausência é normal — missão segue só-leitura de GitHub.
      await deps.engineConnections.materializeToHome(ownerUserId, 'github', dir)
      return {
        mounts: [{ source: dir, target: '/run/gitorch-credentials', readOnly: true }],
        cleanup,
      }
    } catch (err) {
      await cleanup()
      // Falha de DESCRIPTOGRAFIA é incidente (chave trocada/dado corrompido): NÃO
      // mascarar rodando sem credencial — propaga para a missão falhar com causa
      // clara. Outras falhas (fs) são best-effort e não derrubam a preparação.
      if ((err as { name?: string })?.name === 'CredentialDecryptError') {
        throw err
      }
      // A ausência de credencial TAMBÉM propaga — e precisa estar escrita aqui,
      // porque este mesmo `catch` é o que antes engolia tudo. Sem esta linha o
      // conserto acima seria desfeito duas linhas abaixo, no `return { mounts:
      // [] }`, e o container voltaria a subir sem credencial.
      if (err instanceof SemCredencialDoMotorError) {
        throw err
      }
      deps.log.error(err, '[Scheduler] falha ao materializar credencial da missão')
      return { mounts: [] }
    }
  }
}

export function createLocalCredentialRunner(
  engineConnections: Pick<EngineConnectionService, 'materializeToHome' | 'captureFromHome'>,
  innerRunner: RuntimeCommandRunner = realRuntimeCommandRunner,
  environments?: EnvironmentLookup,
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
  /**
   * Só para a trava de renovação. Opcional porque este runner é usado em
   * testes sem banco: sem ele, o comportamento é o de antes (captura sempre) —
   * pior que ter trava, melhor que não capturar.
   */
  prismaDaTrava?: PrismaParaTrava
): RuntimeCommandRunner {
  return async (request) => {
    const runtime = request.env['GITORCH_RUNTIME']
    const ownerUserId = request.env['GITORCH_OWNER_USER_ID']
    if (!runtime || !ownerUserId) return innerRunner(request)

    const dir = path.join(os.tmpdir(), `gitorch-local-cred-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    let materializou = false
    try {
      const ok = await engineConnections.materializeToHome(ownerUserId, runtime, dir)
      // SEM CREDENCIAL, NÃO DISPARA — irmão exato da guarda em
      // `criarPreparadorDeMontagens` (caminho do container), pelo mesmo motivo
      // medido: subir o motor sem credencial gasta a rodada para colher um 401
      // que o produto já sabia que viria. `SemCredencialDoMotorError` é falha de
      // MOTOR, então a cadeia cai na reserva na hora em vez de morrer aqui.
      exigirCredencialDoMotor(ok, runtime, ownerUserId)
      materializou = true

      // Espelha o loop genérico do entrypoint.sh (infra/agent-image/ no repo
      // privado de infra, movido de scripts/infra/agent-image/ na task t8):
      // qualquer arquivo em .gitorch/env/* vira variável de ambiente do
      // processo filho — aqui é o único lugar que faz isso fora do container.
      const envDir = path.join(dir, '.gitorch', 'env')
      const envAdditions: Record<string, string> = { HOME: dir }
      const envFiles = await fs.readdir(envDir).catch(() => [] as string[])
      for (const name of envFiles) {
        envAdditions[name] = (await fs.readFile(path.join(envDir, name), 'utf8')).trim()
      }

      // Motor VERSIONADO do ambiente do cliente (W1.3.1): se o bootstrap já
      // instalou o runtime ali dentro, o processo filho o acha ANTES do
      // binário genérico do host (prepend no PATH) — sem isto a missão
      // sempre rodava o `agy`/`codex`/`claude` do host, ignorando o
      // isolamento por versão que o wizard prometeu. Fallback (sem
      // ambiente/resourcesLock/bin) preserva o comportamento de hoje, mas
      // nunca em silêncio.
      if (environments) {
        const resolution = await resolveEngineBinDir(ownerUserId, runtime, environments)
        if (resolution.dir) {
          const hostPath = request.env['PATH'] ?? process.env['PATH'] ?? ''
          envAdditions['PATH'] = `${resolution.dir}:${hostPath}`
          log?.info(
            `[Scheduler] Missão de ${ownerUserId} usa motor versionado do ambiente (${runtime}): ${resolution.dir}`
          )
        } else {
          log?.warn(
            `[Scheduler] Motor versionado indisponível para ${ownerUserId}/${runtime} — caindo pro binário do host (${resolution.fallbackReason})`
          )
        }
      }

      return await innerRunner({ ...request, env: { ...request.env, ...envAdditions } })
    } finally {
      // A AMNÉSIA DE RENOVAÇÃO, consertada aqui. Os CLIs dos três motores
      // renovam o próprio token sozinhos quando são chamados — provado ao
      // vivo em 20/08/2026: um `agy -p` no host fez o arquivo de credencial
      // saltar de 20/07 para 20/08. Só que aqui o motor roda num HOME
      // temporário que a linha seguinte apaga, então a renovação morria
      // junto e o cofre continuava servindo o token vencido em toda missão,
      // até o refresh_token vencer de vez. Foi assim que a esteira ficou
      // parada de 17/08 a 20/08 sem ninguém perceber.
      //
      // No FINALLY de propósito, não no caminho de sucesso: uma missão que
      // falhou no TRABALHO pode ter renovado a credencial antes de falhar, e
      // jogar isso fora é perder de graça uma credencial boa.
      //
      // Nunca derruba a missão: falha ao capturar vira aviso. O trabalho já
      // foi feito; perder o resultado por causa do cofre seria trocar um
      // problema por outro pior.
      if (materializou) {
        // UMA RENOVAÇÃO POR VEZ. O refresh token de alguns provedores é de uso
        // único: se a vigília horária estiver renovando esta mesma conta agora,
        // capturar aqui queima o token e derruba a credencial do cliente —
        // medido em 26/08 com o codex ("Your refresh token has already been
        // used"). Sem a trava, saímos calados: a próxima missão captura.
        // ESPERA a vez em vez de desistir dela. O código anterior PULAVA a
        // devolução quando a trava estava ocupada, com o comentário "a próxima
        // missão captura" — e para token rotativo isso é o contrário do certo.
        //
        // O refresh token do Codex é de USO ÚNICO: o CLI renova sozinho ao ser
        // chamado, então este HOME termina com a credencial NOVA e o cofre com
        // a VELHA, que o provedor já invalidou. Pular a devolução mandava a
        // nova para o lixo junto com o HOME (o `fs.rm` logo abaixo) e deixava
        // o cofre servindo um token morto. A missão seguinte levava 401, e não
        // havia volta: a conexão do cliente morria de vez.
        //
        // Foi isto que fez o dono religar o Codex duas vezes num dia, textual:
        // "precisa urgentemente resolver esse problema de perder conexão".
        //
        // Estourar a espera NÃO cancela a devolução: perder o único token
        // válido é pior que uma escrita concorrente, que no máximo regrava o
        // mesmo valor.
        const minhaVez = prismaDaTrava
          ? await esperarAVezDeDevolver({
              pegar: () =>
                pegarATrava({
                  prisma: prismaDaTrava,
                  userId: ownerUserId,
                  runtime,
                  agora: new Date(),
                }).catch(() => true),
              esperar: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
              agora: () => Date.now(),
            })
          : true
        if (!minhaVez) {
          log?.warn(
            `[Scheduler] a trava de ${runtime} não abriu a tempo; devolvendo a credencial assim mesmo — perder uma renovação é pior`
          )
        }
        {
          try {
            await engineConnections
              .captureFromHome(ownerUserId, runtime, dir)
              .catch((err: unknown) =>
                log?.warn(
                  `[Scheduler] não consegui devolver ao cofre a credencial de ${runtime} do dono ${ownerUserId}: ${(err as Error).message}`
                )
              )
          } finally {
            // Solta assim que termina: deixar vencer sozinha funcionaria, mas
            // faria a próxima renovação legítima esperar dois minutos à toa.
            if (prismaDaTrava) {
              await soltarATrava({
                prisma: prismaDaTrava,
                userId: ownerUserId,
                runtime,
                agora: new Date(Date.now() + VALIDADE_DA_TRAVA_MS),
              }).catch(() => undefined)
            }
          }
        }
      }
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

/**
 * Runner das missões conforme o executor. No modo podman, cada missão roda em
 * container descartável: enxerga só o workspace e as credenciais montadas —
 * nunca o .env do control plane ou o sistema de arquivos do host. No modo
 * local-process, credencial ainda é materializada (createLocalCredentialRunner)
 * — só o mecanismo de isolamento (container vs HOME temporário) muda.
 */
export function buildMissionRunner(
  app: FastifyInstance,
  environments: EnvironmentLookup
): RuntimeCommandRunner {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor !== 'podman') {
    // Achado importante da revisão pós-merge: local-process é o DEFAULT (e o
    // que a CI usa) e não tinha NENHUMA trava equivalente à do caminho
    // podman — --dangerously-skip-permissions (fixa no código) rodava solta.
    // Regra do dono, literal: "nunca existe agente solto sem trava". Mesmo
    // gate do container, adaptado pro host (ver host-plugin-gate.ts).
    return wrapWithHostGitorchPluginGate(
      createLocalCredentialRunner(
        app.engineConnections,
        undefined,
        environments,
        app.log,
        app.prisma as unknown as PrismaParaTrava
      )
    )
  }

  const image = process.env['GITORCH_AGENT_IMAGE'] ?? 'localhost/gitorch-agent:latest'
  const engine = process.env['GITORCH_CONTAINER_ENGINE'] ?? 'podman'
  const stagingBase = process.env['GITORCH_MISSION_CRED_DIR'] ?? '/var/lib/gitorch/mission-creds'
  app.log.info(`[Scheduler] Missões em container: engine=${engine} image=${image}`)

  // Varredura no boot: um crash entre materializar e limpar deixaria credencial
  // descriptografada no disco. No boot não há missão ativa, então tudo em
  // stagingBase é órfão e é removido. O diretório nasce 0700.
  void fs
    .rm(stagingBase, { recursive: true, force: true })
    .then(() => fs.mkdir(stagingBase, { recursive: true, mode: 0o700 }))
    .catch((err) => app.log.warn(err, '[Scheduler] falha ao limpar staging de credenciais no boot'))

  const prepareMounts = criarPreparadorDeMontagens({
    engineConnections: app.engineConnections,
    stagingBase,
    log: app.log,
  })

  const memoryLimit = process.env['GITORCH_MISSION_MEMORY'] ?? '2g'
  const missionCpus = resolveMissionCpus()
  return createPodmanCommandRunner({
    image,
    podmanBinary: engine,
    userNamespace: engine === 'docker' ? false : 'keep-id',
    memoryLimit,
    // Default = o próprio memoryLimit (zero swap adicional): provado ao vivo
    // que sem --memory-swap o podman deixa o container escapar até ~2x o
    // teto nominal (ver podman-runner.ts). Configurável separadamente só se
    // o operador quiser conceder folga de swap de propósito.
    memorySwapLimit: process.env['GITORCH_MISSION_MEMORY_SWAP'] ?? memoryLimit,
    // Teto de CPU (P2-4): fecha o caminho que faltava — memória já tinha teto,
    // CPU não tinha nenhum (ver podman-runner.ts).
    cpus: missionCpus,
    prepareMounts,
    // Decisão do dono (ver AGY_SKIP_PERMISSIONS_FLAG abaixo): nenhuma missão
    // roda sem confirmar que o plugin de segurança do GitOrch está na
    // imagem — --dangerously-skip-permissions fixa no código não pode ficar
    // sem trava se o plugin um dia deixar de ser instalado.
    requireGitorchPlugin: true,
    // Achado importante: identifica ESTE runner (o host local) na chave do
    // cache da verificação — sem isto colide com o stack remoto do free-tier
    // quando engine+imagem batem por default (ver runnerId em podman-runner.ts).
    runnerId: 'local',
  })
}

export interface RuntimeStack {
  registry: RuntimeRegistry
  orchestrator: AgentOrchestrator
  workspaceProvider: WorkspaceProvider
}

/** Fixa no código — ver o comentário no call site em buildRuntimeStack. */
const AGY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'

/**
 * Monta os argumentos do Antigravity CLI. `--dangerously-skip-permissions`
 * sempre aparece, exatamente uma vez, mesmo que GITORCH_AGY_EXTRA_ARGS também
 * a declare (dedupe) — nunca depende só da env var, que pode não existir num
 * ambiente novo/recriado.
 */
export function buildAntigravityCliArgs(
  printTimeout: string,
  extraArgsEnv: string | undefined
): string[] {
  const extraArgs = (extraArgsEnv ?? '')
    .split(' ')
    .filter(Boolean)
    .filter((arg) => arg !== AGY_SKIP_PERMISSIONS_FLAG)
  return ['--sandbox', '--print-timeout', printTimeout, AGY_SKIP_PERMISSIONS_FLAG, ...extraArgs]
}

/**
 * Registra os adaptadores de motor (Antigravity + Codex) num registry NOVO e
 * monta o orchestrator em cima do workspace dado. Parametrizado por
 * missionRunner/workspaceProvider para poder existir em duas instâncias
 * independentes — uma local (produção paga, comportamento de sempre) e uma
 * remota (tier grátis, isolada na MT-SaaS) — sem duplicar a lógica de registro
 * dos motores.
 */
function buildRuntimeStack(
  app: FastifyInstance,
  missionRunner: RuntimeCommandRunner | undefined,
  workspaceProvider: WorkspaceProvider
): RuntimeStack {
  const registry = new RuntimeRegistry()
  // Nota: missionRunner agora é sempre definido (local-process também tem um
  // runner, via createLocalCredentialRunner) — "containerized" precisa checar
  // o executor de verdade, não mais a presença de um runner.
  const containerized = process.env['GITORCH_EXECUTOR'] === 'podman'

  // Motor principal: Antigravity CLI. Política do projeto: runtimes de agente
  // autenticam por OAuth (nunca por chave de API embutida no ambiente).
  // GITORCH_ANTIGRAVITY_MODE=api mantém a ponte REST apenas para diagnóstico.
  if (process.env['GITORCH_ANTIGRAVITY_MODE'] === 'api') {
    registry.register(
      createPythonSdkRuntimeAdapter({
        runtime: 'antigravity',
        scriptPath: runtimeScriptPath,
      })
    )
  } else {
    // --sandbox: ADICIONA restrições de terminal e é o que faz os hooks do
    // plugin GitOrch (gate de shell/leitura, convergência) rodarem.
    // --dangerously-skip-permissions: FIXA NO CÓDIGO, não numa env var. Em modo
    // headless o motor não tem como perguntar "posso?" e auto-nega toda
    // ferramenta (o agente só narra intenções); o próprio binário instrui esta
    // flag ("Settings allow-rules do not apply"). Vivendo só numa env var, uma
    // reinstalação ou um .env recriado quebra a esteira inteira em silêncio —
    // por isso ela é obrigatória aqui. A segurança real continua sendo o gate
    // de hooks do GitOrch dentro do container, verificado ao vivo bloqueando
    // npm install e curl mesmo com a flag ligada (as duas negativas ficam no
    // log de auditoria).
    // --print <missão>: a missão é o VALOR de --print e vem POR ÚLTIMO. Medido
    // ao vivo contra a imagem real: stdin 0/3, argumento solto 0/1, assim 2/2.
    const printTimeout = process.env['GITORCH_AGY_PRINT_TIMEOUT'] ?? '20m'
    registry.register(
      createCliRuntimeAdapter({
        runtime: 'antigravity',
        // Em container o binário vem da imagem; no host, do PATH/config.
        binary: containerized ? 'agy' : (process.env['GITORCH_AGY_BIN'] ?? 'agy'),
        args: buildAntigravityCliArgs(printTimeout, process.env['GITORCH_AGY_EXTRA_ARGS']),
        modelArgName: '--model',
        workspaceDirArgName: '--add-dir',
        promptArgName: '--print',
        ...(missionRunner ? { runner: missionRunner } : {}),
      })
    )
  }

  // Motor secundário: Codex CLI (OAuth). Sandbox só-leitura auto-executa
  // ferramentas de leitura sem TTY; --skip-git-repo-check dispensa a exigência
  // de repo git no cwd. O diretório da missão chega pelo cwd do runner.
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'codex',
      binary: 'codex',
      args: ['exec', '-s', 'read-only', '--skip-git-repo-check'],
      ...(missionRunner ? { runner: missionRunner } : {}),
    })
  )

  // Motor co-igual: Claude Code CLI (OAuth). A credencial já chega como env
  // CLAUDE_CODE_OAUTH_TOKEN (connectRawToken, credentialKind 'env') — sem este
  // adaptador de EXECUÇÃO o motor conectava mas nunca rodava ("No runtime
  // adapter registered for claude"), que é a fachada que o plano proíbe.
  // -p: modo não-interativo (print). --permission-mode plan: analisa sem
  // mutar, o equivalente ao read-only do Codex, e NÃO usamos
  // --dangerously-skip-permissions (o classificador de permissões bloqueia,
  // com razão). --model recebe o modelo da missão; o diretório vem pelo cwd
  // do runner, como no Codex. Flags confirmadas nos docs oficiais do CLI.
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'claude',
      binary: containerized ? 'claude' : (process.env['GITORCH_CLAUDE_BIN'] ?? 'claude'),
      args: ['-p', '--permission-mode', 'plan'],
      modelArgName: '--model',
      ...(missionRunner ? { runner: missionRunner } : {}),
    })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
    workspace: workspaceProvider,
    // Injeta conhecimento do projeto (codegraph + memórias do Cortex) no contexto.
    enrichContext: buildMissionEnricher({ cortex: app.cortex }),
  })

  return { registry, orchestrator, workspaceProvider }
}

/**
 * Stack REMOTO para missões de tier grátis: roda na MT-SaaS (VM de terceiro,
 * isolada) via SSH, nunca na nossa VM. Só existe se as variáveis do free-tier
 * estiverem configuradas — ausência delas é o caso comum hoje (a MT-SaaS não
 * está com o wiring de produção ligado) e `null` faz o dispatch cair no
 * stack local de sempre (ver selectRuntimeStack). Sem env → produção intacta.
 */
export function buildRemoteRuntimeStackIfConfigured(app: FastifyInstance): RuntimeStack | null {
  // .trim() antes do teste de vazio: nem todo mecanismo que seta env var
  // corta espaço (ex.: `export` de shell) — um valor só-espaço passaria no
  // teste falsy cru e tentaria um build remoto quebrado em vez de cair no
  // stack local (mesma convenção de config/mission-cpus.ts).
  const host = process.env['GITORCH_FREE_TIER_SSH_HOST']?.trim()
  const identityFile = process.env['GITORCH_FREE_TIER_SSH_KEY']?.trim()
  if (!host || !identityFile) return null

  app.log.info(`[Scheduler] Stack remoto do tier grátis configurado: ${host}`)

  // Um único runner SSH serve tanto o clone do workspace (sh -c direto no nó
  // remoto) quanto o `podman run` da missão (composto como hostRunner) — o
  // mesmo destino, a mesma chave, sem duplicar a lógica de conexão.
  const sshRunner = createSshCommandRunner({ host, identityFile })

  const image = process.env['GITORCH_FREE_TIER_AGENT_IMAGE'] ?? process.env['GITORCH_AGENT_IMAGE']
  const engine = process.env['GITORCH_FREE_TIER_CONTAINER_ENGINE'] ?? 'podman'
  const remoteMemoryLimit = process.env['GITORCH_MISSION_MEMORY'] ?? '2g'
  const remoteMissionRunner = createPodmanCommandRunner({
    image: image ?? 'localhost/gitorch-agent:latest',
    podmanBinary: engine,
    userNamespace: 'keep-id',
    memoryLimit: remoteMemoryLimit,
    // Mesmo raciocínio do stack local (ver buildMissionRunner): default sem
    // folga de swap, fechando a mesma fuga provada ao vivo no podman.
    memorySwapLimit: process.env['GITORCH_MISSION_MEMORY_SWAP'] ?? remoteMemoryLimit,
    // Mesmo teto de CPU do stack local (P2-4): mesma resolução, mesmo default
    // e mesma blindagem contra env vazia/inválida (ver config/mission-cpus.ts).
    cpus: resolveMissionCpus(),
    hostRunner: sshRunner,
    // Mesma trava do stack local (ver buildMissionRunner): a verificação sobe
    // pelo MESMO sshRunner, confirmando o gate na imagem do nó remoto real.
    requireGitorchPlugin: true,
    // Achado importante: sem isto, engine+imagem defaults iguais ao stack
    // local colidiam na MESMA chave de cache e a missão remota reusava,
    // sem nunca checar de verdade, o resultado verificado no host LOCAL.
    // `host` distingue nós remotos diferentes entre si também.
    runnerId: `ssh:${host}`,
  })

  // RemoteWorkspaceProvider exige um runner sempre-Promise; RuntimeCommandRunner
  // permite retorno síncrono (raro, mas o tipo permite) — normaliza com Promise.resolve.
  const remoteWorkspaceProvider = new RemoteWorkspaceProvider(
    async (cmd) => sshRunner(cmd),
    process.env['GITORCH_FREE_TIER_REMOTE_BASE_DIR']
  )

  return buildRuntimeStack(app, remoteMissionRunner, remoteWorkspaceProvider)
}

/**
 * Decide qual stack usa uma missão: grátis com stack remoto disponível → nó
 * isolado da MT-SaaS; qualquer outro caso (pago, sem plano resolvido, ou
 * grátis sem o stack remoto configurado) → local, o comportamento de sempre.
 * Pura e testável — a decisão de roteamento por tier vive aqui, isolada do
 * resto do dispatch.
 */
export function selectRuntimeStack(
  planId: string | undefined,
  local: RuntimeStack,
  remote: RuntimeStack | null
): RuntimeStack {
  if (planId === 'free' && remote) return remote
  return local
}

export interface SetupMissionRecord {
  id: string
  project: {
    id: string
    wingId: string
    userId: string | null
    runtimeConfig?: unknown
    /**
     * Até onde o GitOrch pode ir no repositório DESTE cliente.
     *
     * Viaja junto com o projeto porque `provisionSetupMission` CRIA e LIGA o
     * quadro no repositório dele — escrita de verdade, que precisa da mesma
     * porta que o resto do produto usa. Antes desta linha o cliente do quadro
     * era montado com `fetchComTeto(fetch)`: tinha teto de tempo e NENHUMA
     * guarda de autonomia. Nulo cai no nível mais restrito, que é o lado
     * seguro.
     */
    autonomia?: string | null
  }
}

export interface SetupMissionOutcome {
  status: 'completed' | 'failed'
  output?: string
  error?: string
}

/** Só o pedaço do Prisma que o board precisa gravar — testável sem mock do client inteiro. */
type SetupBoardPrisma = Pick<PrismaClient, 'project'>

export interface ProvisionSetupMissionDeps {
  /**
   * Presença habilita o passo do board (Task 9): sem `prisma` (chamadas
   * antigas/testes de clone), o passo é pulado por completo — nunca toca
   * rede nem tenta gravar nada. Produção sempre passa `app.prisma`.
   */
  prisma?: SetupBoardPrisma
  /** injeção para teste; default: `new ProjectV2Client({ token })`. */
  createProjectV2Client?: (
    token: string
  ) => Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'>
  /** injeção para teste; default: `resolveGithubOwnerId(owner, token)`. */
  resolveOwner?: (owner: string, token: string) => Promise<ResolvedOwner>
  /**
   * injeção para teste; default: `resolveGithubRepositoryId(repository, token)`.
   * Liga o board recém-criado ao repositório (achado em produção: sem isto o
   * board fica pendurado só no dono, nunca aparece na aba /projects do
   * repositório). Só é usada quando `createProjectV2Client` também não foi
   * sobrescrito — testes que injetam um client próprio (sem
   * `linkProjectV2ToRepository`) continuam pulando o passo, como antes.
   */
  resolveRepositoryId?: (repository: string, token: string) => Promise<string>
  /**
   * injeção para teste; default: `mintInstallationToken`. O board é criado
   * com a identidade do PRODUTO (installation token do App), não com o token
   * pessoal do dono: criar board de organização com o token do login
   * user-to-server devolve "does not have the correct permissions to execute
   * CreateProjectV2". Sem instalação do App para o repositório, cai no token
   * do dono — que ainda resolve board de conta pessoal.
   */
  mintInstallationToken?: (args: {
    repository: string
    onWarn?: (message: string) => void
    onError?: (message: string) => void
  }) => Promise<string | null>
  /**
   * Logger estruturado (produção sempre passa `app.log`); sem ele cai no
   * console apenas para chamadas fora do plugin (ex.: scripts, testes que
   * não o injetam). Achado importante: sem `githubToken`/`prisma`, o passo do
   * board era pulado calado — o projeto herdava o board global sem nenhum
   * rastro. Agora o pulo sempre avisa por quê.
   */
  log?: Pick<FastifyBaseLogger, 'warn' | 'info'>
}

/**
 * Executa de verdade a missão `clone_and_start_engines` do wizard: aloca (e
 * clona) o workspace do projeto no stack ATIVO (local ou remoto, já
 * selecionado por selectRuntimeStack antes de chamar isto). Sem isto a
 * missão criada por setup/submit ficava órfã — nenhum código a consumia — e
 * envelhecia até `failStuckMissions` marcá-la failed, uma falsa falha para
 * algo que nunca rodou (spec setup-wizard-redesign §17.3).
 *
 * Também garante o PRÓPRIO board Projects v2 do projeto (Task 9): antes disto
 * `GITORCH_PROJECT_BOARD` era um env GLOBAL, então todo projeto novo apontava
 * para o board pessoal de outro projeto. Falha ao criar o board NUNCA derruba
 * o provisionamento — `ensureProjectBoard` já degrada sozinho e avisa; aqui só
 * persistimos o resultado quando ele vier não-nulo.
 */
export async function provisionSetupMission(
  mission: SetupMissionRecord,
  activeStack: RuntimeStack,
  githubToken?: string,
  deps: ProvisionSetupMissionDeps = {}
): Promise<SetupMissionOutcome> {
  try {
    await activeStack.workspaceProvider.allocateWorkspace(
      mission.project.userId ?? 'scheduler-user',
      mission.project.id,
      { repository: mission.project.wingId, ...(githubToken ? { token: githubToken } : {}) }
    )

    // Identidade certa para o board: o App instalado no repositório. O token
    // do dono é o plano B (conta pessoal), nunca o preferido.
    const mintForBoard = deps.mintInstallationToken ?? mintInstallationToken
    const avisarBoard = (m: string): void => (deps.log ?? console).warn(`[Scheduler] ${m}`)
    const appToken = deps.prisma
      ? await mintForBoard({
          repository: mission.project.wingId,
          onWarn: avisarBoard,
          onError: avisarBoard,
        })
      : null
    const boardToken = appToken ?? githubToken

    if (boardToken && deps.prisma) {
      // IMPORTANTE (leva D): achado nesta auditoria além da lista do
      // despacho — mesma classe de defeito do Crítico. `provisionSetupMission`
      // é chamada por `processSetupMissions` dentro de `tick()`, sob
      // `tickEmAndamento`; o default aqui (sem `createProjectV2Client`
      // injetado) caía num `ProjectV2Client` sem teto nenhum. O teto mora na
      // PRÓPRIA função (não só no call site) para qualquer chamador futuro
      // que esqueça de injetar `createProjectV2Client` herdar a proteção —
      // mesma disciplina de `endereco-seguro.ts` ("a guarda mora aqui e não
      // nos chamadores").
      const client = deps.createProjectV2Client
        ? deps.createProjectV2Client(boardToken)
        : new ProjectV2Client({
            token: boardToken,
            // Teto de tempo E guarda de autonomia. Antes era só
            // `fetchComTeto(fetch)`: criar e ligar quadro no repositório do
            // cliente passava por fora da porta que o bloco 4 construiu — o
            // furo que a própria auditoria daquele bloco tinha se proposto a
            // fechar, num caminho que ela não varreu.
            fetchImpl: fetchDoRepositorio({ nivel: () => mission.project.autonomia }),
          })
      // Achado importante: sem passar o número já gravado, findProjectId
      // nunca rodava e todo provisionamento criava board NOVO — finalizar o
      // wizard 2x para o mesmo repositório duplicava o board. O número já
      // vive em runtimeConfig.envConfig.GITORCH_PROJECT_BOARD ("owner/N"),
      // gravado pela primeira execução desta mesma função.
      const boardJaGravado = (
        (mission.project.runtimeConfig as Record<string, unknown> | null)?.['envConfig'] as
          Record<string, unknown> | undefined
      )?.['GITORCH_PROJECT_BOARD'] as string | undefined
      const existingNumber = boardJaGravado ? Number(boardJaGravado.split('/')[1]) : undefined
      const board = await ensureProjectBoard({
        repository: mission.project.wingId,
        client,
        resolveOwner: (owner) =>
          deps.resolveOwner
            ? deps.resolveOwner(owner, boardToken)
            : resolveGithubOwnerId(owner, boardToken),
        // Só resolve/liga quando há como (deps explícita, ou nenhum client
        // customizado foi injetado — aí `client` é o ProjectV2Client real, que
        // TEM linkProjectV2ToRepository). Testes que injetam createProjectV2Client
        // próprio sem esse método continuam pulando o passo, como sempre.
        ...(deps.resolveRepositoryId
          ? {
              resolveRepositoryId: (repository: string) =>
                deps.resolveRepositoryId!(repository, boardToken),
            }
          : !deps.createProjectV2Client
            ? {
                resolveRepositoryId: (repository: string) =>
                  resolveGithubRepositoryId(repository, boardToken),
              }
            : {}),
        ...(existingNumber !== undefined && Number.isFinite(existingNumber)
          ? { existingNumber }
          : {}),
        onWarn: (m) => (deps.log ?? console).warn(`[Scheduler] ${m}`),
      })

      if (board) {
        const runtimeConfig = (mission.project.runtimeConfig as Record<string, unknown>) ?? {}
        await deps.prisma.project.update({
          where: { id: mission.project.id },
          data: {
            runtimeConfig: {
              ...runtimeConfig,
              envConfig: {
                ...((runtimeConfig['envConfig'] as Record<string, unknown> | undefined) ?? {}),
                GITORCH_PROJECT_BOARD: `${board.owner}/${board.number}`,
              },
            },
          },
        })
      }
    } else {
      // Degradação silenciosa (achado importante): sem token do dono ou sem
      // prisma, o projeto NUNCA ganha board próprio e herdaria o board
      // global de outro projeto no primeiro trilho do PO. Isso precisa
      // aparecer no log — antes era um pulo mudo.
      const motivo = !githubToken ? 'sem token do GitHub do dono' : 'sem acesso ao Prisma'
      ;(deps.log ?? console).warn(
        `[Scheduler] board próprio NÃO provisionado para ${mission.project.wingId} (${motivo}); trilhos do PO ficam desligados até haver board`
      )
    }

    return { status: 'completed', output: `Ambiente provisionado para ${mission.project.wingId}` }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message }
  }
}

/**
 * Decide quais missões de setup PENDENTES (já em ordem FIFO por createdAt)
 * cabem no teto global de concorrência nesta rodada.
 *
 * `otherActiveCount` é tudo que JÁ ocupa uma vaga e não faz parte deste lote
 * (cadência em running, ou pending de outro tipo) — nunca o próprio lote:
 * contar o lote pendente contra si mesmo faria a fila se autobloquear para
 * sempre (a mera existência de itens pendentes já saturaria o teto e nada
 * jamais provaria ter capacidade disponível).
 *
 * Para na primeira que não cabe (FIFO): as seguintes são mais novas e também
 * ficam de fora — sem "furar a fila" processando uma mais nova antes de uma
 * mais velha só porque ela coube por acaso.
 */
export function selectClaimableSetupMissions<T extends { id: string }>(
  pendingFifo: T[],
  otherActiveCount: number,
  maxConcurrent: number
): T[] {
  let available = maxConcurrent - otherActiveCount
  const claimable: T[] = []
  for (const mission of pendingFifo) {
    if (available <= 0) break
    claimable.push(mission)
    available -= 1
  }
  return claimable
}

/**
 * Ceifador de BOOT (P2-2/E5): a execução de missão vive numa promise em
 * memória (executeMissionWithFailover, abaixo) — um restart do control-plane
 * deixa (a) a linha `running` fantasma no banco até a varredura de stale
 * (STALE_RUNNING_MS) e (b) o container podman vivo segurando RAM/CPU numa VM
 * compartilhada. DECISÃO DO DONO: a esteira de DEPLOY drena missões em voo
 * (timeout) antes de trocar de versão (F2.3.2) — a instância anterior sempre
 * para por completo antes da nova subir. A única outra instância que pode
 * coexistir é o probe INERTE de pipeline-check (GITORCH_PIPELINE_CHECK=1,
 * F2.1.2), que retorna ANTES de chegar aqui (ver guard no início do plugin) e
 * nunca reap. Logo, no boot, todo container `gitorch-mission-*` e toda
 * missão `running` são órfãos por construção — sem essa garantia isto seria
 * destrutivo (mataria trabalho legítimo). Nunca derruba o boot: falha do
 * runtime de container (podman ausente, permissão, timeout) OU do prisma é
 * capturada e logada aqui — nunca silenciosa, nunca propaga.
 */
export async function runBootReaper(
  app: FastifyInstance,
  run: RuntimeCommandRunner = realRuntimeCommandRunner,
  bootAt: Date = new Date()
): Promise<void> {
  if ((process.env['GITORCH_EXECUTOR'] ?? 'local-process') === 'podman') {
    const engine = process.env['GITORCH_CONTAINER_ENGINE'] ?? 'podman'
    const result = await reapOrphanContainers(run, engine).catch((err: unknown) => {
      app.log.warn(err, '[Scheduler] ceifador: falha ao listar containers órfãos')
      return { removed: [], failed: [] } as ReapResult
    })
    if (result.removed.length > 0) {
      app.log.warn(`[Scheduler] ceifador: ${result.removed.length} container(s) órfão(s) removidos`)
    }
    if (result.failed.length > 0) {
      // Honesto: um `rm -f` que não confirmou remoção NUNCA vira "removido"
      // no log — é exatamente o container-segurando-RAM que este ceifador
      // existe para eliminar (ver ReapResult em boot-reaper.ts).
      app.log.warn(
        { failed: result.failed },
        `[Scheduler] ceifador: ${result.failed.length} container(s) órfão(s) falharam ao remover`
      )
    }
  }

  const failed = await failOrphanRunningMissions(app.prisma, bootAt).catch((err: unknown) => {
    app.log.warn(err, '[Scheduler] ceifador: falha ao marcar missões órfãs')
    return 0
  })
  if (failed > 0) {
    app.log.warn(`[Scheduler] ceifador: ${failed} missão(ões) órfã(s) de restart → failed`)
  }
}

/**
 * A reconferência PERIÓDICA de acesso, ligada ao relógio.
 *
 * A decisão em si é pura e mora em services/reconferencia-de-acesso.ts (com os
 * casos: acesso ok, sem acesso, inverificável uma vez, inverificável várias
 * vezes, recuperado). Aqui só se resolve DE ONDE vêm os projetos, COM QUAL
 * credencial a pergunta é feita, ONDE o resultado é gravado e POR ONDE o dono
 * é avisado.
 *
 * Exportada — e não escondida dentro do plugin — pelo mesmo motivo de
 * `runBootReaper`: é o pedaço que só o wiring pode errar, e ele precisa ser
 * testável sem subir o relógio inteiro.
 *
 * Roda a cada tique, mas NÃO pergunta a cada tique: `precisaReconferir` é que
 * decide, projeto a projeto, se já é hora — uma prova por projeto por ciclo,
 * nunca uma por missão.
 */
/**
 * ESTEIRA-T15: classifica o texto e decide o canal — auditoria vira linha em
 * `events` (timeline do Painel), executivo vai para o Telegram do dono.
 *
 * Módulo-level (não fecha sobre `schedulerPlugin`) de propósito:
 * `reconferirAcessoDoRelogio` é função exportada e testável fora do plugin,
 * então não enxerga o closure de lá — sem este helper compartilhado, a
 * classificação teria que ser reimplementada nos dois lugares e podia
 * divergir em silêncio.
 *
 * Devolve `true`/`false` conforme o aviso realmente saiu (gravou a
 * auditoria, ou o Telegram entregou) — fix/telegram-notifier-propaga-falha:
 * antes retornava `Promise<void>` sempre resolvido, e quem tentava saber se
 * o dono FOI avisado de verdade (qa-rails-mission.ts) nunca conseguia.
 */
async function avisarOuAuditar(
  app: FastifyInstance,
  projeto: NotifiableProject & { id: string; wingId: string },
  texto: string
): Promise<boolean> {
  if (classificarAviso(texto) === 'auditoria') {
    return app.prisma.event
      .create({ data: { projectId: projeto.id, type: 'audit', payload: { texto } } })
      .then(() => true)
      .catch((err) => {
        app.log.warn(err, `[Scheduler] não deu para gravar a auditoria de ${projeto.wingId}`)
        return false
      })
  }
  const notifyChatId = await resolveNotifyChatId(app.prisma, projeto, {
    instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
    instanceChatId: process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
  })
  // `onDeliveryFailure` só loga `err.name`, nunca o erro cru: a URL desta
  // chamada embute o TOKEN DO BOT no caminho (buildTelegramNotifier), e
  // "algumas implementações de fetch" compõem a URL na mensagem de erro —
  // mesma cautela já aplicada em `reconferirAcessoDoRelogio` (achado
  // ⚠️ CRÍTICO A VERIFICAR da revisão do Baixo 6, ver comentário lá).
  const notify = buildTelegramNotifier({
    botToken: process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
    ...(notifyChatId ? { chatId: notifyChatId } : {}),
    onDeliveryFailure: (err) =>
      app.log.warn(
        { erroDeEntrega: err instanceof Error ? err.name : typeof err },
        `[Scheduler] aviso de publicação falhou para ${projeto.wingId}`
      ),
  })
  if (!notify) return false
  return notify(texto)
}

export async function reconferirAcessoDoRelogio(
  app: FastifyInstance,
  agora?: Date
): Promise<ResumoDaReconferencia> {
  const provarEscrita = provaDeEscritaNoUso(app.engineConnections)

  return reconferirAcessoDosProjetos({
    projetos: async () => {
      const linhas = await app.prisma.project.findMany({
        where: { isActive: true },
        select: {
          id: true,
          wingId: true,
          userId: true,
          accessCheckedAt: true,
          accessSuspendedAt: true,
          accessSuspendedReason: true,
          accessCheckFailures: true,
        },
      })
      return linhas.map((linha) => ({
        id: linha.id,
        repo: linha.wingId,
        ownerId: linha.userId,
        estado: {
          conferidoEm: linha.accessCheckedAt,
          suspensoEm: linha.accessSuspendedAt,
          motivoDaSuspensao: linha.accessSuspendedReason,
          falhasSeguidas: linha.accessCheckFailures,
        },
      }))
    },
    provarEscrita,
    salvar: async (projectId, estado) => {
      await app.prisma.project.update({
        where: { id: projectId },
        data: {
          accessCheckedAt: estado.conferidoEm,
          accessSuspendedAt: estado.suspensoEm,
          accessSuspendedReason: estado.motivoDaSuspensao,
          accessCheckFailures: estado.falhasSeguidas,
        },
      })
    },
    // O aviso é do DONO daquele projeto — mesma resolução do resto do
    // scheduler: sem vínculo real (telegram_links, nascido do /start dele),
    // ninguém é avisado, e o projeto de um cliente nunca vira mensagem no chat
    // de outro. Sem vínculo o trabalho segue igual: a suspensão vale mesmo sem
    // aviso.
    avisarDono: async (projectId, texto) => {
      const projeto = await app.prisma.project.findUnique({ where: { id: projectId } })
      if (!projeto) return
      await avisarOuAuditar(
        app,
        projeto as NotifiableProject & { id: string; wingId: string },
        texto
      )
    },
    ...(agora ? { agora } : {}),
    onWarn: (mensagem) => app.log.warn(`[Scheduler] ${mensagem}`),
  })
}

/**
 * A renovação AUTOMÁTICA do token do GitHub, ligada ao relógio (F8).
 *
 * O login por GitHub App (client_id Iv23..., "User-to-server token
 * expiration" ligado) expira o access_token a cada ~8h. Sem esta rotina, a
 * credencial materializada em cada missão (materializeToHome, runtime
 * 'github') morre sozinha 8h depois do último login — e ninguém renova.
 *
 * Roda ANTES de qualquer coisa que possa disparar missão no mesmo tique
 * (processSetupMissions, varrerSessoesDoDev): uma missão que nasce logo
 * depois do tique precisa encontrar o token já fresco, não descobrir no
 * meio da execução que ele morreu.
 *
 * Decisão pura em services/github-token-refresh.ts (decidirAcaoGithub); aqui
 * só se resolve DE ONDE vem a lista de conexões, COM QUAL client_id/secret a
 * troca é feita, ONDE o novo par é gravado (reusando connectGitHubToken —
 * mesmo caminho de cifragem de sempre, nunca duplicado) e POR ONDE o dono é
 * avisado quando a conexão precisa ser refeita.
 */
/**
 * Recoleta o CATÁLOGO DE MODELOS dos motores pelo RELÓGIO, uma vez por dia.
 *
 * A irmã da varredura de cotas, e nasce do mesmo defeito visto um degrau mais
 * fundo. `refreshModels` só roda depois de uma missão COMPLETAR (ver o
 * comentário no topo de `refreshQuota`, engine-connection.ts) — e com os
 * motores caindo quase nenhuma completa, então a coleta só acontece quando já
 * não adianta.
 *
 * MEDIDO em 01/09/2026 03:00, no banco de produção: o catálogo do antigravity
 * estava carimbado 31/08 16:12 com 14 modelos, e `agy models` ao vivo no mesmo
 * instante devolvia 11, nenhum da geração 3.5. O do claude estava parado havia
 * QUATRO DIAS. Enquanto o catálogo era enfeite de tela isso era feio; agora que
 * ele DECIDE o modelo da missão (ver `modeloVivoParaAMissao`), é uma guarda
 * aprovando um modelo morto.
 *
 * A cadência da COTA (1 hora) NÃO muda: é o que o dono pediu e está certo. O
 * catálogo muda em dias, e recoletá-lo custa materializar a credencial e rodar
 * o binário do motor — um dia é o intervalo que pega a remoção de uma geração
 * sem pagar por isso a cada hora.
 *
 * Exportada (e não fechada dentro do plugin) pelo mesmo motivo de
 * `renovarTokensGithubDoRelogio`: a decisão pura está testada caso a caso em
 * services/modelos-a-recoletar.test.ts, e o que só o WIRING pode errar — de
 * onde vem a lista, quem é pulado, e que uma falha não derruba as outras —
 * precisa de um teste que chame ISTO, não uma imitação do laço.
 *
 * Nunca rejeita: uma conexão que falha não pode derrubar o tique inteiro.
 */
export async function varrerCatalogoDeModelosDoRelogio(app: FastifyInstance): Promise<void> {
  const conexoes = await app.prisma.engineConnection.findMany({
    where: { runtime: { not: 'github' } },
    select: { userId: true, runtime: true, status: true, modelsCheckedAt: true },
  })
  const vencidas = modelosARecoletar(conexoes, new Date())
  if (vencidas.length === 0) return
  for (const conexao of vencidas) {
    // Em série, pelo mesmo motivo da varredura de cotas: cada coleta
    // materializa a credencial num HOME temporário e roda o binário do motor.
    // Em paralelo, dois motores do mesmo dono disputariam o mesmo refresh token
    // de uso único — o defeito que derrubou a conta do Codex em 26/08.
    try {
      const modelos = await app.engineConnections.refreshModels(conexao.userId, conexao.runtime)
      if (modelos.length === 0) {
        // Nunca zera a lista boa (ver refreshModels): o catálogo anterior fica,
        // a data de sucesso fica velha, e o motivo fica em lastError.
        app.log.warn(
          `[Scheduler] catálogo do ${conexao.runtime} não veio nesta passada; a lista anterior é preservada e a data fica velha`
        )
        continue
      }
      app.log.info(
        `[Scheduler] catálogo do ${conexao.runtime} recoletado: ${modelos.length} modelo(s)`
      )
    } catch (err) {
      app.log.warn(err, `[Scheduler] falhou ao recoletar o catálogo do ${conexao.runtime}`)
    }
  }
}

export async function renovarTokensGithubDoRelogio(
  app: FastifyInstance,
  agora?: Date
): Promise<ResumoDaRenovacaoGithub> {
  const env = getEnv()
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    app.log.warn(
      '[Scheduler] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET ausentes; renovação automática do token do GitHub desligada'
    )
    return {
      renovados: 0,
      precisamReconectar: 0,
      falhasDeDecifragem: 0,
      falhasTransitorias: 0,
      legadosSemAcao: 0,
    }
  }
  const clientId = env.GITHUB_CLIENT_ID
  const clientSecret = env.GITHUB_CLIENT_SECRET

  // Marca a conexão como precisando de login novo e avisa o dono — mas só na
  // VIRADA (status ainda não era 'needs_reconnect'): sem isto, uma conexão
  // parada seria reavisada a cada tique (a cada minuto) para sempre.
  const marcarPrecisaReconectar = async (userId: string, motivo: string): Promise<void> => {
    const atual = await app.prisma.engineConnection.findUnique({
      where: { userId_runtime: { userId, runtime: 'github' } },
      select: { status: true },
    })
    const jaAvisado = atual?.status === 'needs_reconnect'
    await app.prisma.engineConnection.updateMany({
      where: { userId, runtime: 'github' },
      data: { status: 'needs_reconnect', lastError: motivo },
    })
    if (jaAvisado) return

    const dono = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    })
    const notifyChatId = await resolveNotifyChatId(
      app.prisma,
      { userId, user: dono },
      {
        instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
        instanceChatId: process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
      }
    )
    const notify = buildTelegramNotifier({
      botToken: process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
      ...(notifyChatId ? { chatId: notifyChatId } : {}),
      // Achado Baixo 6: buildTelegramNotifier já engole a falha de entrega
      // internamente (a função devolvida nunca rejeita) — um `.catch(...)`
      // aqui embaixo, em volta de `notify(...)`, nunca dispararia. Este
      // callback é o jeito real de registrar quando o dono NÃO pôde ser
      // avisado, sem inventar mecanismo novo: reusa o mesmo `app.log.warn`
      // que todo outro aviso operacional deste arquivo já usa.
      //
      // Achado ⚠️ CRÍTICO A VERIFICAR (revisão do Baixo 6): a URL desta
      // chamada embute o TOKEN DO BOT no próprio CAMINHO
      // (`https://api.telegram.org/bot<token>/sendMessage` — buildTelegramNotifier,
      // sm-watchdog.ts), não num header. Investigação real (não suposição):
      // provoquei DNS falho, conexão recusada e timeout via AbortSignal
      // contra URLs desse formato usando o `fetch` global deste runtime
      // (Node 20 / undici) e inspecionei `.message`, `.cause`, `.stack` e as
      // propriedades enumeráveis do erro produzido — em NENHUM caso a URL
      // apareceu; o erro é sempre `TypeError: fetch failed` com uma `cause`
      // que, no máximo, expõe o HOSTNAME (nunca o path com o token). Também
      // repeti a checagem com o serializador de erro REAL do pino (a mesma
      // versão deste projeto) — a linha de log resultante não contém o
      // token. Mesmo assim, NADA garante isso para sempre: `fetchImpl` é
      // injetável (todo teste deste arquivo já injeta um), e "algumas
      // implementações de fetch" (a preocupação original do achado) de fato
      // compõem a URL na mensagem de erro. Por isso o log AQUI nunca recebe
      // o objeto de erro cru — só o NOME dele (`err.name`, que por
      // construção nunca pode conter uma URL), suficiente para diferenciar
      // timeout de falha de rede sem depender de nenhuma garantia do
      // fetchImpl por trás.
      onDeliveryFailure: (err) =>
        app.log.warn(
          { erroDeEntrega: err instanceof Error ? err.name : typeof err },
          `[Scheduler] aviso de reconexão GitHub não foi entregue para ${userId}`
        ),
    })
    if (!notify) return
    await notify(
      'Sua conexão com o GitHub no GitOrch precisa ser refeita ' +
        `(${motivo}). Abra o GitOrch e faça login com o GitHub de novo — as tarefas ` +
        'automáticas ficam paradas até você reconectar.'
    )
  }

  const resumo = await renovarTokensGithubVencendo({
    // A coluna no Prisma é `encryptedRefreshToken` (EngineConnection.encrypted_refresh_token);
    // `refreshTokenEncrypted` é o nome do campo no DTO `ConexaoGithubElegivel`
    // (services/github-token-refresh.ts) — nomes diferentes de propósito, o
    // mapeamento abaixo é o único lugar que precisa saber dos dois.
    conexoes: async () => {
      const linhas = await app.prisma.engineConnection.findMany({
        where: { runtime: 'github', status: 'connected' },
        select: {
          userId: true,
          encryptedRefreshToken: true,
          expiresAt: true,
          refreshTokenExpiresAt: true,
        },
      })
      return linhas.map((linha) => ({
        userId: linha.userId,
        refreshTokenEncrypted: linha.encryptedRefreshToken,
        expiresAt: linha.expiresAt,
        refreshTokenExpiresAt: linha.refreshTokenExpiresAt,
      }))
    },
    // Composição desta Task: o valor que `conexoes()` devolve em
    // `refreshTokenEncrypted` chega aqui CIFRADO e opaco (ver o comentário no
    // topo de github-token-refresh.ts) — decifrar é responsabilidade de quem
    // liga isto ao relógio, não da orquestração pura. `decryptCredential`
    // lança `CredentialDecryptError` de propósito quando a chave do servidor
    // mudou ou o dado corrompeu; esse erro é deixado atravessar SEM
    // capturar/reembalar, para `renovarTokensGithubVencendo` conseguir
    // distinguir "não consegui LER o que está guardado" (problema nosso, vira
    // `falhasDeDecifragem`) de "o GitHub recusou o cartão"
    // (RefreshTokenGithubInvalidoError, lançado só por trocarRefreshTokenNoGithub
    // — problema do cliente, vira `precisamReconectar`). Reembalar as duas no
    // mesmo tipo faria o produto culpar o cliente por uma falha de
    // infraestrutura nossa.
    trocar: async (refreshTokenEncrypted) => {
      const refreshTokenPlano = decryptCredential(refreshTokenEncrypted)
      return trocarRefreshTokenNoGithub({
        refreshToken: refreshTokenPlano,
        clientId,
        clientSecret,
        // Achado Alto 2 (revisão da Task 5/F8): sem isto, um `fetch` cru
        // (undici) que trava sem responder — nem sucesso, nem rejeição —
        // pendura esta troca PARA SEMPRE, e com ela `tickEmAndamento`
        // (mesma classe de incidente real documentada em sm-watchdog.ts,
        // agora fechada aqui do mesmo jeito: `ghGet`/`ghSend`/o
        // notificador do Telegram já usam `fetchComTeto`). Um estouro de
        // teto rejeita o `fetch` interno de trocarRefreshTokenNoGithub, que
        // já reembala QUALQUER rejeição do transporte (linha 209 do mesmo
        // arquivo) em `FalhaTransitoriaNaTrocaComGithubError` — então o
        // teto aqui automaticamente vira falha TRANSITÓRIA (conta em
        // `resumo.falhasTransitorias`, nunca marca precisa-reconectar),
        // sem precisar de nenhuma lógica nova.
        fetchImpl: fetchComTeto(fetch),
        ...(agora ? { agora } : {}),
      })
    },
    salvarSucesso: async (userId, resultado) => {
      await app.engineConnections.connectGitHubToken(userId, resultado.accessToken, {
        refreshToken: resultado.refreshToken,
        expiresAt: resultado.expiresAt,
        ...(resultado.refreshTokenExpiresAt
          ? { refreshTokenExpiresAt: resultado.refreshTokenExpiresAt }
          : {}),
      })
    },
    marcarPrecisaReconectar,
    ...(agora ? { agora } : {}),
    onWarn: (mensagem) => app.log.warn(`[Scheduler] ${mensagem}`),
  })

  // Achado Baixo 5 (revisão da Task 5/F8): ANTES desta correção o chamador
  // do relógio (tick(), mais abaixo) descartava este retorno inteiro
  // (`await renovarTokensGithubDoRelogio(app)`, sem capturar nada) — a
  // métrica que justifica NÃO avisar as conexões legadas ainda válidas
  // (`resumo.legadosSemAcao`) não chegava a lugar nenhum. O único rastro que
  // existia era um `onWarn` POR CONEXÃO legada, disparado a CADA TIQUE,
  // enquanto ela seguir sem reconectar (dias/semanas) — sem dedupe, pura
  // poluição de log (ver o comentário removido do ramo `legado-token-valido`
  // em github-token-refresh.ts). Aqui vira UMA linha por PASSADA, e só
  // quando há algo a reportar (nenhum contador zerado) — o resumo inteiro
  // finalmente vira um rastro operacional útil, sem spam por conexão.
  if (
    resumo.renovados > 0 ||
    resumo.precisamReconectar > 0 ||
    resumo.falhasDeDecifragem > 0 ||
    resumo.falhasTransitorias > 0 ||
    resumo.legadosSemAcao > 0
  ) {
    app.log.info(resumo, '[Scheduler] renovação de token GitHub: resumo da passada')
  }

  return resumo
}

const schedulerPlugin = fp<SchedulerOptions>(async (app: FastifyInstance) => {
  /**
   * O `fetch` de TODA escrita REST no repositório de um cliente.
   *
   * A auditoria de segurança do bloco 4 achou ONZE chamadas cruas dentro deste
   * arquivo — abrindo, comentando e fechando issue no repositório do cliente,
   * no tique, sem supervisão. Ligar o nível de autonomia em cada uma exigiria
   * mudar tipo, consulta e assinatura em onze lugares, e UM esquecimento
   * reabriria o furo inteiro.
   *
   * Esta porta descobre o dono pelo próprio endereço da chamada: o repositório
   * já está na URL. Quem escreve não precisa saber de autonomia nenhuma.
   */
  const ghComGuarda = fetchComTeto(
    guardaPorRepositorio(fetch, {
      nivelDoRepositorio: async (repo: string) => {
        const linha = await app.prisma.project.findFirst({
          where: { wingId: repo, isActive: true },
          select: { autonomia: true },
        })
        return linha?.autonomia ?? null
      },
      nossosRepositorios: new Set([process.env['GITORCH_SELF_REPO'] ?? 'GitOrchAI/gitorch']),
    }),
    // Mesmo teto de `ghGet`/`ghSend` (a constante em si é declarada mais
    // abaixo, junto das outras chamadas curtas do relógio).
    10_000
  )

  // Modo INERTE do health pré-switch da esteira (F2.3/P1-2): sai ANTES de tocar
  // prisma/engineConnections/cortex — a instância de verificação aponta pro
  // banco de PROD e não pode varrer mission-creds, disparar tick nem disputar
  // missões contra a instância viva. Ver config/pipeline-check.ts.
  if (pipelineCheckEnabled()) {
    // `error`, não `warn` (achado I6): esta é a variável mais perigosa que a
    // branch adiciona — se vazar pro ambiente real, o app sobe, responde
    // health check e serve o front normalmente, mas fica pra sempre inerte
    // (sem tick, sem missão, sem Telegram). Um `warn` se perde no volume
    // normal de log; `error` é impossível de não ver.
    app.log.error(
      '[Scheduler] GITORCH_PIPELINE_CHECK=1: scheduler INERTE (sem tick, sem varredura de creds, sem missões)'
    )
    app.decorate('triggerAgentMission', async (): Promise<TriggerResult> => ({
      triggered: false,
      reason: 'pipeline-check',
    }))
    return
  }

  // Boot timestamp (achado M1): capturado AQUI, no registro do plugin — antes
  // de `app.listen()` sequer devolver, logo antes de qualquer requisição HTTP
  // (e portanto qualquer dispatch de missão via rota admin/QA) ser possível.
  // runBootReaper usa isto pra só falhar missão com `startedAt` ANTERIOR ao
  // boot — nunca uma disparada de verdade nos segundos entre o boot e o
  // ceifador terminar (caminho podman: `ps` + N × `rm -f`).
  const bootAt = new Date()

  // Ceifador de boot (P2-2): nada de "running"/container de missão sobrevive
  // a um restart (ver runBootReaper acima para o raciocínio completo).
  // Fire-and-forget (mesmo padrão da faxina de staging de credenciais
  // abaixo): não atrasa o boot do servidor por causa de uma limpeza
  // best-effort. Nunca sob teste: a suíte inteira roda contra um Prisma de
  // teste/sem podman — disparar aqui marcaria missões de teste como failed e
  // tentaria falar com um runtime de container que não existe (paridade com
  // o guard do tick, mais abaixo).
  if (process.env['NODE_ENV'] !== 'test') {
    void runBootReaper(app, undefined, bootAt).catch((err: unknown) =>
      app.log.error(err, '[Scheduler] ceifador de boot falhou inesperadamente')
    )
  }

  // Instanciado cedo: buildMissionRunner (W1.3.1) precisa dele para resolver o
  // motor VERSIONADO do ambiente do dono do projeto ao montar o stack local; a
  // faxina de ambientes expirados (mais abaixo) reusa a MESMA instância.
  const clientEnvironments = new ClientEnvironmentService(app.prisma)
  const localStack = buildRuntimeStack(
    app,
    buildMissionRunner(app, clientEnvironments),
    buildWorkspaceProvider(app)
  )
  const remoteStack = buildRemoteRuntimeStackIfConfigured(app)

  // Missão presa vira failed: cobre 'running' passado de STALE_RUNNING_MS e
  // 'pending' que nunca chegou a rodar (processo morto entre criar e iniciar).
  const failStuckMissions = async (): Promise<void> => {
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
    const pendingBefore = new Date(Date.now() - PENDING_TIMEOUT_MS)
    const stuck = await app.prisma.mission.updateMany({
      where: {
        OR: [
          { status: 'running', startedAt: { lt: staleBefore } },
          { status: 'pending', createdAt: { lt: pendingBefore } },
        ],
      },
      data: {
        status: 'failed',
        error: `Mission stuck: presa em running/pending além do limite sem concluir`,
        completedAt: new Date(),
      },
    })
    if (stuck.count > 0) {
      app.log.warn(`[Scheduler] ${stuck.count} missão(ões) travadas marcadas como failed`)
    }
  }

  // Serializa disparos no processo: elimina a corrida entre a checagem de
  // concorrência e a criação da missão (dois POST simultâneos criariam duas).
  let triggerChain: Promise<TriggerResult> = Promise.resolve({ triggered: false, reason: 'init' })

  // Dedup de "credencial expirada" (Tarefa 16): uma vez por dono+motor por
  // dia — ver deveAvisarDeNovo em credencial-do-motor.ts. Em memória do
  // processo, de propósito (não é coluna de banco): o pior caso é um aviso
  // extra logo após um restart do control-plane, nunca silêncio além de 24h
  // dentro do mesmo processo vivo.
  //
  // Achado (finding 3 da revisão da Tarefa 16, documentado honestamente, não
  // resolvido — decisão deliberada, não coluna de banco): este Map é POR
  // PROCESSO. Hoje a esteira roda como UM control-plane numa única VM, então
  // isto é o comportamento real: um aviso por dono+motor por dia. Se um dia
  // existirem N processos do control-plane ao mesmo tempo (ex.: deploy
  // blue-green sobrepondo dois processos, ou horizontal scaling), CADA
  // processo tem o seu próprio Map e decide "ainda não avisei hoje"
  // independentemente — o dono receberia até N avisos idênticos no mesmo
  // dia, não um só. Não é um bug funcional NESTE deployment (não é o que
  // está no ar), mas fica registrado aqui para quem for escalar horizontalmente
  // não redescobrir isto em produção: a dedup real multi-processo exigiria um
  // estado compartilhado (ex.: coluna em EngineConnection ou tabela própria),
  // fora do escopo desta tarefa.
  const avisosDeCredencialExpirada = new Map<string, number>()

  /**
   * A fila de acordadas de julgamento que o SM levanta a cada ciclo. A regra
   * (rodízio, `max` em vez de soma, devolução da vez recusada) vive em
   * fila-de-julgamento.ts, testada fora do relógio.
   */
  const filaDeJulgamento = criarFilaDeJulgamento()

  /**
   * A esteira não para entre um papel e o outro.
   *
   * Mesmo desenho da fila de julgamento, que já resolveu o problema gêmeo
   * entre o SM e o QA: quem termina enfileira o seguinte, e o relógio drena
   * com os tetos de sempre.
   */
  const passagemDeBastao = criarPassagemDeBastao()

  /**
   * O motor que morreu pedindo login descansa (D2 do dono, 20/08).
   *
   * Insistir num motor deslogado não produz nada: treze falhas assim queimaram
   * metade da cota de um dia, o failsafe travou, e a esteira ficou parada de
   * 17 a 20/08. A pausa se desfaz sozinha — por sucesso ou por tempo.
   */
  const motorEmPausa = criarRegistroDeMotorMorto()

  /**
   * Quem já provou não ter o que fazer descansa um pouco antes de ser acordado
   * de novo. A regra (o que fura o descanso, por quanto tempo, quando ele é
   * apagado) vive em descanso-apos-vazia.ts, testada fora do relógio.
   */
  const descansoAposVazia = criarRegistroDeDescanso(DESCANSO_APOS_VAZIA_MS)

  /**
   * Fecha a linha da vigília E encerra a conversa no fornecedor.
   *
   * Existe como ponto ÚNICO porque são cinco chamadores, e a lente de revisão
   * de hoje já me pegou três vezes no mesmo erro: acrescentar algo num caminho
   * do par e esquecer no irmão. Com um só ponto não há irmão para esquecer.
   */
  const fecharSessaoEArquivar = async (args: {
    sessionName: string
    motivo: MotivoDeFechamento
    agora: Date
  }): Promise<void> =>
    fecharSessao({
      prisma: app.prisma as unknown as PrismaDevSession,
      ...args,
      arquivarNoFornecedor: async (sessionName) =>
        arquivarSessaoJules({
          // A chave da conta em que a sessão NASCEU (BYOK, D34): com a chave
          // errada o arquivamento volta 404, a linha local fecha assim mesmo
          // (por desenho, para o registro não travar) e a vaga real fica presa
          // na conta do cliente sem nada para reconciliá-la depois.
          apiKey: await chaveDaSessao(sessionName),
          sessionName,
          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
        }),
      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
    })

  const runTrigger = async (
    role: F6AgentRole,
    projectId?: string,
    onboardingSequence?: F6AgentRole[],
    origem: OrigemDoDisparo = 'agenda'
  ): Promise<TriggerResult> => {
    await failStuckMissions()

    // Concorrência elástica: teto de missões ativas simultâneas na VM. Default 1
    // (comportamento atual); sobe via env quando a VM-MT-SaaS (32GB) entrar.
    const active = await app.prisma.mission.count({
      where: { status: { in: ['pending', 'running'] } },
    })
    if (active >= MAX_CONCURRENT_MISSIONS) {
      app.log.warn(
        `[Scheduler] Concorrência cheia (${active}/${MAX_CONCURRENT_MISSIONS}); pulando janela de ${role}`
      )
      return { triggered: false, reason: 'busy' }
    }

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    // Failsafe da instância (não por tenant): teto global de missões/dia para
    // proteger a VM inteira. O limite por tenant é o do plano (abaixo).
    // DUAS contagens e uma subtração, não um NOT sobre campo JSON: em SQL,
    // `NOT (result->>'falhaDeCredencial' = 'true')` avalia NULL para toda
    // missão com `result` nulo — que é a maioria — e NULL não é TRUE, então
    // o filtro as excluiria TODAS e o teto nunca seria atingido. Medido no
    // banco de produção antes de escolher: das 24 missões de 20/08, 13 têm
    // `result` nulo. `equals: true` só casa o que foi marcado de propósito,
    // e a subtração é imune ao problema.
    // O papel isento do bloqueio também não entra na contagem: quem o teto não
    // pode barrar não gasta o teto dos outros (ver teto-diario.ts). Excluir na
    // ORIGEM, e não por subtração, porque aqui não há o problema de NULL que
    // obriga as duas contagens abaixo — `type` é coluna, nunca campo JSON.
    const totalHoje = await app.prisma.mission.count({
      where: {
        createdAt: { gte: startOfDay },
        type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
      },
    })
    // Decisão do dono (20/08): uma missão que morreu pedindo login nem
    // chegou a usar o motor — cobrar dela uma das vagas do dia foi o que
    // transformou uma credencial vencida em três dias de esteira parada.
    const mortasPorCredencial = await app.prisma.mission.count({
      where: {
        createdAt: { gte: startOfDay },
        // MESMO filtro do total, e isto não é detalhe: sem ele a subtração
        // desconta missões que o total nunca somou. Medido em produção uma
        // hora depois de eu introduzir o furo: total sem o papel isento = 17,
        // vazias contadas SEM o filtro = 174 → 17 - 174 = -157. O teto do dia
        // simplesmente deixou de existir, em silêncio, e o log passaria a
        // imprimir número negativo.
        type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
        result: { path: ['falhaDeCredencial'], equals: true },
      },
    })
    // Mesma lógica, outra causa: a missão que acordou e não achou nada para
    // fazer devolve `noOp` e RETORNA ANTES de chamar o motor (medido: 12,1s
    // contra 25,4s de um julgamento real). Cobrar dela uma vaga do dia é
    // cobrar por trabalho que não houve — e foi o que estourou o teto em
    // 21/08, bloqueando ra, po e sm com "Failsafe da instância (220/24)"
    // enquanto o desejo #141 esperava alguém acordar.
    //
    // DUAS contagens e uma subtração, de novo pelo mesmo motivo explicado
    // acima: `NOT (result->>'noOp' = 'true')` avaliaria NULL para toda missão
    // sem `result`, e NULL não é TRUE — o filtro excluiria todas.
    const acordadasEmFalso = await app.prisma.mission.count({
      where: {
        createdAt: { gte: startOfDay },
        // Ver o comentário da contagem acima: subtrair de um total filtrado
        // exige o mesmo filtro dos dois lados.
        type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
        result: { path: ['noOp'], equals: true },
      },
    })
    const instanceToday = totalHoje - mortasPorCredencial - acordadasEmFalso
    // O julgamento NÃO é segurado por este teto (D25 do dono, 21/08/2026): ver
    // services/teto-diario.ts para o porquê e para o que continua valendo.
    // A missão do papel isento NÃO soma mais em `instanceToday`: quem o teto
    // não pode barrar não gasta o teto dos outros. As três contagens acima
    // usam o MESMO filtro de tipo, senão a subtração desconta o que o total
    // nunca somou.
    if (tetoDiarioBloqueia({ role, usadasHoje: instanceToday, teto: MAX_MISSIONS_PER_DAY })) {
      app.log.warn(
        `[Scheduler] Failsafe da instância atingido (${instanceToday}/${MAX_MISSIONS_PER_DAY}); pulando ${role}`
      )
      return { triggered: false, reason: 'instance-failsafe' }
    }

    const project = projectId
      ? await app.prisma.project.findFirst({
          where: { id: projectId, isActive: true },
          include: { user: { include: { plan: true } } },
        })
      : await app.prisma.project.findFirst({
          // Projeto suspenso por falta de acesso não entra na fila: sem este
          // filtro, o rodízio escolheria justamente ele e a instância ficaria
          // parada em cima de um projeto que não pode escrever em lugar nenhum.
          where: { isActive: true, accessSuspendedAt: null },
          // Fila prioritária: projetos de donos em planos mais altos (tierRank
          // maior) rodam antes. Empate → mais antigo primeiro (fairness).
          orderBy: [{ user: { plan: { tierRank: 'desc' } } }, { createdAt: 'asc' }],
          include: { user: { include: { plan: true } } },
        })
    if (!project) {
      app.log.warn('[Scheduler] No active project found to trigger mission')
      return { triggered: false, reason: 'no-project' }
    }

    // O ÚNICO ponto por onde uma missão nasce — e por isso é aqui que a
    // suspensão por perda de acesso segura o freio, valendo para o relógio e
    // para qualquer disparo sob demanda (rota admin, QA).
    //
    // O acesso era provado uma vez, no cadastro, e nunca mais: removido do
    // repositório depois, o dono continuava com o relógio escrevendo lá com a
    // credencial da INSTALAÇÃO, que continua legítima. Quem devolve o projeto
    // ao ar é a própria reconferência, sozinha, quando o acesso volta
    // (services/reconferencia-de-acesso.ts) — ninguém precisa mexer em nada.
    //
    // Não é reason "retentável" de propósito: repetir a janela a cada minuto
    // não muda nada enquanto o acesso não voltar.
    if (projetoEstaSuspensoPorAcesso(project)) {
      app.log.warn(
        { projectId: project.id, motivo: project.accessSuspendedReason },
        '[Scheduler] projeto suspenso por falta de acesso ao repositório; nenhuma missão é disparada'
      )
      return { triggered: false, reason: 'acesso-suspenso' }
    }

    // Descanso depois de uma acordada vazia. Vem DEPOIS de o projeto ser
    // escolhido (o descanso é por projeto E papel) e ANTES de qualquer
    // trabalho caro — contêiner, quota, criação da missão.
    //
    // Nunca é um pulo mudo: o log diz o motivo e até quando. Alto na primeira
    // vez, baixo nas repetições — o relógio consulta a cada minuto, e repetir
    // o mesmo aviso sessenta vezes por hora apagaria o sinal tanto quanto o
    // silêncio.
    const descanso = descansoAposVazia.consultar({ projectId: project.id, role, origem })
    if (descanso.pular) {
      const mensagem =
        `[Scheduler] ${role} de ${project.wingId} em descanso até ` +
        `${descanso.ate?.toISOString()} (a última acordada voltou vazia, origem '${origem}'); ` +
        'aviso do GitHub e fila do SM continuam furando o descanso'
      if (descanso.primeiraVez) app.log.info(mensagem)
      else app.log.debug(mensagem)
      return { triggered: false, reason: 'descanso' }
    }

    // Orçamento do plano: total de missões do dia somando TODOS os projetos do
    // dono (o limite do plano é por usuário, não por projeto).
    const plan = project.user?.plan
    // Mesma regra do failsafe acima, e pelo mesmo motivo: a vaga que o cliente
    // paga não pode ser o que impede a entrega dele de ser julgada e mesclada.
    if (project.userId && plan && tetoDiarioSeguraOPapel(role)) {
      // Mesmo furo do failsafe da instância, e aqui é pior: esta é a vaga
      // que o CLIENTE paga. Cobrar do plano dele uma missão que morreu
      // pedindo login — sem nunca ter usado o motor — é cobrar por trabalho
      // que não aconteceu. Mesma técnica: duas contagens e subtração, nunca
      // um NOT sobre campo JSON (que excluiria toda missão com `result`
      // nulo, ou seja, quase todas).
      // A MESMA regra do failsafe da instância, pelo mesmo motivo — e aqui
      // doeria mais, porque a vaga é paga: o papel isento do bloqueio não
      // entra na contagem. Contar quem não pode ser barrado transfere o custo
      // para quem pode, e foi assim que em 21/08 um dia de 220 julgamentos
      // consumiu o plano inteiro do dono e travou o analista.
      const ownerTotalHoje = await app.prisma.mission.count({
        where: {
          createdAt: { gte: startOfDay },
          project: { userId: project.userId },
          type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
        },
      })
      const ownerMortasPorCredencial = await app.prisma.mission.count({
        where: {
          createdAt: { gte: startOfDay },
          project: { userId: project.userId },
          // Mesmo filtro do total do dono, pelo mesmo motivo da instância.
          type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
          result: { path: ['falhaDeCredencial'], equals: true },
        },
      })
      // Acordada em falso também não é cobrada do cliente: ela retorna antes
      // de chamar o motor, então não gastou nada do que ele paga.
      const ownerAcordadasEmFalso = await app.prisma.mission.count({
        where: {
          createdAt: { gte: startOfDay },
          project: { userId: project.userId },
          type: { not: TIPO_DE_MISSAO_ISENTO_DO_TETO },
          result: { path: ['noOp'], equals: true },
        },
      })
      const ownerToday = ownerTotalHoje - ownerMortasPorCredencial - ownerAcordadasEmFalso
      if (ownerToday >= plan.maxMissionsPerDay) {
        app.log.warn(
          `[Scheduler] Orçamento do plano ${plan.id} atingido para o usuário ${project.userId} (${ownerToday}/${plan.maxMissionsPerDay}); pulando`
        )
        return { triggered: false, reason: 'plan-budget' }
      }
    }

    // Cadeia de motores escolhida pela config do projeto (por agente), com queda
    // para o padrão da instância. Nada de motor hardcoded; a cadeia é a base do
    // failover (tenta o próximo motor do cliente se o primeiro esgotar cota/errar).
    // Os motores que o cliente TEM conectados entram como última reserva.
    //
    // Sem isto, um projeto que escolheu um motor só fica sem para onde ir no
    // dia em que ele estoura a cota — medido ao vivo em 26/08: "Individual
    // quota reached... Resets in 18h43m26s", e os quatro papéis parados por
    // dezoito horas com outro motor conectado e ocioso ao lado.
    //
    // Best-effort: se a leitura falhar, a cadeia sai como antes em vez de a
    // missão não sair.
    let motoresConectados: string[] = []
    if (project.userId) {
      try {
        const linhas = await app.prisma.engineConnection.findMany({
          where: { userId: project.userId, status: 'connected' },
          select: { runtime: true, status: true, lastValidatedAt: true },
        })
        // Só quem PROVOU estar vivo entra como reserva.
        //
        // O banco dizer 'connected' não basta: é a terceira vez que o projeto
        // tropeça aqui. Medido hoje — a linha do antigravity dizia 'connected'
        // com a última prova de vida de 06/08, vinte dias antes. Foi essa
        // mentira que fez o produto trocar um motor morto por outro igualmente
        // morto e gastar treze tentativas que não podiam dar certo.
        motoresConectados = motoresComProvaDeVida(linhas, new Date()).map((l) => l.runtime)
      } catch (err) {
        // Best-effort de verdade: `try` e não `.catch()` da promessa, porque a
        // leitura pode falhar ANTES de virar promessa. Sem reserva a cadeia
        // sai como antes — pior que ter reserva, melhor que a missão não sair.
        app.log.warn(err, '[Scheduler] não deu para ler os motores conectados; cadeia sem reserva')
      }
    }
    const chain = resolveRuntimeChain(
      role,
      project.runtimeConfig,
      RESOLVER_DEFAULTS,
      motoresConectados
    )
    const primary = chain[0] as { runtime: string; model?: string }

    // Controle de gasto (BYOK): a missão roda no LLM do cliente. Antes de
    // disparar, checa a quota do motor primário e o orçamento de tokens do
    // plano. Quota crítica bloqueia (protege a conta do cliente de estourar);
    // quota baixa só alerta. Ver spend-guard.ts.
    // Fotografa a quota ANTES da missão (medição de consumo por diferença).
    let quotaBefore: number | null = null
    if (project.userId && plan) {
      const conn = await app.prisma.engineConnection.findFirst({
        where: { userId: project.userId, runtime: primary.runtime, status: 'connected' },
        select: { quotaRemaining: true, quotaTotal: true },
      })
      quotaBefore = conn?.quotaRemaining ?? null
      const features = (plan.features ?? {}) as Record<string, unknown>
      const tokenBudget =
        typeof features['maxTokensPerMonth'] === 'number'
          ? (features['maxTokensPerMonth'] as number)
          : null
      let tokensSpent = 0
      if (tokenBudget) {
        const startOfMonth = new Date()
        startOfMonth.setDate(1)
        startOfMonth.setHours(0, 0, 0, 0)
        const agg = await app.prisma.mission.aggregate({
          where: { createdAt: { gte: startOfMonth }, project: { userId: project.userId } },
          _sum: { tokensUsed: true },
        })
        tokensSpent = agg._sum.tokensUsed ?? 0
      }
      const decision = canRunMission({
        quotaRemaining: conn?.quotaRemaining ?? null,
        quotaTotal: conn?.quotaTotal ?? null,
        tokensSpent,
        tokenBudget,
      })
      if (shouldAlertForQuota(decision.health)) {
        app.log.warn(
          `[Scheduler] Quota ${decision.health} no motor ${primary.runtime} do usuário ${project.userId}`
        )
      }
      if (!decision.ok) {
        app.log.warn(
          `[Scheduler] Gasto bloqueado (${decision.reason}) para ${project.userId}; pulando ${role}`
        )
        return { triggered: false, reason: decision.reason ?? 'spend-blocked' }
      }
    }

    // Criação atômica já em 'running': fecha a janela de corrida do guard e
    // garante que a missão sempre tem startedAt (varredura de stale a alcança).
    const mission = await app.prisma.mission.create({
      data: {
        projectId: project.id,
        type: `agent-run-${role}`,
        status: 'running',
        startedAt: new Date(),
        quotaBefore,
        payload: {
          role,
          // A origem REAL, não mais 'scheduler' para todo mundo: enquanto o
          // relógio, o aviso do GitHub e a vigília se registravam com o mesmo
          // nome, era impossível medir no banco quem estava gerando a rajada
          // de acordadas vazias — foi preciso deduzir pela cadência.
          triggeredBy: onboardingSequence !== undefined ? 'onboarding' : origem,
          ...(onboardingSequence !== undefined ? { onboardingSequence } : {}),
          runtime: primary.runtime,
          model: primary.model ?? MODEL_BY_ROLE[role],
        },
      },
    })

    app.log.info(
      `[Scheduler] Mission created in DB: ${mission.id} for role ${role} (chain=${chain
        .map((c) => c.runtime)
        .join('>')})`
    )

    // Executa em background com failover; o disparo retorna assim que registrada.
    void executeMissionWithFailover(
      mission.id,
      project,
      role,
      chain,
      plan?.id,
      onboardingSequence !== undefined,
      origem
    )

    return { triggered: true, missionId: mission.id }
  }

  type ChainProject = {
    id: string
    wingId: string
    name: string
    userId: string | null
    runtimeConfig?: unknown
    devPlan?: string | null
    /** BYOK: a impressão digital da conta do dev assíncrono deste cliente. */
    devAccountId?: string | null
    /**
     * Até onde o GitOrch pode ir no repositório DESTE cliente. Precisa viajar
     * junto com o projeto por toda a cadeia: é o que a guarda lê na hora de
     * cada escrita. Opcional porque projeto legado tem nulo — e nulo cai no
     * nível mais restrito, que é o lado seguro.
     */
    autonomia?: string | null
  }

  // Tenta a cadeia de motores em ordem; sucesso encerra; erro de cota/auth cai
  // para o próximo; erro real encerra em failed. Nunca mascara: o estado final
  // é sempre gravado (completed com o motor que deu certo, ou failed com o erro).
  const executeMissionWithFailover = async (
    missionId: string,
    project: ChainProject,
    role: F6AgentRole,
    chainOriginal: Array<{ runtime: string; model?: string }>,
    planId?: string,
    // A cascata de onboarding (Task 10) é hoje o ÚNICO caminho que acorda o
    // QA — o projeto não tem agenda de QA própria em project_schedules. Sem
    // este sinal, o QA nos trilhos sempre cairia no julgamento clássico de PR
    // e, sem PR aberta, terminaria em no-op (ver qa-rails-mission.ts).
    isOnboarding = false,
    /**
     * De onde veio o disparo. O RA usa para separar os dois trabalhos dele:
     * pelo aviso de desejo novo ele analisa AQUELE desejo; pela agenda ele
     * explora o projeto.
     */
    origem: OrigemDoDisparo = 'agenda'
  ): Promise<void> => {
    // Isolamento por tier: grátis roda no stack remoto (MT-SaaS) quando
    // configurado; qualquer outro caso usa o stack local de sempre — nunca
    // corre o risco de rotear uma missão paga para fora da nossa VM.
    const activeStack = selectRuntimeStack(planId, localStack, remoteStack)
    let lastError = 'nenhum motor executou'
    // Marca durável de "morreu pedindo login": CredencialExpiradaError só
    // existe em tempo de execução e some quando a missão vira linha no banco.
    // Sem isto, o teto diário não teria como distinguir uma missão que fez
    // trabalho e falhou de uma que nem chegou a usar o motor.
    let falhaDeCredencial = false
    // Tira da cadeia o motor que morreu pedindo login. Ele volta sozinho — por
    // sucesso ou por tempo — e a cadeia inteira em pausa passa mesmo assim,
    // porque ficar sem motor nenhum seria trocar desperdício por paralisação.
    const cadeiaComMotorVivo = motorEmPausa.filtrarCadeia(chainOriginal, new Date())
    if (cadeiaComMotorVivo.length < chainOriginal.length) {
      app.log.info(
        `[Scheduler] ${chainOriginal.length - cadeiaComMotorVivo.length} motor(es) fora do rodízio por credencial morta`
      )
    }

    // O SEGUNDO filtro da cadeia, e o que faltava: o MODELO de cada degrau
    // conferido contra o catálogo vivo daquele motor, ANTES de gastar container
    // nenhum. É aqui que os dois trilhos se encontram — a coleta gravava o
    // catálogo em `engine_connections.models` só para desenhar a tela, e a
    // escolha do modelo vinha de um literal no código. Em 31/08 o provedor
    // removeu a geração Gemini 3.5 no meio do dia: o banco soube na hora, a
    // missão continuou pedindo o modelo morto, e 24 delas morreram em 9h48
    // pagando um `podman run` inteiro cada uma para receber `invalid model
    // selection` — com outro motor conectado e ocioso ao lado.
    //
    // A conferência é feita para a cadeia INTEIRA de uma vez (leituras
    // indexadas, uma por motor) porque a decisão é sobre quais degraus existem,
    // não sobre o degrau da vez.
    const degrausConferidos = await Promise.all(
      cadeiaComMotorVivo.map(async (sel) => ({
        runtime: sel.runtime,
        ...(await modeloVivoParaAMissao({
          prisma: app.prisma,
          ownerUserId: project.userId,
          runtime: sel.runtime,
          desejado: sel.model ?? MODEL_BY_ROLE[role],
          log: app.log,
        })),
      }))
    )
    const { degraus: chain, pulados } = degrausQueValemATentativa(degrausConferidos)
    if (pulados.length > 0) {
      lastError =
        `modelo fora do catálogo vivo em ${pulados.length} motor(es) — ` +
        `${pulados.map((d) => d.runtime).join(', ')} não foram tentados`
      app.log.warn(`[Scheduler] ${lastError}`)
    }
    // Nenhum degrau com modelo vivo: o último é tentado assim mesmo. Ver
    // `degrausQueValemATentativa` — parar a esteira por um catálogo que
    // ninguém conferiu seria trocar desperdício por paralisação.
    if (chain.length === 1 && chain[0]?.valeATentativa === false) {
      app.log.warn(
        `[Scheduler] nenhum motor da cadeia tem o modelo pedido no catálogo; tentando ${chain[0]?.runtime} assim mesmo para não parar a esteira`
      )
    }

    for (let i = 0; i < chain.length; i++) {
      const sel = chain[i] as { runtime: string; modelo: string | undefined }
      // `undefined` aqui é decisão, não ausência: quer dizer "rode sem
      // `--model`", com o modelo padrão do próprio motor. É o que salva o
      // degrau do claude, que recebe do resolvedor um nome de modelo do
      // Antigravity — provado ao vivo em 01/09: `claude --model "Gemini 3.7
      // Flash (Medium)"` responde "There's an issue with the selected model".
      const model = sel.modelo
      const isLast = i === chain.length - 1

      // Reinicia o relógio de "presa" a cada tentativa: o limite de stale é por
      // tentativa (igual ao timeoutMs), não pela soma da cadeia. Sem isto, a
      // varredura de stale marcaria a missão failed no meio do failover e um
      // sucesso posterior seria descartado (write condicional em status running).
      await app.prisma.mission
        .updateMany({
          where: { id: missionId, status: 'running' },
          data: { startedAt: new Date() },
        })
        .catch(() => undefined)

      try {
        const credentialRef = {
          connectionId: `conn-${role}-${missionId}-${sel.runtime}`,
          ownerScope: 'project' as const,
          runtime: sel.runtime as F6AgentRuntime,
          providedSecrets: [],
          ...(project.userId ? { ownerUserId: project.userId } : {}),
        }

        // Lei "LLM decide, sistema executa": PO e QA rodam nos TRILHOS quando o
        // token do GitHub (e, para o PO, o board) estão configurados. O token é a
        // identidade própria do gitorch — um installation token do seu GitHub App,
        // emitido sob demanda e cacheado ~1h. Um GITORCH_GITHUB_TOKEN explícito, se
        // definido, tem prioridade (override). Sem App/token, cai no caminho
        // clássico com log honesto.
        //
        // Board (Task 9): o PRÓPRIO board do projeto (gravado em
        // Project.runtimeConfig.envConfig.GITORCH_PROJECT_BOARD por
        // provisionSetupMission) é a ÚNICA fonte aceita.
        //
        // Achado crítico da revisão pós-merge: NUNCA cair no board global de
        // outro projeto (env `GITORCH_PROJECT_BOARD`) — esse env aponta para
        // o board pessoal de OUTRO projeto do dono, e `ensureProjectBoard`
        // pode falhar em silêncio; sem essa trava, issues/cards de um
        // projeto vazavam pro board alheio, exatamente o vazamento
        // multi-tenant que esta task dizia matar. Sem board PRÓPRIO, os
        // trilhos do PO ficam desligados para o projeto (log honesto abaixo)
        // — o roadmap ainda sai na memória, só o quadro que falta.
        // O quadro era tentado UMA vez, no registro do projeto. Se naquele
        // instante o App ainda não estava instalado no dono do repositório, a
        // criação falhava e o projeto ficava sem quadro para sempre — e sem
        // quadro o PO nunca cria issue, mesmo depois de instalar o App. Aqui
        // a esteira se recupera sozinha: o PO tenta garantir o quadro toda vez
        // que acorda, sem exigir um novo registro do projeto.
        let railsBoard = resolveRailsBoard(project)
        if (role === 'po' && !railsBoard) {
          // Conta pessoal: a credencial do App não cria quadro ali (medido na
          // API real). Havendo a credencial do próprio cliente guardada, ela
          // é a segunda tentativa — ensureProjectBoard só recorre a ela se a
          // primeira, com a identidade do produto, falhar. A leitura vai como
          // FUNÇÃO (não já resolvida aqui fora): passa por banco + decifragem,
          // e as duas podem lançar (chave rotacionada, banco fora do ar) — se
          // isso acontecesse aqui fora, sem proteção, a exceção cairia direto
          // no try do failover de motores e derrubaria o wake inteiro do PO
          // por causa de um reforço que é opcional. `ensureAndPersistProjectBoard`
          // é quem chama e engole essa falha.
          railsBoard = await ensureAndPersistProjectBoard({
            project: {
              id: project.id,
              wingId: project.wingId,
              runtimeConfig: project.runtimeConfig,
            },
            prisma: app.prisma as never,
            mintInstallationToken,
            // IMPORTANTE (leva D): as duas fábricas abaixo caíam em `new
            // ProjectV2Client({ token })` sem `fetchImpl` nenhum — achado
            // nesta auditoria além da lista do despacho, mesma classe de
            // defeito, mesmo caminho (`runTrigger` → `tick()`, sob
            // `tickEmAndamento`, wake do PO tentando garantir o board).
            createProjectV2Client: (token: string) =>
              new ProjectV2Client({ token, fetchImpl: fetchDoQuadro(project) }),
            resolveOwner: resolveGithubOwnerId,
            resolveRepositoryId: resolveGithubRepositoryId,
            lerClientToken: () =>
              lerCredencialDoProjeto({ prisma: app.prisma as never, projectId: project.id }),
            criarClienteAlternativo: (token: string) =>
              new ProjectV2Client({ token, fetchImpl: fetchDoQuadro(project) }),
            onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
          })
          if (railsBoard) {
            app.log.info(
              `[Scheduler] Quadro do projeto ${project.wingId} criado no wake do PO: ${railsBoard}`
            )
          } else {
            app.log.warn(
              `[Scheduler] PO sem board próprio para ${project.wingId}; trilhos do PO desligados (nunca cai no board global de outro projeto)`
            )
          }
        }
        const railsToken =
          process.env['GITORCH_GITHUB_TOKEN'] ??
          (await mintInstallationToken({
            // Sem o repositório, o App emitia o token da PRIMEIRA instalação
            // da lista — a de outra conta — e toda escrita no repositório do
            // projeto voltava 403.
            repository: project.wingId,
            onError: (m) => app.log.error(m),
            onWarn: (m) => app.log.warn(m),
          })) ??
          undefined
        // O quadro deixou de ser condição para o PO agir. Ele é a vitrine do
        // plano, não o plano: sem quadro, as issues, a árvore entre elas e os
        // marcos continuam sendo criados — e é isso que o cliente precisa
        // receber. Enquanto os dois estiveram amarrados, todo repositório de
        // conta pessoal (onde a credencial do produto não consegue criar nem
        // sequer enxergar quadro) ficava sem backlog nenhum, em silêncio.
        const poRails = role === 'po' && Boolean(railsToken)
        const qaRails = role === 'qa' && Boolean(railsToken)
        const smRails = role === 'sm' && Boolean(railsToken)
        // RA não age no GitHub: os trilhos dele (áreas→jornadas→brief) só
        // precisam do motor — sempre disponíveis.
        const raRails = role === 'ra'
        let result: { exitCode: number; output: string; stderr: string; noOp?: boolean }

        if (smRails) {
          // SM é o dono da esteira, 100% determinístico (sem passo de LLM):
          // (1) delega tasks prontas e desbloqueadas; (2) a cobrança do dev
          // assíncrono NÃO é mais por re-label — é a linha da sessão
          // (dev-session-store) que a vigia (`varrerSessoesDoDev` /
          // `vigiarSessoes`) examina a cada tick. A vigia mantém só
          // escalonamento (aciona o SM para investigar falha/estagnação) e
          // aviso ao dono (Telegram), com teto para não virar spam.
          const delegation = await runSmDelegation({
            repository: project.wingId,
            githubToken: railsToken as string,
            // O NÍVEL DESTE PROJETO, e sem isto a esteira para.
            //
            // Medido em produção em 30/08: o Scrum Master saiu de 82 missões
            // concluídas e zero falhas (29/08) para 5 falhas e nenhuma entrega,
            // todas com "EscritaNaoAutorizadaError: Não posso organizar o
            // quadro". Os dois projetos estavam em `cuidar` — a guarda não
            // estava obedecendo ao cliente, estava barrando o produto.
            //
            // A causa é o próprio acerto do bloco 4 visto pelo avesso: o
            // default `?? fetchSemPermissao()` faz quem esquece falhar FECHADO,
            // e aqui ninguém tinha passado o fetch. O fail-closed funcionou
            // exatamente como projetado; o que faltou foi entregar o nível a
            // quem precisa dele. `fetchDoQuadro` já existia e já era usado pelo
            // PO poucas linhas acima — o SM só não tinha recebido.
            fetchImpl: fetchDoQuadro(project),
            // Delegar de verdade: além do label, abrir a sessão de trabalho no
            // dev assíncrono. Sem chave configurada, `criarSessaoJules`
            // devolve null e o label continua sendo o plano B.
            // Quando o dev RECUSA a delegação, a issue fica sem etiqueta e o
            // dono precisa saber: uma tarefa parada na fila sem ninguém nela é
            // notícia de negócio, não de infraestrutura. O canal é o mesmo do
            // resto do projeto — sem vínculo, ninguém é avisado, e o projeto
            // de um cliente nunca vira mensagem no chat de outro.
            avisarDono: async (texto) => {
              await avisarDonoDoProjeto(project, texto)
            },
            // Sessão que nasceu lá fora e não pôde ser registrada aqui é
            // desfeita na hora: sem linha, ninguém a acompanha, e deixá-la de
            // pé só trocaria uma delegação perdida por uma vaga presa.
            desfazerSessao: async (sessionName) => {
              await arquivarSessaoJules({
                // A mesma conta que abriu a sessão precisa ser a que a desfaz:
                // com a chave errada o desfazer volta 404 e a vaga fica presa
                // na conta do cliente até a vigília expirar.
                apiKey: (await chaveDoDevDoProjeto(project.id)) ?? undefined,
                sessionName,
                onWarn: (m) => app.log.warn(m),
              })
            },
            criarSessaoDev: async ({ repository, titulo, prompt }) =>
              criarSessaoJules({
                // BYOK (D34): a conta DO CLIENTE quando ele trouxe a dele.
                apiKey: (await chaveDoDevDoProjeto(project.id)) ?? undefined,
                repository,
                startingBranch: process.env['GITORCH_DEV_BASE_BRANCH'] ?? 'main',
                titulo,
                prompt,
                onWarn: (m) => app.log.warn(m),
              }),
            // Guardar a ligação é o que permite julgar o PR depois: ele chega
            // com o autor da conta da instalação e sem palavra de ligação no
            // corpo, então o GitHub sozinho não conta de quem é o trabalho.
            //
            // `abrirSessao` devolve resultado tipado (nunca lança em cima de
            // colisão esperada); `ok: false` aqui significa que já existe
            // sessão viva para esta issue (índice único parcial
            // `dev_sessions_open_per_issue`) — a sessão nova nasceu no
            // serviço externo mas a ligação não pôde ser guardada. Lançamos
            // para que o try/catch de `runSmDelegation` (sm-delegation.ts)
            // registre o aviso do jeito de sempre, sem derrubar as outras
            // delegações do ciclo.
            // A RESERVA, antes de gastar cota. O índice único parcial do
            // banco (uma issue, uma sessão viva) é quem decide o vencedor —
            // por isso a reserva é uma linha de verdade, com um nome
            // provisório, e não uma marca à parte que duas instâncias
            // poderiam gravar ao mesmo tempo.
            reservarLugarDaIssue: async (issueNumber) => {
              const r = await abrirSessao({
                prisma: app.prisma as unknown as PrismaDevSession,
                projectId: project.id,
                issueNumber,
                sessionName: nomeDaReserva(project.id, issueNumber),
                agora: new Date(),
              })
              return r.ok
            },
            // Devolve o lugar quando o dev externo recusa: sem isto a issue
            // ficaria presa para sempre num dono que não existe.
            liberarLugarDaIssue: async (issueNumber) => {
              await app.prisma.devSession.updateMany({
                where: {
                  projectId: project.id,
                  issueNumber,
                  sessionName: { startsWith: PREFIXO_DA_RESERVA },
                  closedAt: null,
                },
                data: { closedAt: new Date(), closedReason: 'failed_final' },
              })
            },
            aoCriarSessao: async ({ issueNumber, sessionName }) => {
              // A reserva já ganhou o lugar: aqui só se troca o nome
              // provisório pelo nome real da sessão do dev externo.
              const trocou = await app.prisma.devSession.updateMany({
                where: {
                  projectId: project.id,
                  issueNumber,
                  sessionName: { startsWith: PREFIXO_DA_RESERVA },
                  closedAt: null,
                },
                data: { sessionName },
              })
              if (trocou.count > 0) return
              const resultado = await abrirSessao({
                prisma: app.prisma as unknown as PrismaDevSession,
                projectId: project.id,
                issueNumber,
                sessionName,
                agora: new Date(),
              })
              if (!resultado.ok) {
                throw new Error(
                  `já existe sessão viva para a issue #${issueNumber} (${resultado.motivo}); ` +
                    `a ligação com "${sessionName}" não foi guardada`
                )
              }
            },
            // A fila real e os tetos do plano são montados pela função pura
            // exportada `montarOpcoesDeDelegacao` (topo do arquivo) — só as
            // leituras (Prisma) ficam aqui, dentro da closure não exportada.
            ...montarOpcoesDeDelegacao({
              devPlan: project.devPlan,
              // A fila real: issue com linha viva já está sendo trabalhada;
              // sem linha viva está por delegar, mesmo que já tenha sido
              // delegada antes e a sessão tenha morrido (fila-de-delegacao.ts).
              // A fila REAL deste projeto — é ela que diz quais issues já
              // estão em trabalho aqui.
              sessoesVivas: await sessoesVivas({
                prisma: app.prisma as unknown as PrismaDevSession,
                projectId: project.id,
              }),
              // Mas o TETO é da CONTA, não do projeto: no Pro são 100 sessões
              // em 24h e 15 ao mesmo tempo divididas entre TODOS os
              // repositórios daquela conta. Contando por projeto, dois
              // projetos "pro" se achavam com 200/dia e 30 simultâneas contra
              // um teto real de 100 e 15 — e foi isso que produziu mais de cem
              // delegações recusadas num único dia.
              //
              delegadasHoje: await app.prisma.devSession.count({
                where: {
                  // Pela CONTA QUE ABRIU cada sessão, não pelos projetos que
                  // hoje dividem a conta: um projeto que acabou de conectar a
                  // conta própria carrega as sessões que abriu na conta do
                  // dono, e contá-las faria o teto novo do cliente nascer
                  // consumido por trabalho que nunca tocou a conta dele — e,
                  // na desconexão, faria essas sessões roubarem vaga de todo
                  // mundo que divide a conta da instância.
                  devAccountId: project.devAccountId ?? null,
                  createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                },
              }),
              // Vivas da CONTA inteira, pelo mesmo motivo. São dois contadores
              // diferentes: a vaga libera quando a sessão termina; a cota de
              // 24h só devolve cada sessão 24h depois de ela ter começado.
              vivasNaConta: await app.prisma.devSession.count({
                where: { devAccountId: project.devAccountId ?? null, closedAt: null },
              }),
              // O que de fato OCUPA uma das 15 vagas simultâneas: só os estados
              // que o Jules ainda está tocando. Uma linha aberta em COMPLETED/
              // FAILED já devolveu a vaga no fornecedor — contá-la contra o teto
              // parou a esteira dos dois projetos em 29/08 (`ESTADOS_TERMINAIS`
              // em estados-de-sessao.ts). `notIn` cobre o fail-closed: estado
              // desconhecido conta como ocupando.
              ocupamVagaNaConta: await app.prisma.devSession.count({
                where: {
                  devAccountId: project.devAccountId ?? null,
                  closedAt: null,
                  state: { notIn: [...ESTADOS_TERMINAIS] },
                },
              }),
              // Sem filtro de linha viva de propósito: a entrega mesclada
              // costuma ter a linha JÁ FECHADA, e é ela que precisa barrar a
              // redelegação. Só as que têm commit de merge interessam.
              // Só as entregas RECENTES, e com teto. Varrer o histórico
              // inteiro a cada acordada do SM cresceria sem limite num projeto
              // de operação longa — e não serve para nada: entrega antiga não
              // barra redelegação, justamente para a issue reaberta poder
              // voltar.
              entregasDoProjeto: (await app.prisma.devSession.findMany({
                where: {
                  projectId: project.id,
                  mergeCommitSha: { not: null },
                  updatedAt: { gte: new Date(Date.now() - JANELA_DA_ENTREGA_RECENTE_MS) },
                },
                select: { issueNumber: true, mergeCommitSha: true, updatedAt: true },
                orderBy: { updatedAt: 'desc' },
                take: 200,
              })) as Array<{
                issueNumber: number
                mergeCommitSha: string | null
                updatedAt: Date
              }>,
            }),
            // ESTEIRA-T12: as linhas deste projeto que carregam um PR — vivas
            // ou já fechadas. É a prova de que um PR aberto é trabalho
            // delegado; sem ela, Dependabot e PR de humano entravam na fila do
            // julgamento e no log ("SM queued #337, #338"), escondendo o estado
            // real. Sem janela de tempo de propósito: um PR do dev pode ficar
            // aberto por semanas e ainda precisa ser reconhecido. `take` é só
            // um backstop defensivo (não uma janela funcional) — alto o
            // bastante para que nenhum projeto real acumule tantas sessões
            // com PR mais recentes que uma entrega antiga ainda aberta.
            sessoesParaReconhecerPr: (await app.prisma.devSession.findMany({
              where: { projectId: project.id, pullRequestNumber: { not: null } },
              orderBy: { updatedAt: 'desc' },
              take: 3000,
            })) as unknown as LinhaDeSessao[],
            // D51: issues que falharam 2× esperam a análise antes da 3ª —
            // não são redelegadas até o RA entender o porquê. E, para as que
            // já têm a análise feita, o pedido revisado vai no topo do prompt.
            issuesComAnalisePendente: await issuesComAnalisePendente({
              prisma: app.prisma as unknown as PrismaDevSession,
              projectId: project.id,
            }),
            aprendizadoPorIssue: await (async () => {
              const mapa = new Map<number, string>()
              try {
                const aprendizados = await lerAprendizados({
                  prisma: app.prisma as unknown as PrismaEventoDoJules,
                  projectId: project.id,
                  onWarn: (m) => app.log.warn(m),
                })
                for (const a of aprendizados) {
                  if (a.issueNumber && a.pedidoRevisado) mapa.set(a.issueNumber, a.pedidoRevisado)
                }
              } catch (err) {
                app.log.warn(err, '[Scheduler] não deu para ler os aprendizados do Jules')
              }
              return mapa
            })(),
            // ESTEIRA-T9: issue de incidente de infra que já tem um PR aberto
            // cobrindo a causa (`infra_incidents.pr_number`) não vira sessão
            // nova — um incidente = uma issue = UM PR.
            ...(await (async () => {
              const mapa = new Map<number, number>()
              const escaladas: number[] = []
              try {
                const rows = (await app.prisma.infraIncident.findMany({
                  where: {
                    projectId: project.id,
                    clearedAt: null,
                    OR: [{ prNumber: { not: null } }, { escalatedAt: { not: null } }],
                  },
                  select: { issueNumber: true, prNumber: true, escalatedAt: true },
                })) as Array<{
                  issueNumber: number | null
                  prNumber: number | null
                  escalatedAt: Date | null
                }>
                for (const r of rows) {
                  if (r.issueNumber === null) continue
                  if (r.escalatedAt !== null) escaladas.push(r.issueNumber)
                  else if (r.prNumber !== null) mapa.set(r.issueNumber, r.prNumber)
                }
              } catch (err) {
                app.log.warn(err, '[Scheduler] não deu para ler os incidentes com PR/escalada')
              }
              return { issuesComPrDeIncidente: mapa, issuesDeIncidenteEscalado: escaladas }
            })()),
            comentarCoberturaDeIncidente: async ({ issueNumber, prNumber }) => {
              const marcador = '<!-- gitorch:incidente-coberto-por-pr -->'
              const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
                const resp = await ghComGuarda(`https://api.github.com${path}`, {
                  method,
                  headers: {
                    authorization: `token ${railsToken as string}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'gitorch',
                    ...(body ? { 'content-type': 'application/json' } : {}),
                  },
                  ...(body ? { body: JSON.stringify(body) } : {}),
                })
                if (!resp.ok) throw new Error(`GitHub ${method} ${path} → ${resp.status}`)
                return resp.json().catch(() => ({}))
              }
              const existentes = (await gh(
                'GET',
                `/repos/${project.wingId}/issues/${issueNumber}/comments?per_page=100`
              )) as Array<{ body?: string }>
              if (
                (Array.isArray(existentes) ? existentes : []).some((c) =>
                  (c.body ?? '').includes(marcador)
                )
              ) {
                return
              }
              await gh('POST', `/repos/${project.wingId}/issues/${issueNumber}/comments`, {
                body: `${marcador}\nCoberto pelo PR #${prNumber} — o GitOrch não abre uma segunda sessão para o mesmo incidente de infra.`,
              })
            },
            // O SM é o orquestrador do julgamento (docs/agents/quality-assurance.md
            // §3.1). Até aqui o julgamento só era acordado por aviso do
            // GitHub ou pela vigília de uma sessão viva — uma entrega cuja
            // verificação terminou dias atrás e cuja sessão já encerrou não
            // tinha quem chamasse o QA (o #97, parado desde 15/08 com a
            // verificação verde). Enfileira; quem dispara é o tique
            // (`drenarFilaDeJulgamento`), um por minuto.
            pedirJulgamento: (prsSemParecer) => {
              filaDeJulgamento.enfileirar(project.id, prsSemParecer.length)
              app.log.info(
                `[Scheduler] SM enfileirou julgamento de ${prsSemParecer.length} entrega(s) sem ` +
                  `parecer em ${project.wingId}: ${prsSemParecer.map((n) => `#${n}`).join(', ')} ` +
                  `(fila do projeto: ${filaDeJulgamento.pendentes(project.id)})`
              )
            },
            // I4 (revisão final): antes hardcoded em `console.warn` dentro de
            // `sm-delegation.ts`, invisível no logger estruturado — mesmo
            // padrão já aplicado em `runQaMissionViaRails` (commit 5477a3e).
            onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
          })
          // O aviso é do DONO do projeto — a task travada é a dele. Antes, o
          // chat vinha direto do env (GITORCH_TELEGRAM_CHAT_ID): TODO cliente
          // "notificado" caía no chat da gitorch e o cliente, que informara o
          // Telegram dele no wizard, nunca recebia nada. Agora o chat sai do
          // vínculo real (telegram_links, nascido do /start do próprio cliente);
          // o nosso chat só entra quando o projeto é NOSSO — aí é notificação
          // interna de verdade. Sem vínculo, ninguém é avisado: o repo/issue de
          // um cliente não vira mensagem no chat de outro nem no nosso.
          const notifyChatId = await resolveNotifyChatId(app.prisma, project, {
            instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
            instanceChatId:
              process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
          })
          const notify = buildTelegramNotifier({
            botToken:
              process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
            ...(notifyChatId ? { chatId: notifyChatId } : {}),
          })
          const watchdog = await runSmWatchdog({
            repository: project.wingId,
            githubToken: railsToken as string,
            // Mesmo motivo da delegação logo acima: o vigia aplica etiqueta no
            // repositório do cliente, e sem o nível deste projeto cairia no
            // default fail-closed e se recusaria a trabalhar em silêncio.
            fetchImpl: fetchDoQuadro(project),
            ...(notify ? { notify } : {}),
          })
          // Sensor de infra (os "olhos"): varre Actions/Dependabot e levanta
          // ACHADOS TIPADOS — NÃO abre issue (D54, 29/08). Antes ele criava
          // uma issue por run que já falhou uma vez, misturava cinco classes
          // de problema e abriu ~20 duplicadas sem análise de RA/PO. Agora o
          // RA entende a causa e o PO escreve a issue padrão (ESTEIRA-T8).
          // Best-effort: nunca derruba o wake do SM.
          let sensorOut = ''
          let sensorNoOp = true
          try {
            const sensor = await acharIncidentesDeInfra({
              repository: project.wingId,
              githubToken: railsToken as string,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            })
            sensorOut = sensor.output
            sensorNoOp = sensor.noOp === true
            if (sensor.achados.length > 0) {
              app.log.info(
                {
                  achados: sensor.achados.map((a) => ({
                    id: a.identidadeEstavel,
                    classe: a.classe,
                  })),
                },
                `[Scheduler] sensor de infra em ${project.wingId}: ${sensor.achados.length} achado(s) ` +
                  `— aguardando análise do RA (ESTEIRA-T8)`
              )
            }
          } catch (sensorErr) {
            app.log.warn(sensorErr, '[Scheduler] sensor de infra falhou')
            sensorOut = 'sensor de infra: falhou (ver logs).'
          }

          // ESTEIRA-T9: na mesma cadência, fecha os incidentes que sararam —
          // um incidente = uma issue = UM PR, e some sozinho quando fica verde.
          let incidentesOut = ''
          try {
            incidentesOut = await varrerIncidentesDeInfraResolvidos(
              { id: project.id, wingId: project.wingId },
              railsToken as string
            )
          } catch (incErr) {
            app.log.warn(incErr, '[Scheduler] varredura de incidentes resolvidos falhou')
          }

          // ESTEIRA-T11: a esteira voltou vazia porque a conta do dev externo
          // está lotada de sessões vivas, com trabalho pronto esperando? Se
          // isso persiste além do prazo, o dono precisa saber — UMA vez por
          // janela (marca em `events`), nunca a cada acordada.
          try {
            await avisarSeTravadaPorVaga(project, delegation.travadaPorVaga)
          } catch (vagaErr) {
            app.log.warn(vagaErr, '[Scheduler] aviso de esteira travada por vaga falhou')
          }

          result = {
            exitCode: 0,
            output: [delegation.output, watchdog.output, sensorOut, incidentesOut]
              .filter(Boolean)
              .join('\n'),
            stderr: '',
            noOp:
              delegation.noOp === true &&
              watchdog.noOp === true &&
              sensorNoOp &&
              incidentesOut === '',
          }
        } else if (poRails || qaRails || raRails) {
          const stepDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-rails-'))
          let stepN = 0
          // Executor de passo: uma execução curta do motor por formulário.
          const execute = async (prompt: string): Promise<string> => {
            stepN += 1
            const adapter = activeStack.registry.resolve(sel.runtime as F6AgentRuntime)
            const step = await adapter.run({
              missionId: `${missionId}-step-${stepN}`,
              prompt,
              runtime: { runtime: sel.runtime as F6AgentRuntime, ...(model ? { model } : {}) },
              credentialRef,
              role,
              cwd: stepDir,
              timeoutMs: 10 * 60 * 1000,
            })
            // Tarefa 16: checado ANTES do exitCode != 0 de propósito — o bug
            // real é o motor saindo com código 0 (sucesso) enquanto o texto
            // é um pedido de login novo. Sem este corte aqui, a saída cai no
            // runFormStep de baixo, que gasta as tentativas de reparo à toa
            // (repetir o PROMPT não conserta um token expirado) e o texto
            // real do motor se perde atrás de um RailsStepError genérico
            // ("no JSON object found") — exatamente o silêncio que esta
            // tarefa existe para fechar. Ver credencial-do-motor.ts.
            //
            // Correção 2 (corroboração) — decisão deliberada de NÃO estender
            // aqui: `resolveMissionDelivery` (mission-outcome.ts) só avalia
            // entregável de verdade no `pathKind === 'classic'`; em
            // `'rails'` ele devolve `{ delivered: true }` TRIVIALMENTE, por
            // construção (é o próprio desenho do contrato — ver o comentário
            // no topo de mission-outcome.ts). Usar esse resultado aqui
            // faria `entrega.delivered` ser SEMPRE true para todo passo de
            // trilhos, o que apagaria PARA SEMPRE a detecção de credencial
            // expirada no caminho que originou esta tarefa (o bug real de
            // produção, chain=codex>antigravity, foi observado exatamente
            // AQUI — saída sem JSON de um passo de trilhos, não no caminho
            // clássico). Não existe, hoje, uma segunda noção JÁ EXISTENTE de
            // "este passo de trilhos não produziu nada" para reaproveitar
            // sem inventar uma (o candidato mais próximo, `runFormStep`
            // conseguir extrair um JSON válido de `step.output`, é um
            // mecanismo DIFERENTE — rails-runner.ts — não o contrato de
            // entregável por papel que esta correção foi instruída a
            // reaproveitar). Por isso este ponto de checagem permanece só
            // com os dois níveis de confiança de `ehCredencialExpirada`,
            // sem corroboração — risco residual documentado no relatório da
            // tarefa (ADENDO 2), não resolvido aqui de propósito.
            if (
              ehCredencialExpirada({
                stdout: step.output,
                stderr: step.stderr,
                exitCode: step.exitCode,
              })
            ) {
              // Resumo de DUAS PONTAS (ver resumo-de-erro-do-motor.ts): o
              // motivo do Codex mora no fim do stderr, o do Antigravity no
              // começo. O corte de cabeça perdia um dos dois sempre.
              throw new CredencialExpiradaError(
                `motor ${sel.runtime} pediu novo login: ${resumoDeErroDoMotor(
                  step.stderr || step.output
                )}`,
                sel.runtime
              )
            }
            if (step.exitCode !== 0) {
              // O PROCESSO do motor falhou (crash, binário ausente, timeout do
              // processo etc.) — o motor nem chegou a responder, então não há
              // JSON para o runFormStep validar. Isso é diferente de
              // RailsStepError (motor respondeu, formulário nunca validou),
              // mas é IGUALMENTE falha de motor: o próximo motor da cadeia
              // pode conseguir. Antes disto lançava um `Error` genérico que
              // isEngineFault não reconhecia — a missão morria sem nunca
              // tentar o motor de reserva (bug real: chain=codex>antigravity
              // falhando todo dia, antigravity nunca acionado).
              // CLASSIFICA ANTES DE CORTAR. O veredito sai do stderr inteiro
              // e viaja grudado no erro; a mensagem vai resumida para o log e
              // para `missions.error`. Enquanto era o contrário, o produto
              // decidia o failover pelo que tinha sobrado do erro.
              const falha = classificarFalhaDoMotor({ bruto: step.stderr })
              throw marcarFailoverDoTextoCompleto(
                new RailsExecutionError(
                  `rails step ${stepN} failed: ${falha.mensagem}`,
                  step.exitCode
                ),
                falha.ehFailover
              )
            }
            return step.output
          }
          try {
            // Codegraph REAL antes de decidir: clona/atualiza o repo do cliente
            // e injeta o resumo estrutural — sem isso o PO escreveria
            // "Implementation Guide"/"Related Files" no chute e a issue chega
            // fraca no dev assíncrono. Best-effort: sem workspace, segue só
            // com memória.
            let workspacePath: string | undefined
            try {
              const ws = (await activeStack.workspaceProvider.allocateWorkspace(
                project.userId ?? 'scheduler-user',
                project.id,
                { repository: project.wingId }
              )) as { path?: string } | undefined
              workspacePath = ws?.path
            } catch (wsErr) {
              app.log.warn(wsErr, `[Scheduler] rails sem workspace para ${project.wingId}`)
            }
            const contextBlocks = await buildMissionEnricher({ cortex: app.cortex })({
              projectId: project.id,
              role,
              ...(workspacePath ? { workspacePath } : {}),
            })
            // D51/D52: quem FALA com o dev assíncrono — o RA e o PO ao escrever
            // a issue, e o QA ao responder uma dúvida — leva o guia curado do
            // jules-awesome-list + o que já aprendemos sobre como o Jules falha
            // NESTE projeto. É o que deixa a resposta à dúvida ancorada e a
            // próxima issue melhor.
            if (poRails || raRails || qaRails) {
              const blocoJules = await blocoDeContextoDoJules({
                prisma: app.prisma as unknown as PrismaEventoDoJules,
                projectId: project.id,
                onWarn: (m) => app.log.warn(m),
              })
              if (blocoJules.trim()) contextBlocks.push(blocoJules)
            }
            // Colunas do board: config POR PROJETO (runtimeConfig.board.columns),
            // com default nativo — o cliente personaliza, o backend acompanha.
            const boardColumns = resolveBoardColumns(project.runtimeConfig)
            // Tarefa 7 (achado 1 da revisão): o aviso de verificação parada é
            // do DONO do projeto — mesma resolução usada pelo watchdog do SM
            // (acima) e pela vigia da esteira (varrerSessoesDoDev, mais
            // abaixo). Construído só para o QA: PO e RA não julgam
            // verificação, não precisam deste notificador.
            // ESTEIRA-T15: passa por avisarDonoDoProjeto (não um notificador
            // Telegram cru) — é o chokepoint que classifica executivo vs
            // auditoria antes de decidir o canal.
            const avisarDono: ((mensagem: string) => Promise<boolean>) | undefined = qaRails
              ? (texto) => avisarDonoDoProjeto(project, texto)
              : undefined
            result = raRails
              ? await (async () => {
                  const raResult = await runRaMissionViaRails({
                    repository: project.wingId,
                    // O nível deste projeto: sem ele o serviço cai no default
                    // fail-closed e recusa toda escrita no repositório do
                    // cliente — foi o que parou a esteira em 30/08.
                    fetchImpl: fetchDoQuadro(project),
                    githubToken: railsToken,
                    execute,
                    contextBlocks,
                    // Separa os dois trabalhos do RA: pelo aviso de desejo novo
                    // ele analisa AQUELE desejo; pela agenda ele EXPLORA o
                    // projeto. Ancorar de novo num desejo já analisado é refazer
                    // a mesma análise duas vezes por dia em vez de aprender mais
                    // sobre o repositório — e é o explorador quem alimenta a
                    // memória que os outros agentes leem.
                    pelaAgenda: origem === 'agenda',
                  })
                  // D51: junto do trabalho de explorador, o RA entende POR QUE
                  // uma issue falhou 2× — antes da 3ª tentativa. O aprendizado
                  // vai para a memória dos agentes e o pedido revisado para o
                  // prompt da próxima delegação.
                  const analiseOut = await rodarAnaliseDeFalhasDoRa(
                    project,
                    railsToken,
                    execute
                  ).catch((err) => {
                    app.log.warn(
                      err,
                      `[Scheduler] análise de falhas do RA falhou em ${project.wingId}`
                    )
                    return ''
                  })
                  // D54: entre o sensor e a delegação existe SEMPRE análise —
                  // o RA entende a causa de cada falha de infra e o PO escreve
                  // a issue padrão Shrimp, no repo certo (cliente vs produto).
                  const achadosOut = await rodarProcessamentoDeAchados(
                    project as NotifiableProject & { id: string; wingId: string },
                    railsToken,
                    execute,
                    contextBlocks
                  ).catch((err) => {
                    app.log.warn(
                      err,
                      `[Scheduler] processamento de achados de infra falhou em ${project.wingId}`
                    )
                    return ''
                  })
                  const extra = [analiseOut, achadosOut].filter(Boolean).join('\n')
                  return extra ? { ...raResult, output: `${raResult.output}\n${extra}` } : raResult
                })()
              : poRails
                ? await runPoMissionViaRails({
                    repository: project.wingId,
                    fetchImpl: fetchDoQuadro(project),
                    ...(railsBoard ? { board: railsBoard } : {}),
                    githubToken: railsToken as string,
                    contextBlocks,
                    boardColumns,
                    sprintDays: resolveSprintDays(project.runtimeConfig),
                    execute,
                    projectId: project.id,
                    userId: project.userId ?? undefined,
                    agentQuestionService: app.agentQuestionService,
                  })
                : await (async () => {
                    // ANTES de julgar PR: o dev está parado esperando resposta?
                    // Best-effort — uma pergunta que não dá para responder não
                    // pode impedir o julgamento, que é o outro trabalho do QA.
                    // A trava de "já respondida" vive dentro da função: sem
                    // ela, a mesma resposta sairia a cada acordada.
                    await responderDuvidaPendente({
                      projectId: project.id,
                      repository: project.wingId,
                      execute,
                      contextBlocks,
                      runtimeConfig: project.runtimeConfig,
                    }).catch((err: unknown) =>
                      app.log.warn(
                        err,
                        `[Scheduler] não deu para responder a dúvida do dev em ${project.wingId}`
                      )
                    )
                    return runQaMissionViaRails({
                      repository: project.wingId,
                      fetchImpl: fetchDoQuadro(project),
                      githubToken: railsToken as string,
                      contextBlocks,
                      // Vivas + fechadas com PR pendente (não mescladas), sem
                      // teto — ver filtroDeSessoesParaJulgamento.
                      sessoes: await app.prisma.devSession.findMany({
                        where: filtroDeSessoesParaJulgamento(project.id),
                        orderBy: { createdAt: 'desc' },
                      }),
                      // Tarefa 7 (achado 1 da revisão): registrarPendencia,
                      // limparPendencia, registrarAvisoDeDemora e avisarDono —
                      // sem isto a vigília da verificação fica correta e
                      // testada em isolamento, e inerte aqui: pending_since
                      // nunca é gravado, o teto de 90min nunca amadurece, o
                      // dono nunca é avisado.
                      ...montarOpcoesDoJulgamento({
                        prisma: app.prisma as unknown as PrismaDevSession,
                        projectId: project.id,
                        avisarDono,
                      }),
                      // Fase 1 do QA (Reconhecimento): só entra quando este QA foi
                      // acordado pela cascata de onboarding (Task 10) — hoje o
                      // único jeito de o QA rodar, já que o projeto não tem
                      // agenda de QA própria em project_schedules.
                      ...(isOnboarding ? { mode: 'recon' as const } : {}),
                      // O QA move o card da issue conforme o veredito (se há board).
                      ...(railsBoard
                        ? {
                            moveCard: createCardMover({
                              repository: project.wingId,
                              board: railsBoard,
                              token: railsToken as string,
                              columns: boardColumns,
                              // Mover card é escrita no quadro do cliente. Sem
                              // isto a chamada caía no `?? fetch` de
                              // board-status.ts, fora da guarda.
                              fetchImpl: fetchDoQuadro(project),
                            }),
                          }
                        : {}),
                      // Task 10: a reprovação volta para a sessão do dev
                      // assíncrono — sem isto o veredito morre no comentário do
                      // PR (medido: PR #79, 5 dias parado, 12 reprovações, zero
                      // retrabalho). A API não tem retomada; `sendMessage` é o
                      // único caminho, por isso `responderSessaoJules` mesmo.
                      registrarAvisoPendente: ({ sessionName, texto }) =>
                        registrarAvisoDeRetrabalhoPendente({
                          prisma: app.prisma as unknown as PrismaDevSession,
                          sessionName,
                          texto,
                        }),
                      avisarSessao: async ({ sessionName, texto }) =>
                        responderSessaoJules({
                          // BYOK (D34): o pedido de retrabalho tem que chegar na
                          // conta em que a sessão nasceu, senão o veredito do QA
                          // morre no comentário do PR — exatamente o defeito do
                          // #79, que voltaria só para os clientes com conta própria.
                          apiKey: await chaveDaSessao(sessionName),
                          sessionName,
                          texto,
                          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
                        }),
                      // Task 11 (decisão do dono D7): o produto mescla sozinho,
                      // sem confirmação humana. `mesclarPr` já fez o merge de
                      // verdade quando este callback dispara. Tarefa 17: NÃO
                      // fecha mais a linha da vigia aqui — só grava o commit
                      // mesclado (`aoMesclarUmaEntrega`, acima). Quem fecha é
                      // `varrerPublicacoes` (mais abaixo), quando há veredito
                      // sobre a publicação; até lá a sessão continua fora de
                      // `filtroDeSessoesParaJulgamento` na prática, porque o PR
                      // já mesclado sai da listagem de PRs ABERTOS do GitHub
                      // que alimenta o laço de descoberta do QA — não porque a
                      // linha esteja fechada.
                      aoMesclar: async ({ numeroDoPr, mergeCommitSha, issueNumber }) =>
                        aoMesclarUmaEntrega({
                          prisma: app.prisma as unknown as PrismaDevSession,
                          projectId: project.id,
                          numeroDoPr,
                          mergeCommitSha,
                          issueNumber,
                          agora: new Date(),
                          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
                        }),
                      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
                      execute,
                    })
                  })()
          } finally {
            await fs.rm(stepDir, { recursive: true, force: true }).catch(() => undefined)
          }
        } else {
          if (role === 'po' || role === 'qa') {
            app.log.info(`[Scheduler] ${role} sem GITHUB_TOKEN/board: usando caminho clássico`)
          }
          result = await activeStack.orchestrator.runMission({
            id: missionId,
            projectId: project.id,
            repository: project.wingId,
            role,
            goal: `Analyze and coordinate tasks for ${project.name}`,
            context: [],
            runtime: { runtime: sel.runtime as F6AgentRuntime, ...(model ? { model } : {}) },
            credentialRef,
            userId: project.userId ?? 'scheduler-user',
            timeoutMs: STALE_RUNNING_MS,
          })
          // Tarefa 16: só faz sentido AQUI, no caminho clássico — é o único
          // ramo deste if/else-if/else onde `result.output` é saída CRUA do
          // motor. Nos trilhos o sinal já foi checado dentro de `execute()`
          // (mais acima) contra a saída crua real, antes do runFormStep
          // sintetizar outra coisa; no smRails (delegação/watchdog/sensor)
          // não há chamada de motor nenhuma para checar.
          //
          // Correção 2 (corroboração): calcula o entregável do papel ANTES
          // do sinal textual, sobre a MESMA saída — é o único ponto de
          // checagem de credencial expirada onde o contrato de entregável
          // por papel (`resolveMissionDelivery`, mission-outcome.ts, commit
          // 87806ea) se aplica de verdade (pathKind='classic' sempre, aqui).
          // Sem isto, uma missão de documentação/análise que só MENCIONA
          // `invalid_grant`/`401 unauthorized` de passagem — mas entregou o
          // relatório de verdade — disparava o aviso falso (medido na
          // segunda revisão). Puro e independente de exitCode: mesmo um
          // motor que saiu != 0 pode ter tentado escrever algo real antes de
          // cair, e o contrato só olha o TEXTO.
          const entregaParaCorroboracao = resolveMissionDelivery(role, result.output, 'classic')
          if (
            ehFalhaDeCredencialCorroborada(
              {
                stdout: result.output,
                stderr: result.stderr,
                exitCode: result.exitCode,
              },
              entregaParaCorroboracao
            )
          ) {
            throw new CredencialExpiradaError(
              `motor ${sel.runtime} pediu novo login: ${resumoDeErroDoMotor(
                result.stderr || result.output
              )}`,
              sel.runtime
            )
          }
        }

        // Achado crítico da revisão pós-merge: o contrato de entregável só
        // faz sentido no caminho CLÁSSICO (saída crua do motor). Nos
        // trilhos (PO/SM/QA/RA), a LLM só preenche formulário validado por
        // schema e o executor determinístico é quem produz a saída final —
        // entrega por construção. Aplicar o contrato ali reprovava saídas
        // reais dos trilhos e travava a cascata de onboarding (SM/QA nunca
        // acordavam, pois o ramo "entregue" nunca era alcançado).
        const pathKind: MissionPathKind =
          smRails || poRails || qaRails || raRails ? 'rails' : 'classic'
        // Menor da revisão: `entrega` só faz sentido quando o motor saiu 0 —
        // com exitCode != 0 a missão já falhou pelo código de saída, e o
        // valor antigo (sempre construído, mesmo aqui) nunca era lido por
        // nenhum dos dois `if` abaixo (ambos exigem exitCode === 0). Só
        // computa quando pode importar.
        const entrega =
          result.exitCode === 0 ? resolveMissionDelivery(role, result.output, pathKind) : undefined

        if (entrega && !entrega.delivered) {
          // Verde mentiroso: o motor respondeu, mas não entregou. Falha honesta
          // com o motivo, e NADA vai para a memória do projeto.
          app.log.warn(`[Scheduler] Mission ${missionId} sem entregavel: ${entrega.reason}`)
          await app.prisma.mission.updateMany({
            where: { id: missionId, status: 'running' },
            data: {
              status: 'failed',
              completedAt: new Date(),
              error: entrega.reason,
              result: { output: result.output, stderr: result.stderr, runtime: sel.runtime },
            },
          })
          return
        }

        if (entrega && entrega.delivered) {
          // O entregável vira memória tipada do projeto — exceto no-ops (ex.:
          // "sem wishlist"), que poluiriam o recall e expulsariam o brief do RA.
          const isNoOp = (result as { noOp?: boolean }).noOp === true
          // O elo que faltava: `noOp` era produzida por meio mundo de serviço
          // e ninguém a consumia. Acordada vazia manda o papel descansar;
          // acordada que fez trabalho apaga o descanso na hora.
          if (isNoOp) {
            const ate = descansoAposVazia.registrarAcordadaVazia({
              projectId: project.id,
              role,
            })
            app.log.info(
              `[Scheduler] ${role} de ${project.wingId} voltou vazio; descansa até ${ate.toISOString()}`
            )
          } else {
            descansoAposVazia.registrarAcordadaProdutiva({ projectId: project.id, role })
          }
          if (!isNoOp) {
            await persistMissionMemory(app.cortex, {
              projectId: project.id,
              role,
              content: result.output,
              now: new Date().toISOString(),
            })
          }

          const updated = await app.prisma.mission.updateMany({
            where: { id: missionId, status: 'running' },
            data: {
              waitingStatus:
                (result as unknown as { waitingStatus?: string }).waitingStatus ?? null,
              waitingReason:
                (result as unknown as { waitingReason?: string }).waitingReason ?? null,
              status: (result as unknown as { waitingStatus?: string }).waitingStatus
                ? 'waiting'
                : 'completed',
              completedAt: (result as unknown as { waitingStatus?: string }).waitingStatus
                ? null
                : new Date(),
              error: null,
              result: {
                output: result.output,
                stderr: result.stderr,
                runtime: sel.runtime,
                // A marca de "acordei e não havia nada para fazer" precisa
                // SOBREVIVER à missão. Ela já existia em memória — mandava o
                // papel descansar — e morria aqui, sem nunca chegar ao banco.
                // Sem ela gravada, o teto do dia não tem como distinguir
                // trabalho de acordada em falso, e foi exatamente isso que
                // parou a esteira em 21/08: 220 missões contadas, 143 delas
                // sem ter chamado motor nenhum.
                ...(isNoOp ? { noOp: true } : {}),
              },
            },
          })
          if (updated.count === 0) {
            app.log.warn(`[Scheduler] Mission ${missionId} já não estava 'running'; descartado`)
            return
          }
          app.log.info(`[Scheduler] Mission ${missionId} completed via ${sel.runtime}`)
          // Sucesso prova que o motor está vivo: se ele estava de fora por
          // credencial morta, volta ao rodízio na hora.
          motorEmPausa.marcarVivo(sel.runtime)

          // PASSA O BASTÃO. Sem isto a esteira anda em soluços: cada papel
          // roda pela agenda e ninguém chama o seguinte, então o trabalho que
          // o RA acabou de deixar pronto espera o próximo agendamento do PO —
          // medido na corrida de 26/08, um desejo chegava ao dev só porque eu
          // acordei PO e SM na mão.
          //
          // Acordada em falso NÃO passa o bastão: se o papel não achou nada
          // para fazer, não há trabalho novo esperando o seguinte, e acordá-lo
          // seria gastar motor para ouvir o mesmo silêncio.
          if (!isNoOp) passagemDeBastao.passar(role, project.id)

          // Medição de consumo (ideia do owner): refresca a quota do motor que
          // rodou e grava a diferença antes−depois na missão. Best-effort: nunca
          // quebra a conclusão. Só funciona quando o provider expõe quota.
          if (project.userId) {
            try {
              await app.engineConnections.refreshModels(project.userId, sel.runtime)
              const after = await app.prisma.engineConnection.findFirst({
                where: { userId: project.userId, runtime: sel.runtime, status: 'connected' },
                select: { quotaRemaining: true },
              })
              const before =
                (
                  await app.prisma.mission.findUnique({
                    where: { id: missionId },
                    select: { quotaBefore: true },
                  })
                )?.quotaBefore ?? null
              const c = computeConsumption(before, after?.quotaRemaining ?? null)
              if (c.quotaAfter != null || c.tokensUsed != null) {
                await app.prisma.mission.update({
                  where: { id: missionId },
                  data: { quotaAfter: c.quotaAfter, tokensUsed: c.tokensUsed },
                })
                app.log.info(
                  `[Scheduler] Consumo ${missionId}: antes=${before} depois=${c.quotaAfter} usou=${c.tokensUsed}`
                )
              }
            } catch (e) {
              app.log.warn({ e }, `[Scheduler] medição de consumo falhou para ${missionId}`)
            }
          }
          if (!isNoOp) {
            try {
              await app.saveMissionMemory({
                // A chave é o ID do projeto, não o endereço do repositório.
                //
                // Esta gravação usava `project.wingId` — "dono/repositorio" —
                // que NÃO é único entre clientes: o schema declara
                // `@@unique([userId, wingId])` justamente porque dois clientes
                // podem cadastrar o mesmo repositório. Nada lia por essa chave,
                // então a gaveta era escrita e nunca aberta; mas no dia em que
                // alguém lesse, misturaria a memória de dois clientes.
                //
                // Com o `projectId`, esta gravação passa a cair na MESMA
                // prateleira que `persistMissionMemory` já usa e que os agentes
                // leem de verdade — a gaveta deixa de ser morta.
                wingId: project.id,
                missionId,
                agentRole: role,
                content: result.output,
              })
            } catch (memErr) {
              app.log.error(memErr, `[Scheduler] Falha ao gravar memória de ${missionId}`)
            }
          }

          // Encadeamento automático de onboarding (Evento 1) — FORA do bloco
          // de memória de propósito: uma missão sem trabalho a fazer (SM de
          // projeto novo, sem nada para delegar) é no-op legítimo e não pode
          // matar a esteira. Enquanto houver fila, a cascata segue.
          try {
            const m = await app.prisma.mission.findUnique({
              where: { id: missionId },
              select: { payload: true, projectId: true },
            })
            const p = m?.payload as { onboardingSequence?: F6AgentRole[] } | null
            if (shouldChainOnboarding({ isNoOp, sequence: p?.onboardingSequence })) {
              const next = nextOnboardingStep(p?.onboardingSequence)
              if (next) {
                app.log.info(
                  `[Scheduler] Onboarding (${role} concluído${isNoOp ? ', sem trabalho a fazer' : ''}): disparando ${next.role} para ${project.wingId}`
                )
                void triggerAgentMission(next.role, m?.projectId, next.remaining)
              }
            }
          } catch (chainErr) {
            app.log.error(chainErr, `[Scheduler] Falha ao encadear onboarding após ${role}`)
          }
          return
        }

        lastError = result.stderr || `exit ${result.exitCode}`
        // exit 124 = timeout/hang do motor (o modo transitório mais comum);
        // também justifica trocar para o próximo motor do cliente.
        const worthy = isFailoverError(lastError) || result.exitCode === 124
        if (!isLast && worthy) {
          app.log.warn(
            `[Scheduler] ${sel.runtime} falhou (${result.exitCode}); failover para ${chain[i + 1]?.runtime}`
          )
          continue
        }
        break
      } catch (err) {
        lastError = String((err as { stack?: string })?.stack ?? err)
        // Classificação de origem do erro (Lei dos trilhos) — ver isEngineFault:
        // - GithubExecutionError: o GitHub falhou (token/rate-limit do REPO) —
        //   igual para TODOS os motores; failover só repetiria o dano. Falha já.
        // - RailsStepError / RailsExecutionError: falha de MOTOR (formulário
        //   nunca validou, OU o processo do motor saiu com exitCode != 0) —
        //   é exatamente o caso do failover (o próximo motor pode conseguir).
        // - Demais: failover apenas para cota/rate/auth (padrão existente).
        if (err instanceof GithubExecutionError) {
          app.log.error(err, `[Scheduler] erro de execução no GitHub; sem failover`)
          break
        }
        // Tarefa 16: credencial expirada é falha de motor (cai para a
        // reserva via isEngineFault, abaixo, exatamente como qualquer outra)
        // — mas É DIFERENTE de qualquer outra porque só o DONO resolve
        // (refazendo o login). Sem isto, a esteira segue funcionando pela
        // reserva e ninguém percebe que um motor ficou pra trás, como
        // aconteceu de verdade em produção. Avisa uma vez por dono+motor por
        // dia (deveAvisarDeNovo) — SPAM apaga sinal tanto quanto silêncio,
        // mesma disciplina de session-watch.ts.
        // ACABOU A COTA não é LOGIN VENCIDO, e confundir os dois custou caro:
        // em 27/08 o dono religou o Codex DUAS VEZES no mesmo dia por um
        // diagnóstico errado. A resposta literal do provedor, capturada
        // rodando o CLI na mão, era "You've hit your usage limit" — conta no
        // teto, que só o tempo resolve. Antes disto esse caso não produzia
        // aviso NENHUM: o dono só percebia quando as coisas paravam de andar.
        if (!falhaDeCredencial && ehTetoDeUsoDaConta(lastError)) {
          const chaveDoTeto = `teto:${project.userId ?? project.id}:${sel.runtime}`
          if (deveAvisarDeNovo(avisosDeCredencialExpirada, chaveDoTeto, Date.now())) {
            avisosDeCredencialExpirada.set(chaveDoTeto, Date.now())
            const chatDoTeto = await resolveNotifyChatId(app.prisma, project, {
              instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
              instanceChatId:
                process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
            }).catch(() => null)
            const avisarDoTeto = buildTelegramNotifier({
              botToken:
                process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
              ...(chatDoTeto ? { chatId: chatDoTeto } : {}),
            })
            if (avisarDoTeto) {
              await avisarDoTeto(
                recadoDeTetoDeUso({
                  runtime: sel.runtime,
                  volta: quandoACotaVolta(lastError),
                })
              ).catch(() => undefined)
            }
          }
        }
        if (err instanceof CredencialExpiradaError) {
          falhaDeCredencial = true
          // A TELA PARA DE MENTIR. Antes disto, este caminho marcava a falha no
          // RESULTADO DA MISSÃO e mandava o recado — mas nunca tocava na linha
          // da conexão, que seguia dizendo 'connected' para sempre. O dono
          // mandou o print (26/08): card do Codex verde, "Conectado", com os
          // modelos listados, no mesmo minuto em que toda missão morria por
          // credencial. Uma tela verde não oferece nada para clicar; era a
          // própria mentira que tirava dele o caminho de religar.
          //
          // Fora do `deveAvisarDeNovo` de propósito: o RECADO é uma vez por dia
          // (spam apaga sinal), mas o ESTADO precisa ficar certo na hora —
          // senão a tela continuaria verde pelas outras vinte e três horas.
          //
          // A credencial cifrada NÃO é apagada: se a renovação voltar a
          // funcionar, `captureFromHome` regrava 'connected' sozinho na
          // primeira missão que der certo, e a marca se desfaz sem ninguém
          // limpar nada na mão.
          if (project.userId) {
            await app.prisma.engineConnection
              .updateMany({
                where: { userId: project.userId, runtime: err.runtime },
                data: marcaDePedidoDeLogin(err.runtime),
              })
              .catch((e: unknown) =>
                app.log.warn(
                  `[Scheduler] não consegui marcar ${err.runtime} como precisando de login: ${(e as Error).message}`
                )
              )
          }
          const chaveDoAviso = `${project.userId ?? project.id}:${err.runtime}`
          if (deveAvisarDeNovo(avisosDeCredencialExpirada, chaveDoAviso, Date.now())) {
            avisosDeCredencialExpirada.set(chaveDoAviso, Date.now())
            const notifyChatId = await resolveNotifyChatId(app.prisma, project, {
              instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
              instanceChatId:
                process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
            })
            const avisar = buildTelegramNotifier({
              botToken:
                process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
              ...(notifyChatId ? { chatId: notifyChatId } : {}),
            })
            if (avisar) {
              // Correção 2: mesmo corroborada, isto é uma INFERÊNCIA (texto +
              // ausência de entregável), não um fato observado — o produto
              // nunca viu a credencial em si, só concluiu a partir da saída.
              // A mensagem não afirma "a credencial expirou" como certeza;
              // descreve o que foi observado (terminou sem entregar, saída
              // parece pedido de login) e pede para o dono CONFERIR.
              await avisar(
                `GitOrch: o motor ${err.runtime} terminou sem entregar nada no projeto ` +
                  `${project.wingId}, e a saída lembra um pedido de login expirado — vale conferir ` +
                  `a conexão desse motor. Até lá, a reserva da cadeia assume o trabalho.`
              ).catch(() => undefined)
            }
          }
        }
        const engineFault = isEngineFault(err, lastError)
        if (engineFault) {
          // ESTA linha de log apareceu 54 vezes no journal de 31/08 numa janela
          // de 9h48 — 24 vezes com o MESMO `invalid model selection` e 30 com o
          // MESMO 401. Um motor quebrado, tentado a cada poucos minutos, para
          // sempre. Contar as falhas IGUAIS seguidas tira do rodízio o motor que
          // não vai melhorar sozinho, sem punir o que só teve um dia ruim (ver
          // marcarFalha/assinaturaDeFalha em motor-em-pausa.ts).
          const pausa = motorEmPausa.marcarFalha(sel.runtime, lastError, new Date())
          if (pausa.pausou) app.log.warn(`[Scheduler] ${pausa.motivo}`)
        }
        if (!isLast && engineFault) {
          app.log.warn(err, `[Scheduler] erro recuperável em ${sel.runtime}; próximo motor`)
          continue
        }
        break
      }
    }

    // Chegou aqui = nenhum motor concluiu. Grava falha honesta.
    try {
      await app.prisma.mission.updateMany({
        where: { id: missionId, status: 'running' },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: lastError.slice(0, 4000),
          // A missão CONTINUA registrada como falha — o histórico não pode
          // mentir. O que a marca muda é só uma coisa: ela não ocupa vaga do
          // teto diário (ver o cálculo de instanceToday em runTrigger).
          ...(falhaDeCredencial ? { result: { falhaDeCredencial: true } } : {}),
        },
      })
    } catch (persistErr) {
      app.log.error(persistErr, `[Scheduler] Falha ao persistir falha de ${missionId}`)
    }
  }

  const triggerAgentMission = async (
    role: F6AgentRole,
    projectId?: string,
    onboardingSequence?: F6AgentRole[],
    origem: OrigemDoDisparo = 'agenda'
  ): Promise<TriggerResult> => {
    app.log.info(`[Scheduler] Triggering agent mission for role: ${role} (origem: ${origem})`)
    // Encadeia os disparos para que nunca rodem concorrentes (guard sem corrida).
    const result = triggerChain.then(
      () => runTrigger(role, projectId, onboardingSequence, origem),
      () => runTrigger(role, projectId, onboardingSequence, origem)
    )
    triggerChain = result.catch(() => ({ triggered: false, reason: 'error' }))
    try {
      return await result
    } catch (err) {
      app.log.error(err, `[Scheduler] Error triggering agent mission for role ${role}`)
      return { triggered: false, reason: 'error' }
    }
  }

  // Reasons de recusa que são temporárias: a janela deve ser reprocessada no
  // próximo tick (o claim do lastTriggeredAt é revertido). 'no-project' e cron
  // inválido não entram aqui — não adianta reprocessar.
  const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
    'busy',
    'plan-budget',
    'instance-failsafe',
    'engine-quota-critical',
    'token-budget',
    'error',
    'init',
    // Descanso é temporário POR DEFINIÇÃO: a janela do cron é devolvida para
    // ser reprocessada. Queimá-la faria uma acordada vazia às 08:00 custar a
    // janela inteira das 08:00 — a próxima só às 16:00.
    'descanso',
  ])

  /**
   * Tira UMA acordada de julgamento da fila do SM por tique.
   *
   * Um por tique, não a fila inteira: com o teto de concorrência em 1, pedir
   * três de uma vez só produziria dois `busy` e dois avisos de recusa. Uma
   * por minuto drena três entregas em três minutos — mais rápido que o
   * relógio próprio do julgamento (0 0,8,16) e sem tempestade nenhuma.
   *
   * Recusa temporária DEVOLVE a vez à fila, pelo mesmo motivo que a janela do
   * cron é devolvida quando `triggerAgentMission` recusa: perder a vez por
   * "estou ocupado agora" é justamente o defeito que deixou entrega parada.
   */
  /**
   * Tira UMA acordada de julgamento da fila do SM por tique.
   *
   * Uma por minuto drena três entregas em três minutos — mais rápido que o
   * relógio próprio do julgamento (0 0,8,16) e sem tempestade nenhuma.
   */
  /**
   * Acorda quem recebeu o bastão do papel anterior.
   *
   * Uma vez por tique, como a fila de julgamento: a esteira anda sem
   * tempestade, e a recusa temporária devolve a vez em vez de perder o
   * trabalho — perder a vez por "estou ocupado agora" é justamente o defeito
   * que deixou entrega parada por dias.
   */
  const drenarPassagemDeBastao = async (): Promise<void> => {
    const vez = passagemDeBastao.proxima()
    if (!vez) return

    const resultado = await triggerAgentMission(vez.papel, vez.projectId, undefined, 'esteira')
    if (!resultado.triggered && resultado.reason && RETRYABLE_REASONS.has(resultado.reason)) {
      passagemDeBastao.devolver(vez)
      app.log.warn(
        `[Scheduler] ${vez.papel} chamado pela esteira em ${vez.projectId} recusado ` +
          `(${resultado.reason}); a vez volta para a fila`
      )
      return
    }
    if (resultado.triggered) {
      app.log.info(`[Scheduler] a esteira passou o bastão para ${vez.papel} em ${vez.projectId}`)
    }
  }

  const drenarFilaDeJulgamento = async (): Promise<void> => {
    const projectId = filaDeJulgamento.proxima()
    if (!projectId) return

    const resultado = await triggerAgentMission('qa', projectId, undefined, 'fila-do-sm')
    if (!resultado.triggered && resultado.reason && RETRYABLE_REASONS.has(resultado.reason)) {
      // Recusa temporária DEVOLVE a vez, pelo mesmo motivo que a janela do
      // cron é devolvida: perder a vez por "estou ocupado agora" é
      // exatamente o defeito que deixou entrega parada por dias.
      filaDeJulgamento.devolver(projectId)
      app.log.warn(
        `[Scheduler] julgamento pedido pelo SM para ${projectId} recusado (${resultado.reason}); ` +
          'a vez volta para a fila e o próximo tique tenta de novo'
      )
    }
  }

  // Processa as missões `clone_and_start_engines` que o wizard cria ao
  // finalizar o cadastro — sem isto elas ficavam órfãs (spec §17.3). Roda a
  // cada tick (mesma cadência do resto do dispatch); claim condicional evita
  // dois ticks pegarem a mesma missão.
  const processSetupMissions = async (): Promise<void> => {
    let pending
    try {
      pending = await app.prisma.mission.findMany({
        where: { type: 'clone_and_start_engines', status: 'pending' },
        // FIFO: a mais antiga primeiro — mesma ordem da fila visível em
        // GET /api/v1/setup/status (queuePosition).
        orderBy: { createdAt: 'asc' },
        include: { project: { include: { user: { include: { plan: true } } } } },
      })
    } catch (err) {
      app.log.error(err, '[Scheduler] falha ao ler missões de setup pendentes')
      return
    }

    if (pending.length === 0) return

    // O wizard passa a respeitar o MESMO teto global da cadência: antes disto
    // processSetupMissions nunca checava concorrência nenhuma e disparava
    // clone+subida de motores sem limite, ignorando o orçamento de CPU/RAM da
    // VM. `active` é a mesma contagem pending+running que runTrigger usa;
    // subtraímos o próprio lote (todo pending, então já contado ali) para
    // achar o que outra coisa já ocupa.
    const active = await app.prisma.mission.count({
      where: { status: { in: ['pending', 'running'] } },
    })
    const otherActiveCount = active - pending.length
    const claimable = selectClaimableSetupMissions(
      pending,
      otherActiveCount,
      MAX_CONCURRENT_MISSIONS
    )
    const claimableIds = new Set(claimable.map((m) => m.id))

    for (const mission of pending) {
      if (!claimableIds.has(mission.id)) {
        app.log.warn(
          `[Scheduler] Concorrência cheia (${MAX_CONCURRENT_MISSIONS}); setup mission ${mission.id} (${mission.project.wingId}) fica na fila`
        )
        continue
      }

      const claimed = await app.prisma.mission.updateMany({
        where: { id: mission.id, status: { in: ['pending', 'waiting'] } },
        data: {
          status: 'running',
          startedAt: new Date(),
          waitingStatus: null,
          waitingReason: null,
        },
      })
      if (claimed.count === 0) continue // outro tick já reivindicou esta missão

      const activeStack = selectRuntimeStack(
        mission.project.user?.plan?.id,
        localStack,
        remoteStack
      )
      // Repositório privado clona com o token do PRÓPRIO dono do projeto
      // (cofre cifrado) — nunca uma credencial do host.
      const githubToken = mission.project.userId
        ? await app.engineConnections.getRawGithubToken(mission.project.userId)
        : null
      // IMPORTANTE (leva D): `provisionSetupMission` cai no PRÓPRIO default
      // (`new ProjectV2Client({ token: boardToken })`, sem teto nenhum)
      // quando `createProjectV2Client` não é injetado — achado nesta
      // auditoria além da lista do despacho, mesma classe de defeito, mesmo
      // caminho (`processSetupMissions` → `tick()`, sob `tickEmAndamento`).
      const outcome = await provisionSetupMission(mission, activeStack, githubToken ?? undefined, {
        prisma: app.prisma,
        log: app.log,
        createProjectV2Client: (token) =>
          new ProjectV2Client({ token, fetchImpl: fetchDoQuadro(mission.project) }),
      })
      await app.prisma.mission.update({
        where: { id: mission.id },
        data: {
          status: outcome.status,
          completedAt: new Date(),
          ...(outcome.output ? { result: { output: outcome.output } } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      })
      if (outcome.status === 'failed') {
        app.log.error(
          `[Scheduler] provisionamento do projeto ${mission.project.wingId} falhou: ${outcome.error}`
        )
      } else if (outcome.status === 'completed') {
        // Trigger next mission in onboarding sequence if present
        const payload = mission.payload as { onboardingSequence?: F6AgentRole[] } | null
        const seq = payload?.onboardingSequence
        if (seq && seq.length > 0) {
          const [nextRole, ...remaining] = seq
          app.log.info(
            `[Scheduler] Setup concluído para ${mission.project.wingId}. Disparando onboarding: ${nextRole}`
          )
          void triggerAgentMission(
            nextRole as F6AgentRole,
            mission.projectId,
            remaining as F6AgentRole[],
            'onboarding'
          )
        }
      }
    }
  }

  // Agenda dirigida a dados: cada projeto define seu cron por agente em
  // project_schedules. A cada minuto, dispara o que venceu desde o último
  // disparo registrado. O claim condicional do lastTriggeredAt impede dois
  // ticks de dispararem a mesma janela; quando o disparo é recusado por um
  // motivo temporário (missão em andamento, orçamento), o claim é revertido
  // para a janela não se perder.
  // Faxina do ciclo de vida do ambiente: destrói ambientes provisórios (não
  // fixados) SEM ATIVIDADE há mais de 24h — abandonados no wizard, guardam
  // credencial + OAuth do cliente e não podem ficar largados (requisito de
  // segurança). O relógio é de INATIVIDADE, não de idade: o cliente que ainda
  // está usando o wizard renova o ambiente a cada passo real (ver
  // ClientEnvironmentService.touch) e nunca é varrido no meio do cadastro.
  const ENV_TTL_MS = Number(process.env['GITORCH_ENV_TTL_MS'] ?? String(24 * 60 * 60 * 1000))
  const sweepExpiredEnvironments = async (): Promise<void> => {
    try {
      const expired = await clientEnvironments.listExpired(ENV_TTL_MS)
      for (const env of expired) {
        await clientEnvironments.destroy(env.id)
        app.log.info(`[Scheduler] ambiente provisório abandonado destruído: ${env.id}`)
      }
    } catch (err) {
      app.log.error(err, '[Scheduler] faxina de ambientes falhou; tenta no próximo tick')
    }
  }

  // Vigia das sessões do dev assíncrono.
  //
  // Roda no TICK, não no acordar do SM. A diferença importa: o SM acorda quatro
  // vezes por dia, e uma pergunta feita logo depois do acordar dormiria seis
  // horas esperando resposta. O tick roda a cada minuto e a própria
  // `vigiarSessoes` só reexamina uma sessão a cada dez minutos — é daí que sai
  // a cadência, e não de um relógio novo.
  //
  // Escopada por construção: só varre PROJETOS QUE TÊM sessão viva. Sem sessão
  // viva em lugar nenhum, não há uma única chamada ao serviço externo.
  // Reconciliação de vagas: devolver ao dev externo o que ninguém aqui reclama.
  //
  // O fechamento já arquiva do lado de fora desde o PR #160, e isso só estanca
  // o vazamento NOVO. O que já vazou antes daquele conserto — ou porque a
  // gravação da linha falhou depois de a sessão nascer — continua vivo lá
  // fora, ocupando uma vaga, sem ninguém para soltá-la. Medido em 22/08/2026:
  // vinte e uma linhas abertas neste banco, a mais velha de 15/08.
  //
  // Cadência de HORA, não de tique: é uma limpeza de acúmulo, não uma vigília.
  // A lista do fornecedor é uma chamada paginada, e pedi-la a cada minuto
  // seria gastar cota para descobrir que nada mudou.
  /**
   * Cadência da reconciliação de vagas, e o ÚNICO botão desta engrenagem.
   *
   * Uma hora por padrão: é limpeza de acúmulo, não vigília. A lista do
   * fornecedor é uma chamada paginada, e pedi-la a cada minuto seria gastar
   * cota para descobrir que nada mudou.
   *
   * As outras duas medidas são DERIVADAS desta, de propósito — três botões
   * independentes seria convite para ficarem incoerentes entre si.
   */
  const CADENCIA_PADRAO_DA_RECONCILIACAO_MS = 60 * 60 * 1000
  const CADENCIA_DA_RECONCILIACAO_MS = (() => {
    const bruto = process.env['GITORCH_RECONCILIACAO_CADENCIA_MS']
    if (bruto === undefined) return CADENCIA_PADRAO_DA_RECONCILIACAO_MS
    const lido = Number(bruto)
    // `Number(x) ?? padrão` NÃO protege nada: o `??` só age em null/undefined,
    // e string vazia vira 0, texto vira NaN, e negativo passa inteiro. Qualquer
    // um dos três faz a comparação de cadência (`agora - ultima < cadência`)
    // ser SEMPRE falsa — porque nada é menor que NaN, e o tempo decorrido nunca
    // é menor que zero. A varredura passaria a rodar a CADA TIQUE do relógio,
    // um minuto por padrão, para sempre: até cem páginas de listagem e duzentos
    // arquivamentos contra o fornecedor, de minuto em minuto, por causa de um
    // erro de digitação numa variável de ambiente.
    if (!Number.isFinite(lido) || lido <= 0) {
      app.log.warn(
        `[Scheduler] GITORCH_RECONCILIACAO_CADENCIA_MS inválido ('${bruto}'); ` +
          `usando o padrão de ${CADENCIA_PADRAO_DA_RECONCILIACAO_MS}ms`
      )
      return CADENCIA_PADRAO_DA_RECONCILIACAO_MS
    }
    return lido
  })()

  /**
   * Enquanto SOBRAR fila, a próxima varredura sai num doze avos da cadência —
   * cinco minutos, no padrão de uma hora.
   *
   * Medido em 22/08/2026: mil novecentas e setenta e oito vagas sem dono. Na
   * hora cheia, mesmo com o teto novo de duzentas por rodada, esvaziar isso
   * levaria dez horas. Acelerando enquanto há fila, leva menos de uma — e,
   * assim que a fila acaba, a cadência volta sozinha, sem ninguém desligar
   * nada.
   *
   * Só acelera quando a varredura AFIRMA que sobrou fila. Varredura abortada
   * (fornecedor mudo, banco mudo, banco vazio suspeito) nunca acelera: ali não
   * se sabe nada, e insistir de cinco em cinco minutos seria martelar um
   * serviço que já não está respondendo.
   */
  const CADENCIA_COM_FILA_MS = Math.max(1, Math.floor(CADENCIA_DA_RECONCILIACAO_MS / 12))

  /**
   * A primeira varredura não sai no tique zero: espera o mesmo intervalo da
   * cadência acelerada.
   *
   * Duas razões, e a segunda foi encontrada por um teste que quebrou: logo
   * depois de subir, o processo ainda está assentando e uma listagem ali só
   * gasta cota; e disparar no tique zero fazia a vigília pré-merge — que
   * promete não tocar o fornecedor quando não tem o que perguntar — passar a
   * tocar, por carona nesta varredura.
   *
   * Derivar da cadência acelerada, em vez de fixar cinco minutos, resolve o
   * outro extremo: um serviço que reinicia com frequência nunca chegaria à
   * primeira varredura se a espera fosse o intervalo inteiro — a limpeza
   * jamais aconteceria, que é o problema que ela veio resolver.
   */
  const ESPERA_ANTES_DA_PRIMEIRA_VARREDURA_MS = CADENCIA_COM_FILA_MS

  let ultimaReconciliacao =
    Date.now() - (CADENCIA_DA_RECONCILIACAO_MS - ESPERA_ANTES_DA_PRIMEIRA_VARREDURA_MS)
  let cadenciaDaReconciliacao = CADENCIA_DA_RECONCILIACAO_MS
  const reconciliarVagasDoDev = async (): Promise<void> => {
    const agora = new Date()
    if (agora.getTime() - ultimaReconciliacao < cadenciaDaReconciliacao) return
    ultimaReconciliacao = agora.getTime()

    // Uma varredura POR CONTA (BYOK, D34): cada conta do fornecedor enxerga só
    // as próprias sessões, então cruzar a lista de uma conta contra as linhas
    // vivas de todas marcaria como órfã a sessão viva de outro cliente — e a
    // arquivaria, matando trabalho em andamento que alguém está pagando.
    // A conta da instância (`null`) entra sempre; as dos clientes, quando
    // existem, vêm do banco.
    const contas: Array<string | null> = [null, ...(await contasDeClienteComCredencial())]

    let sobrouFila = false
    for (const conta of contas) {
      const apiKey = await chaveDaConta(conta)
      if (!apiKey) continue

      const relatorio = await varrerVagasVazadas({
        listarNoFornecedor: () => listarSessoesJules({ apiKey, onWarn: (m) => app.log.warn(m) }),
        vivasNoBanco: () =>
          nomesDeSessoesVivasDaInstancia({
            prisma: app.prisma as unknown as PrismaDevSession,
            devAccountId: conta,
          }),
        arquivarNoFornecedor: (sessionName) =>
          arquivarSessaoJules({ apiKey, sessionName, onWarn: (m) => app.log.warn(m) }),
        agora,
        onWarn: (m) => app.log.warn(m),
      })

      if (relatorio.atingiuOTeto) sobrouFila = true

      if (relatorio.arquivadas > 0 || relatorio.orfas > 0) {
        app.log.info(
          `[Scheduler] reconciliação de vagas (${conta ?? 'conta da instância'}): ` +
            `${relatorio.examinadas} ativas no fornecedor, ` +
            `${relatorio.orfas} sem dono aqui, ${relatorio.arquivadas} devolvidas` +
            (relatorio.atingiuOTeto ? ' — ainda há fila, volto em 5 min' : '')
        )
      }
    }

    // Sobrou fila em qualquer conta: volta em cinco minutos. Acabou (ou não deu
    // para saber): volta à hora cheia.
    cadenciaDaReconciliacao = sobrouFila ? CADENCIA_COM_FILA_MS : CADENCIA_DA_RECONCILIACAO_MS
  }

  /**
   * As contas de cliente que têm credencial utilizável agora.
   *
   * Conta sem credencial fica de fora de propósito: sem chave não há o que
   * consultar nem o que arquivar naquela conta, e insistir só produziria
   * chamada que volta 401 a cada hora.
   */
  const contasDeClienteComCredencial = async (): Promise<string[]> => {
    const linhas = await app.prisma.project.findMany({
      where: { devAccountId: { not: null }, encryptedDevApiKey: { not: null } },
      select: { devAccountId: true },
      distinct: ['devAccountId'],
    })
    return linhas.map((l) => l.devAccountId).filter((c): c is string => typeof c === 'string')
  }

  /**
   * A vaga que o dev externo levou e nunca devolveu.
   *
   * Medido em 24/08: dezenove linhas vivas, SETE paradas havia noventa horas,
   * contra um teto de quinze simultâneas. A folga ia a zero e o SM respondia
   * "voltou vazio" com dezenas de tarefas prontas esperando — a esteira
   * inteira parada por vaga ocupada por trabalho já morto.
   *
   * Roda junto da reconciliação de vagas porque são defeitos irmãos e
   * correções diferentes: lá a vaga não tem sessão nenhuma do outro lado; aqui
   * a sessão existe, e o dev é que nunca a conclui.
   */
  const devolverVagasDeSessaoAbandonada = async (): Promise<void> => {
    const agora = new Date()
    const linhas = await linhasVivasParaJulgarAbandono({
      prisma: app.prisma as unknown as PrismaDevSession,
    })
    const abandonadas = sessoesAbandonadas({ linhas, agora })
    if (abandonadas.length === 0) return

    for (const linha of abandonadas) {
      try {
        // A chave é da conta em que a sessão NASCEU (BYOK, D34), lida linha a
        // linha: uma varredura só, com a chave do dono, arquivaria errado toda
        // sessão de cliente com conta própria.
        const apiKey = await chaveDaSessao(linha.sessionName)
        await fecharSessao({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName: linha.sessionName,
          motivo: 'abandoned',
          agora,
          // Arquivar no fornecedor é o que devolve a vaga LÁ. Sem chave, a
          // linha ainda fecha: a vaga daqui volta, que é o que trava o SM.
          ...(apiKey
            ? {
                arquivarNoFornecedor: (sessionName: string) =>
                  arquivarSessaoJules({ apiKey, sessionName, onWarn: (m) => app.log.warn(m) }),
              }
            : {}),
          onWarn: (m) => app.log.warn(m),
        })
        app.log.info(
          `[Scheduler] sessão abandonada devolvida: ${linha.sessionName} (issue #${linha.issueNumber}) ` +
            'sem progresso além do teto — a vaga voltou para a fila'
        )
      } catch (err) {
        // Uma que não fecha não pode impedir as outras: cada vaga devolvida já
        // destrava a esteira sozinha.
        app.log.warn(
          err,
          `[Scheduler] não deu para devolver a vaga de ${linha.sessionName}; tenta no próximo ciclo`
        )
      }
    }
  }

  /**
   * O CICLO TERMINAL: fecha a sessão que o Jules já CONCLUIU ou FALHOU e cuja
   * linha nunca fechou, devolvendo a issue para a fila (D51 — nunca abandona de
   * vez). Irmã de `devolverVagasDeSessaoAbandonada` (que trata a sessão parada
   * sem terminar). Foi a falta desta que encheu as 15 vagas do gitorch e parou
   * a esteira em 29/08 — 21 de 23 sessões estavam em COMPLETED/FAILED.
   */
  /**
   * A análise de "por que o Jules falhou 2× nesta issue" (D51). Roda junto do
   * RA na agenda. Best-effort: nunca lança para fora — o RA tem outro trabalho.
   */
  const rodarAnaliseDeFalhasDoRa = async (
    project: { id: string; wingId: string },
    railsToken: string | undefined,
    execute: StepExecutor
  ): Promise<string> => {
    if (!railsToken) return ''
    const agora = new Date()
    const gh = async (path: string): Promise<unknown> => {
      const resp = await ghComGuarda(`https://api.github.com${path}`, {
        headers: {
          authorization: `token ${railsToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
        },
      })
      if (!resp.ok) throw new Error(`GitHub GET ${path} → ${resp.status}`)
      return resp.json()
    }

    const r = await analisarFalhasPendentes({
      listarPendentes: () =>
        issuesComAnalisePendente({
          prisma: app.prisma as unknown as PrismaDevSession,
          projectId: project.id,
        }),
      dadosDaIssue: async (issueNumber) => {
        const issue = (await gh(`/repos/${project.wingId}/issues/${issueNumber}`)) as {
          title?: string
          body?: string
        }
        const mortas = (await app.prisma.devSession.findMany({
          where: {
            projectId: project.id,
            issueNumber,
            closedReason: {
              in: [
                'dev-concluiu-sem-entrega',
                'dev-falhou',
                'pr-descartado',
                'pr-rejeitado-sem-retomada',
              ],
            },
          },
          select: { sessionName: true, state: true, closedReason: true, pullRequestNumber: true },
          orderBy: { closedAt: 'desc' },
          take: 4,
        })) as Array<{
          sessionName: string
          state: string
          closedReason: string | null
          pullRequestNumber: number | null
        }>
        const sessoesMortas: SessaoMorta[] = []
        const comentariosDeQa: string[] = []
        for (const m of mortas) {
          let ultimaAtividade = `closed as ${m.closedReason}`
          try {
            const apiKey = await chaveDaSessao(m.sessionName)
            if (apiKey) {
              const msg = await ultimaMensagemDoDevJules({ apiKey, sessionName: m.sessionName })
              if (msg) ultimaAtividade = msg.slice(0, 600)
            }
          } catch {
            /* fica com o closedReason */
          }
          sessoesMortas.push({ sessionName: m.sessionName, estado: m.state, ultimaAtividade })
          if (m.pullRequestNumber && comentariosDeQa.length < 3) {
            try {
              const comments = (await gh(
                `/repos/${project.wingId}/issues/${m.pullRequestNumber}/comments?per_page=100`
              )) as Array<{ body?: string }>
              for (const c of comments) {
                if (
                  (c.body ?? '').includes('gitorch:qa') ||
                  (c.body ?? '').includes('needs changes')
                ) {
                  comentariosDeQa.push((c.body ?? '').slice(0, 800))
                }
              }
            } catch {
              /* sem comentário */
            }
          }
        }
        return {
          issueNumber,
          tituloDaIssue: issue.title ?? `#${issueNumber}`,
          corpoDaIssue: issue.body ?? '',
          sessoesMortas,
          comentariosDeQa: comentariosDeQa.slice(0, 3),
        }
      },
      analisar: (entrada) => runAnaliseDeFalha(execute, entrada),
      gravarAprendizado: ({ issueNumber, analise }) =>
        registrarAprendizado({
          prisma: app.prisma as unknown as PrismaEventoDoJules,
          projectId: project.id,
          aprendizado: {
            padrao: analise.padraoDoJules,
            origem: 'analise-2-falhas',
            issueNumber,
            pedidoRevisado: analise.pedidoRevisado,
          },
          onWarn: (m) => app.log.warn(m),
        }),
      marcarFeita: (issueNumber) =>
        marcarAnaliseFeitaDaIssue({
          prisma: app.prisma as unknown as PrismaDevSession,
          projectId: project.id,
          issueNumber,
          agora,
        }),
      onInfo: (m) => app.log.info(`[Scheduler] ${m}`),
      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
    })

    if (r.analisadas.length === 0) return ''
    // UM aviso ao dono por passada, consolidado.
    await avisarDonoDoProjeto(
      project as NotifiableProject & { id: string; wingId: string },
      `GitOrch: ${r.analisadas.length === 1 ? 'a issue' : 'as issues'} ${r.analisadas
        .map((n) => `#${n}`)
        .join(', ')} falharam 2× — entendi o porquê e a 3ª tentativa vai com o pedido corrigido. ` +
        `Padrão aprendido: ${r.padroes[0]?.padrao ?? ''}`
    ).catch(() => undefined)
    return `RA: analisei ${r.analisadas.length} falha(s) repetida(s): ${r.analisadas
      .map((n) => `#${n}`)
      .join(', ')}.`
  }

  /** Repo do produto — onde nascem as issues de encanamento do GitOrch. */
  const REPO_DO_PRODUTO = process.env['GITORCH_SELF_REPO'] ?? 'GitOrchAI/gitorch'

  /**
   * ESTEIRA-T8 (D54): entre o sensor e a delegação existe SEMPRE análise. Roda
   * junto do RA na agenda: varre a infra (Actions/Dependabot), e para cada
   * achado NOVO o RA entende a causa e o PO escreve a issue padrão Shrimp — no
   * repo do cliente (CI/config do cliente) ou em `GitOrchAI/gitorch` +
   * Telegram ao dono (encanamento nosso), NUNCA misturado. Best-effort: nunca
   * lança para fora — o RA tem outro trabalho.
   */
  const rodarProcessamentoDeAchados = async (
    project: NotifiableProject & { id: string; wingId: string },
    railsToken: string | undefined,
    execute: StepExecutor,
    contextBlocks: string[]
  ): Promise<string> => {
    if (!railsToken) return ''

    let achados: AchadoDeInfra[] = []
    try {
      const sensor = await acharIncidentesDeInfra({
        repository: project.wingId,
        githubToken: railsToken,
        onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
      })
      achados = sensor.achados
    } catch (err) {
      app.log.warn(err, `[Scheduler] sensor de infra falhou em ${project.wingId}`)
      return ''
    }
    if (achados.length === 0) return ''

    const ghIssue = async (
      repo: string,
      token: string,
      fields: DoDFields,
      marker: string,
      labels: string[]
    ): Promise<number> => {
      // Defesa em profundidade (revisão de segurança do T8): `repo` já vem de
      // um slug validado (project.wingId / REPO_DO_PRODUTO), mas a credencial
      // vai no cabeçalho — conferir o formato ANTES de montar a URL fecha a
      // porta para um valor que atravesse diretório ou troque de host.
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
        throw new Error(`ghIssue: repositório fora do formato dono/repo (${repo})`)
      }
      const resp = await ghComGuarda(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          authorization: `token ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: fields.titulo,
          // Sem peso: o achado do sensor de infra não passou pelo roteiro do
          // PO e ninguém o estimou.
          body: renderIssueBody(fields, marker, null),
          labels,
        }),
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        throw new Error(`POST /repos/${repo}/issues → ${resp.status}: ${detail.slice(0, 150)}`)
      }
      const issue = (await resp.json()) as { number?: number }
      if (!issue.number) throw new Error(`issue criada em ${repo} sem número`)
      return issue.number
    }

    const guiaDoDev = guiaCuradoDoJules()
    const aprendidos = await lerAprendizados({
      prisma: app.prisma as unknown as PrismaEventoDoJules,
      projectId: project.id,
      onWarn: (m) => app.log.warn(m),
    }).catch(() => [])
    const aprendizados =
      aprendidos.length > 0
        ? `O que já aprendemos sobre como o dev assíncrono falha NESTE projeto:\n${aprendidos
            .map((a) => `- ${a.padrao}`)
            .join('\n')}`
        : ''

    // Token do repo do produto — separado do token do cliente.
    const tokenDoProduto =
      process.env['GITORCH_GITHUB_TOKEN'] ??
      (await mintInstallationToken({
        repository: REPO_DO_PRODUTO,
        onError: (m) => app.log.error(m),
        onWarn: (m) => app.log.warn(m),
      })) ??
      undefined

    const res = await processarAchadosDeInfra({
      achados,
      projectId: project.id,
      repository: project.wingId,
      execute,
      contextBlocks,
      guiaDoDev,
      ...(aprendizados ? { aprendizados } : {}),
      incidentesAbertos: async () =>
        (await app.prisma.infraIncident.findMany({
          where: { projectId: project.id, clearedAt: null },
          select: { identidadeEstavel: true, issueNumber: true },
        })) as Array<{ identidadeEstavel: string; issueNumber: number | null }>,
      criarIssueNoCliente: (fields, achado) =>
        ghIssue(
          project.wingId,
          railsToken,
          fields,
          `gitorch:incident:${achado.identidadeEstavel}`,
          ['gitorch:task', agentLabel('po')]
        ),
      criarIssueNoProduto: (fields, achado) => {
        if (!tokenDoProduto) {
          throw new Error(`sem token para ${REPO_DO_PRODUTO} — issue de encanamento não criada`)
        }
        return ghIssue(
          REPO_DO_PRODUTO,
          tokenDoProduto,
          fields,
          `gitorch:scaffolding:${project.id}:${achado.identidadeEstavel}`,
          ['gitorch:task', agentLabel('po'), 'gitorch:scaffolding']
        )
      },
      avisarDono: async (texto) => {
        await avisarDonoDoProjeto(project, texto)
      },
      registrarIncidente: async ({ classe, identidadeEstavel, issueNumber, titulo }) => {
        await app.prisma.infraIncident.upsert({
          where: {
            projectId_identidadeEstavel: { projectId: project.id, identidadeEstavel },
          },
          create: {
            projectId: project.id,
            classe,
            identidadeEstavel,
            issueNumber,
          },
          update: { issueNumber, lastSeenAt: new Date(), classe },
        })
        app.log.info(
          `[Scheduler] infra_incidents: ${identidadeEstavel} → issue #${issueNumber} (${titulo})`
        )
      },
      onInfo: (m) => app.log.info(`[Scheduler] ${m}`),
      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
    })

    // ESTEIRA-T10: incidentes que escalaram (3 PRs sem resolver) e ainda não
    // tiveram retro — o RA faz um retro blameless para achar a raiz do
    // retrabalho e gravar a regra de coding para o dev.
    const retroOut = await rodarRetroDeIncidentesEscalados(project, railsToken, execute).catch(
      (err) => {
        app.log.warn(err, `[Scheduler] retro de incidentes escalados falhou em ${project.wingId}`)
        return ''
      }
    )

    const total = res.issuesNoCliente.length + res.issuesNoProduto.length
    const base =
      total === 0
        ? ''
        : `RA: ${total} issue(s) de infra escrita(s) — ` +
          `${res.issuesNoCliente.length} no repo do cliente, ${res.issuesNoProduto.length} de encanamento.`
    return [base, retroOut].filter(Boolean).join('\n')
  }

  /**
   * ESTEIRA-T10 (decisão do dono 29/08): incidente que resistiu a 3 PRs → o RA
   * roda um RETRO blameless (não para culpar, para consertar o processo): a
   * issue do PO faltou algo? a análise do RA foi rasa? o critério do QA foi
   * vago? a tarefa era grande demais? A conclusão vira aprendizado + uma regra
   * de coding que o dev passa a receber. Um retro por incidente (marca em
   * `events`, tipo `retro-de-infra`).
   */
  const rodarRetroDeIncidentesEscalados = async (
    project: { id: string; wingId: string },
    railsToken: string | undefined,
    execute: StepExecutor
  ): Promise<string> => {
    if (!railsToken) return ''
    const gh = async (path: string): Promise<unknown> => {
      const resp = await ghComGuarda(`https://api.github.com${path}`, {
        headers: {
          authorization: `token ${railsToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
        },
      })
      if (!resp.ok) throw new Error(`GitHub GET ${path} → ${resp.status}`)
      return resp.json()
    }

    const escalados = (await app.prisma.infraIncident.findMany({
      where: { projectId: project.id, clearedAt: null, escalatedAt: { not: null } },
      select: { id: true, issueNumber: true, classe: true, identidadeEstavel: true },
    })) as Array<{
      id: string
      issueNumber: number | null
      classe: string
      identidadeEstavel: string
    }>
    if (escalados.length === 0) return ''

    let feitos = 0
    for (const inc of escalados.slice(0, 2)) {
      try {
        const jaTemRetro = await app.prisma.event.findFirst({
          where: {
            projectId: project.id,
            type: 'retro-de-infra',
            payload: { path: ['incidenteId'], equals: inc.id },
          },
        })
        if (jaTemRetro || inc.issueNumber === null) continue

        const issue = (await gh(`/repos/${project.wingId}/issues/${inc.issueNumber}`)) as {
          title?: string
          body?: string
        }
        const aprendizados = await lerAprendizados({
          prisma: app.prisma as unknown as PrismaEventoDoJules,
          projectId: project.id,
          issueNumber: inc.issueNumber,
          onWarn: (m) => app.log.warn(m),
        }).catch(() => [])
        const briefDoRa = aprendizados.map((a) => a.padrao).join('\n')

        const retro = await runRetroDeInfra(execute, {
          issueNumber: inc.issueNumber,
          tituloDaIssue: issue.title ?? `#${inc.issueNumber}`,
          corpoDaIssue: issue.body ?? '',
          briefDoRa,
          prsFracassados: [
            {
              numero: 0,
              motivo: 'histórico',
              evidencia: `classe ${inc.classe}, 3 PRs sem resolver`,
            },
          ],
        })

        await registrarAprendizado({
          prisma: app.prisma as unknown as PrismaEventoDoJules,
          projectId: project.id,
          aprendizado: {
            padrao: `${retro.padraoParaMemoria} (raiz: ${retro.raizDoRetrabalho})`,
            origem: 'retro-de-infra',
            issueNumber: inc.issueNumber,
            pedidoRevisado: retro.regraDeCodingParaODev,
          },
          onWarn: (m) => app.log.warn(m),
        }).catch(() => undefined)

        await app.prisma.event.create({
          data: {
            projectId: project.id,
            type: 'retro-de-infra',
            payload: {
              incidenteId: inc.id,
              raiz: retro.raizDoRetrabalho,
              ajuste: retro.ajusteRecomendado,
              regra: retro.regraDeCodingParaODev,
            },
          },
        })
        feitos += 1
        app.log.info(
          `[Scheduler] retro do incidente #${inc.issueNumber}: raiz=${retro.raizDoRetrabalho}`
        )
      } catch (err) {
        app.log.warn(err, `[Scheduler] retro do incidente ${inc.identidadeEstavel} falhou`)
      }
    }
    return feitos > 0 ? `RA: ${feitos} retro(s) de incidente escalado.` : ''
  }

  /**
   * ESTEIRA-T9: um incidente = uma issue = UM PR, e fecha sozinho. Roda na
   * cadência do sensor (wake do SM): para cada `infra_incidents` aberto, relê a
   * ÚLTIMA run do workflow (identidade `wf:<id>`) e o estado do PR; se o
   * workflow ficou verde DEPOIS do conserto (ou o PR do Dependabot mesclou),
   * fecha a issue e marca `cleared_at`. Best-effort — nunca derruba o wake.
   */
  const varrerIncidentesDeInfraResolvidos = async (
    project: { id: string; wingId: string },
    railsToken: string | undefined
  ): Promise<string> => {
    if (!railsToken) return ''
    const gh = async (path: string): Promise<unknown> => {
      const resp = await ghComGuarda(`https://api.github.com${path}`, {
        headers: {
          authorization: `token ${railsToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
        },
      })
      if (!resp.ok) throw new Error(`GitHub GET ${path} → ${resp.status}`)
      return resp.json()
    }
    const ghPatch = async (path: string, body: unknown): Promise<void> => {
      const resp = await ghComGuarda(`https://api.github.com${path}`, {
        method: 'PATCH',
        headers: {
          authorization: `token ${railsToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'gitorch',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(`GitHub PATCH ${path} → ${resp.status}`)
    }

    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () =>
        (await app.prisma.infraIncident.findMany({
          where: { projectId: project.id, clearedAt: null },
          select: {
            id: true,
            projectId: true,
            classe: true,
            identidadeEstavel: true,
            issueNumber: true,
            prNumber: true,
            clearedAt: true,
            prAttempts: true,
            escalatedAt: true,
          },
        })) as Array<{
          id: string
          projectId: string
          classe: string
          identidadeEstavel: string
          issueNumber: number | null
          prNumber: number | null
          clearedAt: Date | null
          prAttempts: number
          escalatedAt: Date | null
        }>,
      // ESTEIRA-T9/T10 (elo que faltava): o número do PR mora na linha da
      // sessão que trabalhou a issue (`dev_sessions.pull_request_number`).
      // Copia para `infra_incidents.pr_number` — sem isto, `situacaoDoIncidente`
      // nunca vê o PR e nada fecha nem escala.
      descobrirPrDoIncidente: async (inc) => {
        if (inc.issueNumber === null) return null
        const sessao = (await app.prisma.devSession.findFirst({
          where: {
            projectId: project.id,
            issueNumber: inc.issueNumber,
            pullRequestNumber: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          select: { pullRequestNumber: true },
        })) as { pullRequestNumber: number | null } | null
        const pr = sessao?.pullRequestNumber ?? null
        if (pr !== null) {
          await app.prisma.infraIncident.update({ where: { id: inc.id }, data: { prNumber: pr } })
        }
        return pr
      },
      situacaoDoIncidente: async (inc) => {
        let prMesclado = false
        let prFechadoSemMerge = false
        let mergedAt: string | null = null
        if (inc.prNumber !== null) {
          try {
            const pr = (await gh(`/repos/${project.wingId}/pulls/${inc.prNumber}`)) as {
              merged?: boolean
              merged_at?: string | null
              state?: string
            }
            prMesclado = pr.merged === true
            mergedAt = pr.merged_at ?? null
            prFechadoSemMerge = pr.state === 'closed' && pr.merged !== true
          } catch {
            /* PR ilegível: trata como não mesclado */
          }
        }
        // Identidade `wf:<id>` → última run desse workflow na branch default.
        let ultimaRunVerde = false
        let rodouDepoisDoPr = false
        const m = inc.identidadeEstavel.match(/^wf:(\d+)$/)
        if (m) {
          try {
            const repo = (await gh(`/repos/${project.wingId}`)) as { default_branch?: string }
            const branch = repo.default_branch ?? 'main'
            const runs = (await gh(
              `/repos/${project.wingId}/actions/workflows/${m[1]}/runs?branch=${encodeURIComponent(branch)}&per_page=1`
            )) as {
              workflow_runs?: Array<{
                conclusion?: string
                run_started_at?: string
                created_at?: string
              }>
            }
            const run = runs.workflow_runs?.[0]
            if (run) {
              ultimaRunVerde = run.conclusion === 'success'
              const runEm = run.run_started_at ?? run.created_at
              rodouDepoisDoPr = Boolean(mergedAt && runEm && runEm > mergedAt)
            }
          } catch {
            /* runs ilegíveis */
          }
        }
        return { ultimaRunVerde, rodouDepoisDoPr, prMesclado, prFechadoSemMerge }
      },
      fecharIssue: async (issueNumber, comentario) => {
        await ghPatch(`/repos/${project.wingId}/issues/${issueNumber}`, {
          state: 'closed',
          state_reason: 'completed',
        })
        await fetch(
          `https://api.github.com/repos/${project.wingId}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: {
              authorization: `token ${railsToken}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'gitorch',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ body: comentario }),
          }
        ).catch(() => undefined)
      },
      limparIncidente: async (id) => {
        await app.prisma.infraIncident.update({
          where: { id },
          data: { clearedAt: new Date() },
        })
      },
      // ESTEIRA-T10: mais um PR fracassou — conta a tentativa e libera o
      // pr_number para uma nova nascer (a menos que escale abaixo).
      incrementarTentativa: async (id) => {
        await app.prisma.infraIncident.update({
          where: { id },
          data: { prAttempts: { increment: 1 }, prNumber: null },
        })
      },
      // 3º PR fracassado: para de insistir + avisa o dono UMA vez (só o marco).
      escalar: async ({ id, issueNumber, motivo }) => {
        await app.prisma.infraIncident.update({ where: { id }, data: { escalatedAt: new Date() } })
        await avisarDonoDoProjeto(
          project as NotifiableProject & { id: string; wingId: string },
          `GitOrch: parei de insistir no incidente de infra${issueNumber ? ` (issue #${issueNumber})` : ''} de ${project.wingId} — ${motivo}. O RA vai fazer um retro para achar a raiz; volta a andar quando isso mudar.`
        ).catch(() => undefined)
      },
      // Incidente RESOLVIDO → vira aprendizado (classe + como sarou) para o
      // RA/PO escreverem incidentes melhores da próxima.
      registrarResolucao: async ({ classe, identidadeEstavel, comoSarou }) => {
        await registrarAprendizado({
          prisma: app.prisma as unknown as PrismaEventoDoJules,
          projectId: project.id,
          aprendizado: {
            padrao: `Incidente de infra (${classe}, ${identidadeEstavel}) resolvido: ${comoSarou}`,
            origem: 'incidente-resolvido',
          },
          onWarn: (mm) => app.log.warn(mm),
        }).catch(() => undefined)
      },
      onInfo: (mm) => app.log.info(`[Scheduler] ${mm}`),
      onWarn: (mm) => app.log.warn(`[Scheduler] ${mm}`),
    })
    const partes: string[] = []
    if (r.fechados.length > 0)
      partes.push(`${r.fechados.length} incidente(s) de infra resolvido(s) e fechado(s)`)
    if (r.escalados.length > 0)
      partes.push(`${r.escalados.length} incidente(s) escalado(s) (3 PRs sem resolver)`)
    return partes.length > 0 ? `SM: ${partes.join('; ')}.` : ''
  }

  /**
   * ESTEIRA-T11: a esteira voltou vazia SÓ porque a conta do dev externo está
   * lotada (trabalho pronto, folga diária, mas nenhuma vaga simultânea). Se
   * isso persiste > `MINUTOS_ATE_ALERTAR_VAGA`, avisa o dono UMA vez por
   * janela — o estado da janela mora em `events` (tipo `aviso-vaga-travada`),
   * sobrevive a redeploy, e some quando a esteira volta a andar.
   */
  const avisarSeTravadaPorVaga = async (
    project: NotifiableProject & { id: string; wingId: string },
    travadaAgora: boolean
  ): Promise<void> => {
    const ultimo = (await app.prisma.event.findFirst({
      where: { projectId: project.id, type: 'aviso-vaga-travada' },
      orderBy: { createdAt: 'desc' },
    })) as { payload: unknown } | null
    const p = (ultimo?.payload ?? {}) as { desde?: string | null; avisado?: boolean }
    const estado: EstadoDaJanela = {
      desde: p.desde ? new Date(p.desde) : null,
      avisado: p.avisado === true,
    }

    const agora = new Date()
    const decisao = decidirAvisoPorJanela(estado, travadaAgora, agora, MINUTOS_ATE_ALERTAR_VAGA)

    // Só grava quando o estado MUDA (começou / avisou / limpou) — não a cada
    // acordada. Assim `events` não cresce à toa.
    const mudou =
      (estado.desde?.toISOString() ?? null) !== (decisao.novoEstado.desde?.toISOString() ?? null) ||
      estado.avisado !== decisao.novoEstado.avisado
    if (mudou) {
      await app.prisma.event.create({
        data: {
          projectId: project.id,
          type: 'aviso-vaga-travada',
          payload: {
            desde: decisao.novoEstado.desde?.toISOString() ?? null,
            avisado: decisao.novoEstado.avisado,
          },
        },
      })
    }

    if (decisao.deveAvisar) {
      await avisarDonoDoProjeto(
        project as NotifiableProject & { id: string; wingId: string },
        `GitOrch: a esteira de ${project.wingId} está parada há ${decisao.minutosNoProblema} min — há tarefas prontas, mas a conta do dev assíncrono está com todas as vagas ocupadas. Volta a andar sozinha quando uma sessão terminar; se for urgente, dá para subir o teto ou encerrar uma sessão travada.`
      ).catch(() => undefined)
    }
  }

  const varrerCicloTerminalDaSessao = async (): Promise<void> => {
    const agora = new Date()
    const linhas = await linhasVivasParaCicloTerminal({
      prisma: app.prisma as unknown as PrismaDevSession,
    })
    if (linhas.length === 0) return

    // Token de GitHub por PROJETO, resolvido uma vez — `situacaoDoPr` pode ser
    // chamado várias vezes para o mesmo projeto.
    const projetosPorId = new Map(
      (
        await app.prisma.project.findMany({
          where: { id: { in: [...new Set(linhas.map((l) => l.projectId))] } },
          select: { id: true, wingId: true, name: true, userId: true },
        })
      ).map((p) => [p.id, p])
    )
    const tokenPorProjeto = new Map<string, string | undefined>()
    const tokenDoProjeto = async (projectId: string): Promise<string | undefined> => {
      if (tokenPorProjeto.has(projectId)) return tokenPorProjeto.get(projectId)
      const proj = projetosPorId.get(projectId)
      const t = proj
        ? (process.env['GITORCH_GITHUB_TOKEN'] ??
          (await mintInstallationToken({
            repository: proj.wingId,
            onError: (m) => app.log.error(m),
            onWarn: (m) => app.log.warn(m),
          })) ??
          undefined)
        : undefined
      tokenPorProjeto.set(projectId, t)
      return t
    }

    const projetoDaIssue = (n: number): string | undefined =>
      linhas.find((l) => l.issueNumber === n)?.projectId

    const resultado = await executarCicloTerminal({
      listarLinhas: async () => linhas,
      situacaoDoPr: async ({ linha, numeroDoPr }) => {
        if (numeroDoPr === null) return 'sem-pr'
        const proj = projetosPorId.get(linha.projectId)
        const token = await tokenDoProjeto(linha.projectId)
        if (!proj || !token) return null // sem como ler — fica para o próximo ciclo
        const gh = async (path: string): Promise<unknown> => {
          const resp = await ghComGuarda(`https://api.github.com${path}`, {
            headers: {
              authorization: `token ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'gitorch',
            },
          })
          if (!resp.ok) throw new Error(`GitHub GET ${path} → ${resp.status}`)
          return resp.json()
        }
        const pr = (await gh(`/repos/${proj.wingId}/pulls/${numeroDoPr}`)) as {
          state?: string
          merged?: boolean
          merged_at?: string | null
        }
        if (pr.merged || pr.merged_at) return 'mesclado'
        if (pr.state === 'closed') return 'fechado-sem-merge'
        // Aberto: reprovado por nós? A régua de tempo é de `decidirSessaoTerminal`.
        const reviews = (await gh(
          `/repos/${proj.wingId}/pulls/${numeroDoPr}/reviews?per_page=100`
        )) as Array<{ state?: string; user?: { login?: string } }>
        const reprovadoPorNos = reviews.some(
          (rev) =>
            rev.state === 'CHANGES_REQUESTED' &&
            (rev.user?.login ?? '').toLowerCase().includes('gitorch')
        )
        return reprovadoPorNos ? 'aberto-rejeitado-parado' : 'aberto-vivo'
      },
      fecharSessao: async ({ linha, motivo }) => {
        const apiKey = await chaveDaSessao(linha.sessionName)
        await fecharSessao({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName: linha.sessionName,
          motivo,
          agora,
          ...(apiKey
            ? {
                arquivarNoFornecedor: (sessionName: string) =>
                  arquivarSessaoJules({ apiKey, sessionName, onWarn: (m) => app.log.warn(m) }),
              }
            : {}),
          onWarn: (m) => app.log.warn(m),
        })
      },
      pedirAnalise: async ({ linha }) => {
        // T4 liga a missão real (`ra-analise-falha`) + `marcarAnaliseFeita`.
        // Por enquanto: a issue já volta para a fila (o motivo redelega); só
        // registra que uma análise deveria ter rodado.
        app.log.info(
          `[Scheduler] ciclo-terminal: issue #${linha.issueNumber} de ${linha.projectId} ` +
            'falhou 2x — análise pendente (T4)'
        )
      },
      agora,
      onInfo: (m) => app.log.info(`[Scheduler] ${m}`),
      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
    })

    // UM aviso por projeto, nunca um por sessão (o dono já reclamou de spam).
    const todasAsIssues = [...resultado.issuesRedelegadas, ...resultado.issuesEmAnalise]
    const porProjeto = new Map<string, number[]>()
    for (const n of todasAsIssues) {
      const pid = projetoDaIssue(n)
      if (pid) porProjeto.set(pid, [...(porProjeto.get(pid) ?? []), n])
    }
    for (const [projectId, issues] of porProjeto) {
      const proj = projetosPorId.get(projectId)
      if (!proj || issues.length === 0) continue
      const lista = issues.map((n) => `#${n}`).join(', ')
      await avisarDonoDoProjeto(
        proj as NotifiableProject & { id: string; wingId: string },
        issues.length === 1
          ? `GitOrch: a entrega da issue ${lista} voltou para a fila — o dev concluiu ou falhou sem uma entrega que mesclasse. A esteira vai tentar de novo.`
          : `GitOrch: ${issues.length} entregas voltaram para a fila (${lista}) — o dev concluiu ou falhou sem entrega que mesclasse. A esteira vai tentar de novo.`
      ).catch(() => undefined)
    }

    const total =
      resultado.fechadasConcluidas +
      resultado.issuesRedelegadas.length +
      resultado.issuesEmAnalise.length
    if (total > 0) {
      app.log.info(
        `[Scheduler] ciclo-terminal: ${resultado.fechadasConcluidas} mescladas, ` +
          `${resultado.issuesRedelegadas.length} de volta à fila, ` +
          `${resultado.issuesEmAnalise.length} para análise, ` +
          `${resultado.mantidas} mantidas, ${resultado.ilegiveis} ilegíveis`
      )
    }
  }

  // O VIGIA DO PULL REQUEST ÓRFÃO — ESTEIRA-L3-T12.
  //
  // A vigia de sessões (`varrerSessoesDoDev`) e o ciclo terminal
  // (`varrerCicloTerminalDaSessao`) só enxergam pull request que tem LINHA VIVA
  // atrás. Quando a sessão morre com o pull request aberto, ele sai do radar das
  // duas — e o SM também não o resgata, porque `escolherParaDelegar` trata
  // "linha fechada com PR" como prova de que a tarefa já foi entregue.
  //
  // Medido no banco em 31/08/2026 (repositório do produto): 18 pull requests
  // abertos, UM com sessão viva (#408), 17 com a sessão fechada como
  // `pr-rejeitado-sem-retomada`/`abandoned`. Um cuidado, dezessete abandonados.
  //
  // POR QUE DEPOIS do ciclo terminal e não antes: é o ciclo terminal que FECHA
  // a linha da sessão que acabou. Rodando depois dele, o conjunto "tem sessão
  // viva" já está atualizado nesta mesma passada — e é justamente esse conjunto
  // que separa o que é da vigia de sessões do que é do vigia do pull request.
  // Rodando antes, um pull request recém-órfão esperaria mais um ciclo.
  const ultimaVarreduraDePrOrfao = new Map<string, number>()

  const varrerPrsOrfaos = async (): Promise<void> => {
    const agora = new Date()
    const projetos = await app.prisma.project.findMany({
      where: { isActive: true },
      select: {
        id: true,
        wingId: true,
        name: true,
        userId: true,
        devPlan: true,
        devAccountId: true,
      },
    })

    for (const projeto of projetos) {
      // Cadência por projeto: a varredura custa uma listagem paginada e duas
      // leituras por candidato. A cada tique (1 min) isso viraria milhares de
      // chamadas por dia contra o repositório do cliente sem nada ter mudado.
      const ultima = ultimaVarreduraDePrOrfao.get(projeto.id) ?? 0
      if (agora.getTime() - ultima < CADENCIA_DA_VARREDURA_MS) continue
      ultimaVarreduraDePrOrfao.set(projeto.id, agora.getTime())

      try {
        const token =
          process.env['GITORCH_GITHUB_TOKEN'] ??
          (await mintInstallationToken({
            repository: projeto.wingId,
            onError: (m) => app.log.error(m),
            onWarn: (m) => app.log.warn(m),
          })) ??
          undefined
        if (!token) {
          app.log.warn(`[Scheduler] vigia-do-pr: sem token para ${projeto.wingId}; pula a passada`)
          continue
        }

        // As linhas do projeto: a viva diz de quem é o pull request AGORA, e as
        // fechadas dizem qual tarefa originou cada pull request.
        const linhas = await app.prisma.devSession.findMany({
          where: { projectId: projeto.id, pullRequestNumber: { not: null } },
          select: { pullRequestNumber: true, issueNumber: true, closedAt: true },
          orderBy: { id: 'desc' },
        })
        const prsComSessaoViva = new Set<number>(
          linhas.filter((l) => l.closedAt === null).map((l) => l.pullRequestNumber as number)
        )
        const issuePorPr = new Map<number, number>()
        for (const l of linhas) {
          const n = l.pullRequestNumber as number
          if (!issuePorPr.has(n)) issuePorPr.set(n, l.issueNumber)
        }

        const resumo = await vigiarPrsOrfaos({
          listarPrsAbertos: () =>
            listarPrsAbertosParaOVigia({
              repo: projeto.wingId,
              // A porta de saída de rede do relógio, já com o token do projeto
              // amarrado — a leitura do vigia passa pelos MESMOS teto e guarda
              // de autonomia que o resto das chamadas ao GitHub daqui.
              ghGet: (caminho) => ghGet(caminho, token),
              prsComSessaoViva,
              agora,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          prsComSessaoViva,
          issueDoPr: (n) => issuePorPr.get(n) ?? null,
          issueAberta: async (issueNumber) => {
            const issue = (await ghGet(
              `/repos/${projeto.wingId}/issues/${issueNumber}`,
              token
            )) as { state?: string }
            return issue.state === 'open'
          },
          // O TETO VIVE NOS PRÓPRIOS EVENTOS que o vigia grava. Sem coluna
          // nova, sem migração — e sem teto mudo: a contagem é feita pelo
          // banco, sobre a população inteira, e não sobre uma janela recente
          // que calaria depois de N eventos.
          acoesAnteriores: (numeroDoPr) =>
            app.prisma.event.count({
              where: {
                projectId: projeto.id,
                type: 'audit',
                payload: { path: ['vigiaDoPr', 'numeroDoPr'], equals: numeroDoPr },
              },
            }),
          // O teto de sessões simultâneas é da CONTA do dev, não deste
          // caminho. Estourá-lo por fora faria a delegação normal — a que tira
          // tarefa da fila — passar a ser recusada por culpa do vigia.
          vagasLivres: Math.max(
            0,
            tetosDoPlanoDoDev(projeto.devPlan).tetoConcorrentes -
              (await app.prisma.devSession.count({
                where: {
                  devAccountId: projeto.devAccountId ?? null,
                  closedAt: null,
                  state: { notIn: [...ESTADOS_TERMINAIS] },
                },
              }))
          ),
          abrirSessaoDeConserto: ({ numeroDoPr, issueNumber, pedido, branchDoPr }) =>
            abrirSessaoDeConsertoDoPr({ projeto, numeroDoPr, issueNumber, pedido, branchDoPr }),
          // FECHA e só então comenta — a ordem é a correção do ACHADO 4 e vive
          // em `fecharPrDoVigia`, onde dá para provar por teste.
          fecharPr: ({ numero, motivo }) =>
            fecharPrDoVigia({
              repo: projeto.wingId,
              numero,
              motivo,
              ghSend: (metodo, caminho, corpo) => ghSend(metodo, caminho, token, corpo),
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          avisarDono: (texto) =>
            avisarDonoDoProjeto(
              projeto as NotifiableProject & { id: string; wingId: string },
              texto
            ),
          registrarDecisao: async ({ numeroDoPr, acao, texto }) => {
            // `type: 'audit'` é o ÚNICO que a linha do tempo do dono lê
            // (`GET /api/v1/painel/timeline`, painel.ts). `payload.texto` é o
            // que ela renderiza; `payload.vigiaDoPr` viaja ao lado, invisível
            // para a tela e legível para o teto acima.
            await app.prisma.event.create({
              data: {
                projectId: projeto.id,
                type: 'audit',
                payload: { texto, vigiaDoPr: { numeroDoPr, acao } },
              },
            })
          },
          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
          onInfo: (m) => app.log.debug(`[Scheduler] ${m}`),
        })
        app.log.info(`[Scheduler] ${projeto.wingId}: ${resumo}`)
      } catch (err) {
        app.log.warn(err, `[Scheduler] vigia-do-pr falhou em ${projeto.wingId}; tenta na próxima`)
      }
    }
  }

  /**
   * Abre sessão NOVA no dev assíncrono para consertar um pull request órfão.
   *
   * RESERVA PRIMEIRO, pelo mesmo motivo da delegação normal: o índice único
   * parcial (`dev_sessions_open_per_issue`) é quem decide o vencedor quando
   * duas passadas tentam a mesma tarefa ao mesmo tempo. Reservar antes de
   * gastar cota evita nascer uma sessão lá fora que não pode ser guardada aqui.
   */
  const abrirSessaoDeConsertoDoPr = async (args: {
    projeto: { id: string; wingId: string; devAccountId?: string | null }
    numeroDoPr: number
    issueNumber: number
    pedido: string
    /** O ramo do pull request. Nunca a principal — ver abaixo. */
    branchDoPr: string
  }): Promise<boolean> => {
    const reserva = await abrirSessao({
      prisma: app.prisma as unknown as PrismaDevSession,
      projectId: args.projeto.id,
      issueNumber: args.issueNumber,
      sessionName: nomeDaReserva(args.projeto.id, args.issueNumber),
      agora: new Date(),
      devAccountId: args.projeto.devAccountId ?? null,
    })
    if (!reserva.ok) {
      app.log.info(
        `[Scheduler] vigia-do-pr: a tarefa #${args.issueNumber} já tem sessão viva; ` +
          `o #${args.numeroDoPr} espera`
      )
      return false
    }

    const liberar = async (): Promise<void> => {
      await app.prisma.devSession.updateMany({
        where: {
          projectId: args.projeto.id,
          issueNumber: args.issueNumber,
          sessionName: { startsWith: PREFIXO_DA_RESERVA },
          closedAt: null,
        },
        data: { closedAt: new Date(), closedReason: 'failed_final' },
      })
    }

    // O RAMO DO PULL REQUEST NOS DOIS CAMPOS — ACHADO 1 do QA.
    //
    // A versão reprovada mandava `startingBranch: 'main'`. Uma sessão que parte
    // da principal não vê o trabalho do dev (que está no ramo dele) e, com
    // `AUTO_CREATE_PR`, termina abrindo um SEGUNDO pull request: o órfão
    // continua órfão e o cliente ganha uma entrega duplicada. A ação que dá
    // nome à tarefa não retomava nada.
    //
    // `startingBranch` faz a sessão NASCER no ramo do pull request;
    // `workingBranch` faz o resultado VOLTAR para o mesmo ramo, que é o que
    // atualiza a entrega existente em vez de criar outra. Os dois campos foram
    // conferidos ao vivo contra a API em 31/08/2026 (ver `jules-client.ts`), e
    // não há um terceiro modo de automação: o enum tem só
    // AUTOMATION_MODE_UNSPECIFIED (nenhuma automação, o trabalho não sai da
    // sessão) e AUTO_CREATE_PR.
    //
    // Nunca cai na principal: quando o vigia não tem ramo utilizável ele nem
    // chega aqui — a decisão vira `escalar` no portão 11.
    const criada = await criarSessaoJules({
      apiKey: (await chaveDoDevDoProjeto(args.projeto.id)) ?? undefined,
      repository: args.projeto.wingId,
      startingBranch: args.branchDoPr,
      workingBranch: args.branchDoPr,
      titulo: `Destravar o pull request #${args.numeroDoPr} (tarefa #${args.issueNumber})`,
      prompt: args.pedido,
      onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
    })
    if (criada.situacao !== 'criada') {
      await liberar()
      return false
    }

    const trocou = await app.prisma.devSession.updateMany({
      where: {
        projectId: args.projeto.id,
        issueNumber: args.issueNumber,
        sessionName: { startsWith: PREFIXO_DA_RESERVA },
        closedAt: null,
      },
      data: { sessionName: criada.sessionName, pullRequestNumber: args.numeroDoPr },
    })
    if (trocou.count === 0) {
      // A reserva sumiu debaixo dos pés (outra passada a fechou). A sessão
      // nasceu lá fora e não tem linha aqui: desfaz, senão a vaga fica presa
      // na conta do cliente para sempre.
      await arquivarSessaoJules({
        apiKey: (await chaveDoDevDoProjeto(args.projeto.id)) ?? undefined,
        sessionName: criada.sessionName,
        onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
      })
      return false
    }
    return true
  }

  // A RETROSPECTIVA — a única parte do método que olha para trás.
  //
  // O evento já estava escrito e nunca tinha sido ligado: o playbook
  // `packages/cadence/playbooks/events/sprint-retro.md` existe completo, o
  // tipo `CadenceEvent` já inclui 'sprint-retro', e o playbook nomeia as
  // medidas certas. Mas `loadEventPlaybook('sprint-retro')` só era chamado num
  // teste, e a agenda padrão de um projeto só tinha ra, po, sm e qa.
  //
  // O efeito é que o ciclo só olhava para frente. Uma entrega falhava, o QA
  // reprovava, e nada daquilo mudava o ciclo seguinte — nem o pedido ao dev,
  // nem o critério de aceitação, nem a cadência. Cada falha morria isolada, e
  // os números pioravam sem ninguém olhar.
  //
  // POR QUE ROTINA DO RELÓGIO E NÃO UM QUINTO PAPEL: a retrospectiva não
  // decide nada que precise de julgamento — ela CONTA. Transformá-la em agente
  // traria motor, cota e a chance de alucinar um número; como rotina ela é
  // determinística, reproduzível e não gasta vaga do teto do dia. A decisão de
  // COMO consertar continua com quem já a toma; o que a cerimônia entrega é o
  // número.
  //
  // POR PROJETO, e não da instância inteira: sprint é de um projeto, e o dono
  // que precisa ouvir o resultado é o dono daquele projeto. É também o que as
  // tabelas já modelam — missão e evento pertencem a um projeto.
  //
  // Semanal: uma cerimônia que reclama todo dia vira ruído que ninguém lê.
  const CADENCIA_DA_RETROSPECTIVA_MS = 7 * 24 * 60 * 60 * 1000
  const TETO_DE_LINHAS_DA_RETROSPECTIVA = 5000
  const TIPO_DA_RETROSPECTIVA = 'ceremony-retro'

  const rodarRetrospectiva = async (): Promise<void> => {
    const agora = new Date()
    const desde = new Date(agora.getTime() - CADENCIA_DA_RETROSPECTIVA_MS)

    const projetos = await app.prisma.project.findMany({
      where: { isActive: true },
      select: { id: true, wingId: true, userId: true, user: { select: { email: true } } },
    })

    for (const projeto of projetos) {
      // QUANDO FOI A ÚLTIMA? A resposta vem do BANCO, não da memória do
      // processo.
      //
      // A primeira versão guardava a data numa variável inicializada no
      // registro do plugin. Com cadência semanal e um serviço que reinicia
      // várias vezes por dia — quatro vezes só hoje —, o relógio zerava antes
      // de a semana passar e a cerimônia NUNCA rodaria: compilando, com teste
      // verde, e sem executar uma vez sequer. Retroagir a inicialização, que
      // foi o conserto na reconciliação de vagas, aqui trocaria "nunca" por
      // "a cada reinício", igualmente inútil numa cerimônia semanal.
      const ultima = await app.prisma.event.findFirst({
        where: { projectId: projeto.id, type: TIPO_DA_RETROSPECTIVA },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      if (ultima && agora.getTime() - ultima.createdAt.getTime() < CADENCIA_DA_RETROSPECTIVA_MS) {
        continue
      }

      const [sessoes, missoes] = await Promise.all([
        app.prisma.devSession.findMany({
          // A janela pega quem NASCEU ou quem FECHOU dentro dela.
          //
          // Filtrar só por nascimento deixava invisível para sempre a sessão
          // que atravessa a virada da semana — e são justamente as demoradas,
          // as que mais precisaram de empurrão, que atravessam. O retrato
          // ficaria sistematicamente mais bonito que a realidade, excluindo os
          // piores casos por acidente de calendário.
          where: {
            projectId: projeto.id,
            OR: [{ createdAt: { gte: desde } }, { closedAt: { gte: desde } }],
          },
          select: { closedReason: true, nudges: true, createdAt: true, closedAt: true },
          take: TETO_DE_LINHAS_DA_RETROSPECTIVA,
        }),
        app.prisma.mission.findMany({
          where: { projectId: projeto.id, createdAt: { gte: desde } },
          select: { type: true, result: true },
          // Medido: 762 missões por semana neste banco. O teto é folga de seis
          // vezes e existe para o dia em que a esteira acelerar — ler a semana
          // inteira sem limite é o tipo de consulta que cresce em silêncio até
          // derrubar o processo.
          take: TETO_DE_LINHAS_DA_RETROSPECTIVA,
        }),
      ])

      const retrato = medirRetrospectiva({
        sessoes: sessoes as unknown as Parameters<typeof medirRetrospectiva>[0]['sessoes'],
        missoes: missoes.map((m: { type: string; result: unknown }) => ({
          type: m.type,
          noOp: (m.result as { noOp?: boolean } | null)?.noOp === true,
        })),
        fim: agora,
      })

      const melhoria = escolherAMelhoria(retrato)

      // A marca é gravada nos DOIS desfechos: uma semana sem dados também é
      // uma semana em que a cerimônia aconteceu. Sem isso, um período vazio
      // faria a retrospectiva tentar de novo a cada tique.
      await app.prisma.event.create({
        data: {
          projectId: projeto.id,
          type: TIPO_DA_RETROSPECTIVA,
          payload: retrato as unknown as object,
          ...(melhoria ? { metadata: melhoria as unknown as object } : {}),
        },
      })

      if (retrato.semDados) {
        app.log.info(
          `[Scheduler] retrospectiva de ${projeto.wingId}: sem dados no período; nada a relatar`
        )
        continue
      }

      app.log.info(
        `[Scheduler] retrospectiva de ${projeto.wingId}: ${retrato.entregasMescladas} entregues, ` +
          `${retrato.entregasAbandonadas} abandonadas, ` +
          `${retrato.sessoesQuePrecisaramDeEmpurrao} precisaram de empurrão` +
          (melhoria ? ` — melhoria escolhida: ${melhoria.area}` : ' — nada a melhorar')
      )

      // Período saudável não vira recado. Inventar melhoria quando está tudo
      // bem é o jeito mais rápido de a cerimônia virar ruído.
      if (!melhoria) continue

      await avisarDonoDoProjeto(
        projeto,
        `GitOrch — retrospectiva da semana em ${projeto.wingId}: ` +
          `${retrato.entregasMescladas} entregas chegaram e ${retrato.entregasAbandonadas} foram ` +
          `abandonadas. O que mais atrapalhou foi ${melhoria.area}. ${melhoria.porque}`
      )
    }
  }

  const varrerSessoesDoDev = async (): Promise<void> => {
    let projetosComSessao: Array<{ projectId: string }>
    try {
      projetosComSessao = await app.prisma.devSession.findMany({
        where: { closedAt: null },
        distinct: ['projectId'],
        select: { projectId: true },
      })
    } catch (err) {
      app.log.error(err, '[Scheduler] vigia não conseguiu listar sessões vivas')
      return
    }
    if (projetosComSessao.length === 0) return

    for (const { projectId } of projetosComSessao) {
      try {
        // O aviso é do DONO do projeto — a sessão abandonada é dele. Mesma
        // resolução usada no wake do SM: sem vínculo, ninguém é avisado, e o
        // projeto de um cliente nunca vira mensagem no chat de outro.
        const projeto = await app.prisma.project.findUnique({ where: { id: projectId } })
        if (!projeto) continue
        const notifyChatId = await resolveNotifyChatId(app.prisma, projeto, {
          instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
          instanceChatId:
            process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
        })
        const notify = buildTelegramNotifier({
          botToken: process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
          ...(notifyChatId ? { chatId: notifyChatId } : {}),
        })
        // Vigia da esteira (Fase 2): lê o estado de cada sessão VIVA do dev
        // assíncrono no serviço externo e age — sem isso a Fase 1
        // (dev-session-store) só guarda a ligação issue↔sessão↔PR e ninguém
        // nunca a lê de volta. Mesmo wake do SM porque ele é o dono da
        // esteira; best-effort como o sensor acima — falha aqui não pode
        // derrubar a delegação nem o watchdog.
        const sessoesDoProjeto = await sessoesVivas({
          prisma: app.prisma as unknown as PrismaDevSession,
          projectId,
        })
        // BYOK (D34): a chave é da conta em que CADA sessão nasceu, e não uma
        // chave só fixada para o loop inteiro. Uma conta só faria toda consulta,
        // aprovação de plano e pedido de retomada de cliente com conta própria
        // voltar 404: a vigília leria "sem avanço" numa sessão que está
        // progredindo e a trataria como abandonada.
        //
        // A conta vem das linhas JÁ lidas acima — nada de uma consulta por
        // callback, que multiplicaria idas ao banco por sessão e por tique.
        const contaDaSessao = new Map(
          sessoesDoProjeto.map((linha) => [linha.sessionName, linha.devAccountId ?? null])
        )
        const chaveDaLinha = (sessionName: string): Promise<string | undefined> =>
          chaveDaConta(contaDaSessao.get(sessionName) ?? null)
        const vigiaOut = await vigiarSessoes({
          sessoes: sessoesParaVigiaPreMerge(sessoesDoProjeto),
          consultarSessao: async (sessionName) =>
            consultarSessaoJules({
              apiKey: await chaveDaLinha(sessionName),
              sessionName,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          ultimaMensagem: async (sessionName) =>
            ultimaMensagemDoDevJules({
              apiKey: await chaveDaLinha(sessionName),
              sessionName,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          aprovarPlano: async (sessionName) =>
            aprovarPlanoJules({
              apiKey: await chaveDaLinha(sessionName),
              sessionName,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          pedirParaContinuar: async (sessionName) =>
            responderSessaoJules({
              apiKey: await chaveDaLinha(sessionName),
              sessionName,
              texto:
                'Please continue working on this task from where you left off. If you are ' +
                'blocked on something, explain what is blocking you instead of stopping silently.',
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          // Nunca chama motor direto: passa pelo MESMO portão de
          // concorrência, orçamento diário por plano e guarda de gasto que
          // o resto do scheduler usa — é o `triggerAgentMission` de sempre.
          // UMA acordada por papel e projeto nesta passada. A vigília percorre
          // sessão por sessão e chamava isto de dentro do laço: com N sessões
          // trazendo novidade saíam N missões de QA idênticas — medido em
          // 26/08, duas por passada e num tique QUATRO, todas devolvendo o
          // mesmo "no delegated PR awaiting judgment". A missão de QA não é por
          // sessão: ela já recebe todas as sessões do projeto e julga o
          // conjunto. Além do motor pago em dobro, duas missões simultâneas
          // materializam a MESMA credencial, e com refresh token de uso único
          // (Codex) uma queima a da outra — era o produto derrubando o motor do
          // próprio cliente.
          dispararMissao: umaAcordadaPorCiclo(async (papel, projectIdDaMissao) => {
            void triggerAgentMission(papel, projectIdDaMissao, undefined, 'vigia')
          }),
          registrarEstado: (args) =>
            registrarEstado({ prisma: app.prisma as unknown as PrismaDevSession, ...args }),
          registrarResposta: (args) =>
            registrarResposta({ prisma: app.prisma as unknown as PrismaDevSession, ...args }),
          registrarPr: (args) =>
            registrarPr({ prisma: app.prisma as unknown as PrismaDevSession, ...args }),
          // A reentrega do pedido de retrabalho usa o MESMO canal do aviso
          // original — `sendMessage`, o único que a API oferece.
          reentregarAviso: async ({ sessionName, texto }) =>
            responderSessaoJules({
              apiKey: await chaveDaLinha(sessionName),
              sessionName,
              texto,
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }),
          limparAvisoPendente: ({ sessionName }) =>
            limparAvisoDeRetrabalho({
              prisma: app.prisma as unknown as PrismaDevSession,
              sessionName,
            }),
          contarTentativaDeAviso: ({ sessionName }) =>
            contarTentativaDeAviso({
              prisma: app.prisma as unknown as PrismaDevSession,
              sessionName,
            }),
          fecharSessao: (args) => fecharSessaoEArquivar(args),
          registrarInvestigacao: (args) =>
            registrarInvestigacao({ prisma: app.prisma as unknown as PrismaDevSession, ...args }),
          ...(notify ? { avisarDono: notify } : {}),
          agora: new Date(),
          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
        })
        if (vigiaOut) app.log.info(`[Scheduler] ${vigiaOut}`)
      } catch (vigiaErr) {
        app.log.warn(vigiaErr, `[Scheduler] vigia de sessões falhou no projeto ${projectId}`)
      }
    }
  }

  // Tarefa 17 — a esteira acompanha a publicação e só encerra a sessão com
  // veredito.
  //
  // Leitura mínima do GitHub (GET simples, token no header) — o mesmo
  // formato que `qa-rails-mission.ts`/`sm-delegation.ts` usam para as
  // próprias chamadas, sem depender de nenhum cliente maior.
  //
  // Item 7 (leva B2) + Crítico 1 (leva C): teto explícito, mesmo valor que
  // as outras chamadas ao GitHub deste repositório já usam
  // (`desejo-no-github.ts`, `github-app-token.ts`) — hoje compartilhado por
  // `ghGet` (leitura) E `ghSend` (escrita), abaixo. Sem isto, uma chamada
  // que nunca resolve (rede pendurada, não um erro — um erro já cai no
  // `catch` de `varrerPublicacoes` normalmente) prendia `tickEmAndamento`
  // (a trava contra sobreposição, Importante 8) para SEMPRE: a trava que
  // existe para não deixar duas varreduras rodarem ao mesmo tempo virava,
  // ela mesma, um jeito de travar TODAS as varreduras futuras, sem log
  // nenhum explicando por quê. Com o teto, o pior caso é limitado e
  // provável — o tique eventualmente falha, o `catch` trata, e o próximo
  // tique do relógio (1 min) volta a rodar.
  const TIMEOUT_DE_CHAMADA_GITHUB_MS = 10_000

  const ghGet = async (path: string, githubToken: string): Promise<unknown> => {
    const resp = await ghComGuarda(`https://api.github.com${path}`, {
      headers: {
        authorization: `token ${githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
      },
      signal: AbortSignal.timeout(TIMEOUT_DE_CHAMADA_GITHUB_MS),
    })
    if (!resp.ok) {
      throw new Error(`GitHub GET ${path} failed (${resp.status})`)
    }
    return resp.json()
  }

  // Leva B — a mesma família de `ghGet`, para as DUAS escritas que
  // `resolverEntregaDoBoard` precisa fazer (comentar e fechar a tarefa) sem
  // depender de um cliente maior — mesmo formato que `qa-rails-mission.ts`
  // já usa para as próprias chamadas.
  //
  // Crítico 1 (leva C): `ghGet` ganhou teto explícito na leva B2 (Item 7)
  // exatamente para não prender `tickEmAndamento` para sempre — mas o
  // teto ficou só na LEITURA. `ghSend` é chamado de dentro da MESMA
  // varredura (`resolverEntregaDoBoard`, dentro do laço de
  // `varrerPublicacoes`), e uma escrita pendurada (POST/PATCH que nunca
  // resolve — rede parada, não um erro HTTP) prende a MESMA trava, pela
  // MESMA classe de defeito que a leitura já tinha: o projeto inteiro para
  // de reexaminar QUALQUER sessão, de QUALQUER projeto, sem log nenhum
  // explicando por quê. Reaproveita o MESMO teto que `ghGet` já usa —
  // nenhum motivo para a escrita esperar mais ou menos que a leitura.
  const ghSend = async (
    method: 'POST' | 'PATCH',
    path: string,
    githubToken: string,
    body: unknown
  ): Promise<unknown> => {
    const resp = await ghComGuarda(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${githubToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_DE_CHAMADA_GITHUB_MS),
    })
    if (!resp.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${resp.status})`)
    }
    return resp.json()
  }

  // Crítico 1 (leva C), continuação: auditoria de TODA chamada de rede
  // alcançável pelo tique através da varredura de publicações. `ghGet` e
  // `buscarComGuarda` (teste de ambiente, endereco-seguro.ts) já tinham
  // teto; `buscarComGuarda` usa o próprio (`TIMEOUT_PADRAO_MS`, 15s),
  // pensado para o mundo externo do cliente, não do GitHub — não mexido
  // aqui. Uma TERCEIRA chamada sem teto nenhum foi encontrada:
  // `createCardMover` (board-status.ts), instanciado logo abaixo dentro de
  // `resolverEntregaDoBoard` e chamado tanto no caminho `entregue: true`
  // quanto no `entregue: false` — ou seja, em TODO veredito final. Sem
  // `fetchImpl`, ele cai no `fetch` cru, sem `AbortSignal` nenhum: uma
  // chamada pendurada ali prenderia `tickEmAndamento` pela MESMA classe de
  // defeito que `ghSend` tinha. `createCardMover` já aceita `fetchImpl`
  // como injeção — só faltava usá-la, com o mesmo teto de `ghGet`/`ghSend`.
  //
  // Minor 1 (leva D): a forma antiga daqui era `init?.signal ??
  // AbortSignal.timeout(...)` — o `??` faz o teto nunca ser criado quando
  // já existe um `signal` no `init` do chamador, apagando o piso sempre que
  // alguém passasse um. Nenhum chamador faz isso hoje (latente, não um bug
  // vivo), mas é barato fechar: `fetchComTeto` (fetch-com-teto.ts) combina
  // os dois com `AbortSignal.any` em vez de escolher um. `board-status.ts`
  // (leva D) também passou a embrulhar por conta própria — este wrapper
  // aqui é redundante para `createCardMover`, mas mantido pelo mesmo motivo
  // de `ghGet`/`ghSend`: teto explícito na PRÓPRIA chamada, não só confiado
  // à porta de saída de um módulo vizinho.
  // Era um `fetch` ÚNICO, compartilhado por todos os projetos. Não pode mais
  // ser: a autonomia é POR PROJETO, e um `fetch` só não tem como saber de quem
  // é a chamada que está passando por ele. Virou fábrica — quem vai escrever no
  // quadro de um cliente pede o `fetch` DAQUELE cliente.
  //
  // O nível vai como função e não como valor: o dono pode mudá-lo pelo painel
  // no meio de uma varredura, e a decisão tem que ser a do momento da chamada.
  const fetchDoQuadro = (projetoDaVez: { autonomia?: string | null }) =>
    fetchDoRepositorio({
      nivel: () => projetoDaVez.autonomia,
      timeoutMs: TIMEOUT_DE_CHAMADA_GITHUB_MS,
    })

  // R6 do controlador: o mecanismo de publicação (Tarefa 12) muda raramente
  // mas NÃO é imutável — guardado em memória, por repositório, com validade
  // de uma hora. Sem coluna nova, sem migração: se o processo reinicia,
  // redescobre — custa uma consulta. Vive DENTRO do plugin (não em escopo de
  // módulo) para cada instância do relógio ter o próprio cache, isolado
  // entre testes que registram o plugin mais de uma vez.
  const VALIDADE_DO_CACHE_DE_MECANISMO_MS = 60 * 60_000
  const cacheDeMecanismo = new Map<string, { mecanismo: Mecanismo; expiraEm: number }>()

  /**
   * A chave do dev assíncrono que ESTE projeto usa (BYOK, D34).
   *
   * Decifrada no instante do uso e devolvida por valor, nunca guardada em
   * arquivo nem escrita em log — mesma regra das credenciais dos motores.
   * Recusa em vez de cair calada na conta do dono: gastar a conta de quem não
   * pediu é dinheiro dos outros.
   */
  const chaveDoDevDoProjeto = async (projetoId: string): Promise<string | undefined> => {
    const registro = await app.prisma.project.findUnique({
      where: { id: projetoId },
      select: { encryptedDevApiKey: true },
    })
    const resolvida = resolverCredencialDoDev({
      credencialCifrada: registro?.encryptedDevApiKey ?? null,
      chaveDaInstancia: process.env['JULES_API_KEY'],
      decifrar: decryptCredential,
    })
    if (resolvida.ok) return resolvida.chave
    app.log.warn(`[Scheduler] projeto ${projetoId}: ${recadoDaRecusa(resolvida.motivo)}`)
    return undefined
  }

  /**
   * A chave de uma CONTA específica (BYOK, D34).
   *
   * Sem cair na conta da instância quando a conta é de cliente: uma sessão que
   * nasceu na conta do cliente só pode ser consultada, avisada ou arquivada com
   * a chave DELE. Tentar com a do dono devolve 404 no fornecedor — a vigília
   * passaria a ler "sem avanço" numa sessão que está progredindo, e o
   * arquivamento nunca devolveria a vaga, que ficaria presa para sempre na
   * conta que o cliente paga.
   */
  const chaveDaConta = async (
    devAccountId: string | null | undefined
  ): Promise<string | undefined> => {
    // Conta da instância: é a do dono, no ambiente.
    if (!devAccountId) return process.env['JULES_API_KEY']

    const dono = await app.prisma.project.findFirst({
      where: { devAccountId, encryptedDevApiKey: { not: null } },
      select: { encryptedDevApiKey: true },
    })
    const resolvida = resolverCredencialDoDev({
      credencialCifrada: dono?.encryptedDevApiKey ?? null,
      // De propósito sem recuo para a chave da instância.
      chaveDaInstancia: null,
      decifrar: decryptCredential,
    })
    if (resolvida.ok) return resolvida.chave
    app.log.warn(
      `[Scheduler] conta ${devAccountId} do dev assíncrono sem credencial utilizável: ` +
        `${recadoDaRecusa(resolvida.motivo)} — as sessões abertas nela ficam sem acompanhamento até religar`
    )
    return undefined
  }

  /**
   * A chave da conta em que ESTA sessão nasceu.
   *
   * A conta do PROJETO não serve aqui: ela muda quando o cliente conecta,
   * troca ou desconecta a dele, e a sessão continua existindo lá fora na conta
   * antiga. Quem manda é o carimbo da linha.
   */
  const chaveDaSessao = async (sessionName: string): Promise<string | undefined> => {
    let linha: { devAccountId: string | null } | null
    try {
      linha = await app.prisma.devSession.findUnique({
        where: { sessionName },
        select: { devAccountId: true },
      })
    } catch (err) {
      // Não saber de qual conta é a sessão NÃO autoriza usar a do dono: seria
      // mexer com a chave errada numa sessão que pode ser de um cliente, e o
      // fornecedor devolveria 404 de qualquer jeito. Sem chave, quem chama
      // avisa e segue — falha aberta, nunca falha silenciosa na conta errada.
      app.log.warn(
        `[Scheduler] não deu para descobrir a conta da sessão ${sessionName}: ${String(err)}`
      )
      return undefined
    }
    return chaveDaConta(linha?.devAccountId ?? null)
  }

  /**
   * "Como este projeto vai ao ar?" — a pergunta ao dono (D47).
   *
   * Existe como função porque agora tem DOIS chamadores: a varredura que
   * descobriu que não há publicação nenhuma para ler, e o desfecho novo dos
   * cinco caminhos, quando o produto não sabe e se recusa a adivinhar.
   *
   * `ask` deduplica pela chave: respondida uma vez para aquele repositório, a
   * pergunta não volta — é a segunda metade do pedido do dono, "para que nunca
   * mais questione o usuario". O serviço é decorado pelo plugin do Telegram, e
   * quando o Telegram não está ligado não há a quem perguntar: segue em
   * silêncio, porque uma pergunta que ninguém recebe não pode derrubar a
   * varredura.
   */
  const perguntarComoPublica = async (projeto: {
    id: string
    wingId: string
    userId: string | null
  }): Promise<void> => {
    const perguntador = (app as unknown as { agentQuestionService?: AgentQuestionService })
      .agentQuestionService
    if (!perguntador || !projeto.userId) return
    await perguntador
      .ask(projeto.userId, projeto.id, duvidaSobreComoPublica(projeto.wingId))
      .catch((err: unknown) =>
        app.log.warn(err, `[Scheduler] não deu para perguntar ao dono de ${projeto.wingId}`)
      )
  }

  const descobrirMecanismoComCache = async (
    repository: string,
    githubToken: string,
    agora: Date,
    /** O que o projeto declarou. Quando existe, ganha da descoberta. */
    runtimeConfig?: unknown
  ): Promise<Mecanismo> => {
    // A chave inclui a DECLARAÇÃO: `wingId` não é único entre clientes
    // (o schema tem @@unique([userId, wingId])), e desde que o mecanismo passou
    // a depender da configuração do projeto, guardar só por repositório fazia
    // a declaração de um cliente valer para o outro por até uma hora.
    const declarados = ambientesDeclaradosPeloProjeto(runtimeConfig)
    const chaveDoCache = `${repository}::${declarados.join(',')}`
    const emCache = cacheDeMecanismo.get(chaveDoCache)
    if (emCache && emCache.expiraEm > agora.getTime()) {
      return emCache.mecanismo
    }
    const mecanismo = await descobrirMecanismo({
      onWarn: (m) => app.log.warn(`[Scheduler] publicação de ${repository}: ${m}`),
      ...(declarados.length > 0 ? { ambientesDeclarados: declarados } : {}),
      listarAmbientes: async () => {
        const resp = (await ghGet(`/repos/${repository}/environments`, githubToken)) as {
          environments?: Array<{ name: string }>
        }
        return (resp.environments ?? []).map((e) => e.name)
      },
      listarWorkflows: async () => {
        const resp = (await ghGet(`/repos/${repository}/actions/workflows`, githubToken)) as {
          workflows?: Array<{ name: string; path: string; state: string }>
        }
        return (resp.workflows ?? []).map((w) => ({
          nome: w.name,
          arquivo: w.path,
          ativo: w.state === 'active',
        }))
      },
    })
    cacheDeMecanismo.set(chaveDoCache, {
      mecanismo,
      expiraEm: agora.getTime() + VALIDADE_DO_CACHE_DE_MECANISMO_MS,
    })
    return mecanismo
  }

  // Avisa o dono do PROJETO — mesma resolução do resto do relógio
  // (varrerSessoesDoDev, reconferirAcessoDoRelogio): sem vínculo real de
  // Telegram, ninguém é avisado, e o projeto de um cliente nunca vira
  // mensagem no chat de outro.
  /**
   * O tipo pede só o que este helper de fato usa — `NotifiableProject` para
   * resolver o destino, e `wingId` para o aviso de falha dizer de qual projeto
   * se trata.
   *
   * Era o registro INTEIRO do Prisma antes de 22/08/2026, e isso o trancava
   * nos poucos pontos que carregam o projeto completo: o acordar do SM, que
   * trabalha com uma projeção enxuta, não conseguia chamá-lo e a alternativa
   * virava reconstruir o notificador à mão ali — a duplicação que este helper
   * existe para não ter.
   */
  const avisarDonoDoProjeto = async (
    projeto: NotifiableProject & { id: string; wingId: string },
    texto: string
  ): Promise<boolean> => avisarOuAuditar(app, projeto, texto)

  /**
   * Leva B ("o quadro do cliente não pode dizer entregue antes da hora"): o
   * ÚNICO lugar do produto que fecha a tarefa e move o card para "done" por
   * uma entrega delegada — chamado uma vez por sessão, exatamente quando
   * `varrerPublicacoes` chega a um veredito FINAL sobre a publicação. Antes,
   * `qa-rails-mission.ts` fazia isso no instante do MERGE, sem saber se o
   * código ia mesmo chegar ao ar; se a publicação falhasse depois, nada
   * reabria — o quadro do cliente dizia "entregue" enquanto o site nunca
   * recebeu a mudança, a mentira exata que este plano existe para acabar.
   *
   * `entregue: true` cobre os DOIS casos onde "mesclou" e "entregou" são a
   * mesma coisa: publicação CONFIRMADA (`no-ar`) e repositório que
   * PROVADAMENTE não publica (`mecanismo.tipo === 'nenhum'` — aqui o merge
   * já É a entrega, por definição). `entregue: false` cobre publicação que
   * falhou, ficou sem confirmação dentro do prazo, ou nem chegou a ser lida:
   * a tarefa NUNCA fecha como entregue por este caminho — fica aberta (fechar
   * por engano é pior que deixar aberta demais), ganha um comentário
   * nomeando o motivo (o dono vê o PORQUÊ direto na issue, não só num aviso
   * de chat que rola para longe) e o card volta para "review": o código está
   * mesclado, mas a entrega ainda não está confirmada — "em revisão" é mais
   * honesto que "pronto" e mais honesto que fingir que nada mudou.
   *
   * Duas saídas silenciosas, de propósito, ambas best-effort (nunca derrubam
   * a varredura — o veredito de publicação já foi decidido e gravado antes
   * de chegar aqui):
   * - sem `pullRequestNumber` na linha: teoricamente impossível depois de
   *   `registrarMescla` também gravar o número na hora do merge, mas
   *   defensivo — sem ele não há como montar nem o comentário nem o
   *   porteiro de `fecharTarefaEntregue` (os dois citam o PR).
   * - sem `githubToken`: a MESMA falta de credencial que já teria impedido a
   *   leitura de publicação — não há como escrever no GitHub.
   */
  const resolverEntregaDoBoard = async (args: {
    projeto: NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>
    sessao: LinhaDeSessao
    githubToken: string | undefined
    entregue: boolean
    motivo: string
  }): Promise<void> => {
    const { projeto, sessao, githubToken, entregue, motivo } = args
    if (!sessao.pullRequestNumber) {
      // Importante 4 (leva C): o irmão de baixo (sem credencial) sempre
      // avisou; este ramo saía em silêncio, sem log nenhum. Sessões
      // mescladas ANTES desta mudança existir (achadas pelo recuo pela
      // issue de origem) podem ter `pullRequestNumber` nulo — tarefa e card
      // ficam intocados, sem NENHUM rastro de que isso aconteceu ou por quê.
      app.log.warn(
        `[Scheduler] sem número do PR na sessão ${sessao.sessionName} — não dá para atualizar tarefa/card de #${sessao.issueNumber} (${projeto.wingId})`
      )
      return
    }
    if (!githubToken) {
      app.log.warn(
        `[Scheduler] sem credencial do GitHub para atualizar tarefa/card de #${sessao.issueNumber} (${projeto.wingId})`
      )
      return
    }
    const numeroDoPr = sessao.pullRequestNumber
    const railsBoard = resolveRailsBoard(projeto)
    const moveCard = railsBoard
      ? createCardMover({
          repository: projeto.wingId,
          board: railsBoard,
          token: githubToken,
          columns: resolveBoardColumns(projeto.runtimeConfig),
          fetchImpl: fetchDoQuadro(projeto),
        })
      : undefined

    if (entregue) {
      try {
        await fecharTarefaEntregue({
          numeroDoPr,
          mesclado: true,
          // `dev_sessions` só existe para trabalho delegado (a SM abre a
          // linha na delegação) — nunca para PR de humano, então este
          // caminho é sempre `delegado: true` por construção da tabela.
          delegado: true,
          lerEstadoDaTarefa: async () => {
            const tarefa = (await ghGet(
              `/repos/${projeto.wingId}/issues/${sessao.issueNumber}`,
              githubToken
            )) as { state?: string }
            return tarefa.state === 'closed' ? 'closed' : 'open'
          },
          comentar: async (texto) => {
            await ghSend(
              'POST',
              `/repos/${projeto.wingId}/issues/${sessao.issueNumber}/comments`,
              githubToken,
              { body: texto }
            )
          },
          fechar: async () => {
            await ghSend(
              'PATCH',
              `/repos/${projeto.wingId}/issues/${sessao.issueNumber}`,
              githubToken,
              {
                state: 'closed',
              }
            )
          },
        })
      } catch (err) {
        app.log.warn(
          err,
          `[Scheduler] fechar a tarefa #${sessao.issueNumber} falhou depois da publicação confirmada`
        )
      }
      if (moveCard) {
        await moveCard(sessao.issueNumber, 'done').catch((err) =>
          app.log.warn(err, `[Scheduler] mover card #${sessao.issueNumber} para done falhou`)
        )
      }
    } else {
      try {
        await ghSend(
          'POST',
          `/repos/${projeto.wingId}/issues/${sessao.issueNumber}/comments`,
          githubToken,
          {
            body:
              `O GitOrch mesclou a entrega desta tarefa (PR #${numeroDoPr}), mas não conseguiu ` +
              `confirmar que ela foi ao ar: ${motivo} A tarefa continua aberta até isso ser ` +
              'confirmado ou resolvido manualmente.',
          }
        )
      } catch (err) {
        app.log.warn(
          err,
          `[Scheduler] comentário de publicação não confirmada falhou na tarefa #${sessao.issueNumber}`
        )
      }
      if (moveCard) {
        await moveCard(sessao.issueNumber, 'review').catch((err) =>
          app.log.warn(err, `[Scheduler] mover card #${sessao.issueNumber} para review falhou`)
        )
      }
    }
  }

  /**
   * Item 1 da revisão pós-Leva A: fecha uma sessão que estourou o teto
   * ABSOLUTO (`TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS`) sem chegar a um veredito
   * final por nenhum dos caminhos específicos — usado tanto quando
   * `acompanharPublicacao` rodou e devolveu um estado não-final preso
   * (`falhou`, `publicando`, `commit-errado`) quanto quando nem uma leitura
   * ao GitHub funcionou (sem credencial, ou uma exceção repetida). Sempre o
   * mesmo pacote de efeitos: grava o veredito final, fecha a sessão, avisa o
   * dono UMA vez com a última observação, e resolve o board como
   * "não entregue" (nunca "done" — ver `resolverEntregaDoBoard`).
   */
  /**
   * Encerra uma entrega com um veredito e um motivo DITOS POR EXTENSO.
   *
   * Existe porque `fecharComTetoAbsoluto` embrulha tudo na frase "mesclamos e
   * acompanhamos por Xh sem conseguir confirmar" e sempre marca o board como
   * NÃO entregue. Isso é certo quando o prazo estourou — e errado nos dois
   * desfechos novos dos cinco caminhos (D49):
   *
   * - o projeto que publica na mão: aqui o merge É a entrega, e marcar "não
   *   entregue" deixaria um comentário na issue do cliente dizendo que a
   *   tarefa continua aberta "até isso ser confirmado" — uma confirmação que,
   *   por definição, nunca vai existir. Card preso em revisão para sempre;
   * - o aviso que CHEGOU: dizer "acompanhamos 24h e o aviso não chegou" seria
   *   simplesmente falso.
   */
  const encerrarEntrega = async (args: {
    projeto: NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>
    sessao: LinhaDeSessao
    agora: Date
    /** O veredito que fica gravado na linha. */
    estado: 'no-ar' | 'falhou' | 'sem-publicacao'
    /** Se o board pode dizer "done". */
    entregue: boolean
    motivo: string
    githubToken: string | undefined
  }): Promise<void> => {
    await registrarPublicacaoEIncremento({
      sessao: args.sessao,
      estado: args.estado,
      agora: args.agora,
    })
    await fecharSessaoEArquivar({
      sessionName: args.sessao.sessionName,
      motivo: 'merged',
      agora: args.agora,
    })
    await avisarDonoDoProjeto(
      args.projeto,
      `GitOrch: a entrega de ${args.projeto.wingId} (commit ${args.sessao.mergeCommitSha}) foi ` +
        `mesclada. ${args.motivo}`
    )
    await resolverEntregaDoBoard({
      projeto: args.projeto,
      sessao: args.sessao,
      githubToken: args.githubToken,
      entregue: args.entregue,
      motivo: args.motivo,
    })
  }

  /**
   * Grava o estado da publicação E passa a entrega pela régua de pronto.
   *
   * Os dois juntos porque é EXATAMENTE aqui que a entrega pode ter acabado de
   * ficar pronta: `deployState` é o último fato que a régua padrão espera. Em
   * qualquer outro lugar, o registro do Incremento chegaria atrasado — o
   * painel diria "ainda não" numa entrega que já estava no ar.
   *
   * Falha ao registrar o Incremento NÃO derruba o fechamento da sessão: o
   * estado da publicação é o fato principal e já foi gravado. O Incremento é o
   * registro que o painel lê, e uma volta seguinte do relógio o grava.
   */
  const registrarPublicacaoEIncremento = async (args: {
    sessao: LinhaDeSessao
    estado: string
    agora: Date
  }): Promise<void> => {
    await registrarEstadoDaPublicacao({
      prisma: app.prisma as unknown as PrismaDevSession,
      sessionName: args.sessao.sessionName,
      estado: args.estado,
      agora: args.agora,
    })

    try {
      await registrarSePronto(
        {
          lerRegua: async (projectId: string) =>
            (
              await app.prisma.project.findUnique({
                where: { id: projectId },
                select: { reguaDePronto: true },
              })
            )?.reguaDePronto ?? null,
          jaRegistrado: async (projectId: string, issueNumber: number) =>
            (await app.prisma.increment.findUnique({
              where: { projectId_issueNumber: { projectId, issueNumber } },
            })) !== null,
          gravar: async (dados) => {
            await app.prisma.increment.create({
              data: {
                projectId: dados.projectId,
                issueNumber: dados.issueNumber,
                pullRequestNumber: dados.pullRequestNumber,
                mergeCommitSha: dados.mergeCommitSha,
                reguaAplicada: dados.reguaAplicada,
                criterios: dados.criterios,
              },
            })
          },
        },
        {
          projectId: args.sessao.projectId,
          issueNumber: args.sessao.issueNumber,
          pullRequestNumber: args.sessao.pullRequestNumber ?? null,
          mergeCommitSha: args.sessao.mergeCommitSha ?? null,
          // O estado que ACABOU de ser gravado, não o que a linha trazia: a
          // linha em memória é anterior à escrita.
          deployState: args.estado,
          envLastVerdict: args.sessao.envLastVerdict ?? null,
        }
      )
    } catch (err) {
      app.log.warn(
        err,
        `[Scheduler] não consegui registrar o incremento de ${args.sessao.sessionName} — o estado da publicação foi gravado`
      )
    }
  }

  const fecharComTetoAbsoluto = async (args: {
    projeto: NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>
    sessao: LinhaDeSessao
    agora: Date
    desdeAMescla: number
    ultimaObservacao: string
    githubToken: string | undefined
  }): Promise<void> => {
    const { projeto, sessao, agora, desdeAMescla, ultimaObservacao, githubToken } = args
    const veredito = fecharPorTetoAbsoluto({ desdeAMescla, ultimaObservacao })
    await registrarPublicacaoEIncremento({ sessao, estado: veredito.estado, agora })
    await fecharSessaoEArquivar({
      sessionName: sessao.sessionName,
      motivo: 'merged',
      agora,
    })
    await avisarDonoDoProjeto(
      projeto,
      `GitOrch: a entrega de ${projeto.wingId} (commit ${sessao.mergeCommitSha}) foi mesclada. ${veredito.motivo}`
    )
    await resolverEntregaDoBoard({
      projeto,
      sessao,
      githubToken,
      entregue: false,
      motivo: veredito.motivo,
    })
  }

  /**
   * A sessão não encerra mais no merge (`aoMesclarUmaEntrega`, acima) —
   * encerra quando há VEREDITO sobre a publicação. Esta varredura é quem
   * chega até esse veredito: descobre como o repositório publica (Tarefa 12,
   * com cache de uma hora), acompanha se o commit mesclado foi ao ar (Tarefa
   * 13), testa o endereço quando ele sobe (Tarefa 14), e só então fecha a
   * linha — carregando SEMPRE o motivo (Tarefa 13/14) no aviso ao dono, não
   * só o veredito cru: é o `motivo` que registra, por exemplo, um endereço
   * excluído pela guarda de rede (Tarefa 11) antes de qualquer chamada.
   *
   * Cadência de 10 minutos por sessão (`sessoesParaAcompanharPublicacao`,
   * pos-merge.ts) — nunca reexamina quem já tem veredito final, para não
   * gastar a quota do GitHub do cliente à toa.
   *
   * Importante 5 da revisão final da branch: o relógio de "desde quando
   * esta sessão vem vendo zero evidência" já foi um Map em memória, dentro
   * deste fechamento — reiniciar o processo (e este produto se reimplanta)
   * zerava a janela de tolerância, e um restart mais frequente que ela fazia
   * o veredito nunca chegar a final. Hoje `desdeAMescla` (abaixo, dentro do
   * laço) é lido de `sessao.stateCheckedAt`: gravado no EXATO instante do
   * merge por `registrarMescla` (dev-session-store.ts) e, depois do merge,
   * ninguém mais escreve nele — a vigia pré-merge para de examinar a sessão
   * assim que `mergeCommitSha` é gravado (`sessoesParaVigiaPreMerge`,
   * acima), e o PR já mesclado sai da listagem de PRs abertos que alimenta o
   * laço de descoberta do QA. Sobrevive a qualquer reinício, sem coluna
   * nova.
   *
   * Item 1 da revisão pós-Leva A: além dos tetos específicos de cada estado
   * (`JANELA_DE_TOLERANCIA_SEM_EVIDENCIA_MS`, `TETO_DE_COMMIT_ERRADO_MS`,
   * ambos dentro de `acompanharPublicacao`), esta varredura agora também
   * mede `desdeAMescla` contra `TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS` — o
   * BACKSTOP que fecha a sessão mesmo quando nenhum teto específico se
   * aplicava ao estado em que ela ficou presa (`falhou` sem ninguém rodar o
   * CD de novo; `publicando` represado esperando aprovação humana; ou uma
   * leitura ao GitHub que nunca funciona). Ver `fecharComTetoAbsoluto`.
   *
   * Item 2/Leva B: o veredito final também decide o que acontece com a
   * TAREFA e o CARD do board do cliente — nunca mais no merge
   * (`qa-rails-mission.ts`, desenho antigo). Ver `resolverEntregaDoBoard`.
   */
  /**
   * Quantas execuções recentes `lerExecucoes` pede por página (Menor 10 da
   * revisão final). Era 10 — folgado demais num repositório movimentado: CI,
   * CD e rotinas agendadas todas registram execuções na MESMA lista, e a
   * nossa (a que casa com `shaDaMescla`) pode cair fora da primeira página
   * antes de a próxima varredura rodar. Quando isso acontece,
   * `acompanharPorWorkflow` só enxerga a execução MAIS RECENTE (de outro
   * fluxo) e o veredito vira `commit-errado` por engano — alimentando
   * diretamente o Crítico 1 que este mesmo pacote de correções fechou.
   *
   * 50: cinco vezes mais folga, sem chegar ao teto de 100 da API — o custo
   * de cota do GitHub é POR CHAMADA, não por item devolvido (continua sendo
   * UMA leitura por sessão por cadência), então subir `per_page` não
   * consome quota extra; só reduz o tamanho da resposta que ainda cabe
   * folgado num único GET.
   */
  /**
   * A entrega que não chegou ao ar VOLTA ATRÁS: vira tarefa de conserto no
   * repositório do cliente.
   *
   * Este é o elo que faltava depois da mescla. A vigília já sabia distinguir
   * publicação confirmada de publicação que falhou, e já sabia fechar a
   * entrega no caso feliz — mas na falha ninguém agia: nenhuma issue, nenhum
   * conserto, nenhum trabalho novo. A entrega ficava pendurada e o cliente
   * ficava sem a mudança no ar, em silêncio.
   *
   * Devolve o NÚMERO da issue criada, ou `null` quando não havia o que abrir
   * (decisão da função pura) ou quando a escrita no GitHub não funcionou.
   * Nunca lança: um repositório fora de alcance não pode derrubar a varredura
   * das outras sessões — mas a falha vira erro no log, nunca silêncio.
   */
  /**
   * O produto pede ao CD do cliente que avise quando a versão sobe (D50).
   *
   * Ordem do dono, 26/08: "o gitorch decide isso, um dos agentes tem que pensar
   * como fazer isso!". Ele recusou que um humano pusesse a chamada na mão — e
   * com razão: remendado na mão, o produto continua incapaz e o próximo cliente
   * cai no mesmo buraco. Aqui o produto abre a tarefa no repositório do cliente
   * e o dev assíncrono a executa, como qualquer outro trabalho.
   *
   * Nunca lança: um repositório fora de alcance não pode derrubar a varredura
   * das outras sessões — mas a falha vira erro no log, nunca silêncio.
   */
  const pedirOAvisoDePublicacao = async (
    projeto: NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>
  ): Promise<void> => {
    const decisao = decidirPedirOAviso({
      repositorio: projeto.wingId,
      projectId: projeto.id,
      declarado: comoPublicaDeclarado(projeto.runtimeConfig),
      jaInstalado: projeto.deployNoticeInstalledAt !== null,
      marcaAnterior: projeto.deployNoticeAskedKey,
    })
    if (!decisao.abrir) return

    const endereco = process.env['GITORCH_PUBLIC_URL']
    if (!endereco) {
      // Sem saber o próprio endereço, a instrução sairia com um lugar errado
      // para o CD chamar — pior que não pedir nada.
      app.log.warn(
        `[Scheduler] não sei meu endereço público (GITORCH_PUBLIC_URL); não dá para pedir o aviso de publicação a ${projeto.wingId}`
      )
      return
    }

    try {
      // Fecha a janela que a marca no banco não fecha: issue criada e marca
      // NÃO gravada (falha entre as duas) faria a varredura seguinte pedir de
      // novo, e o cliente ganharia uma tarefa duplicada no quadro dele. O
      // corpo da issue carrega a chave como marcador justamente para isto —
      // reconhecer a tarefa pelo que ela é, não só pelo que anotamos.
      const token = process.env['GITORCH_GITHUB_TOKEN']
      if (token) {
        const abertas = (await ghGet(
          `/repos/${projeto.wingId}/issues?state=open&labels=${encodeURIComponent(TASK_LABEL)}&per_page=100`,
          token
        )) as Array<{ body?: string | null; title?: string | null }>
        if (jaExisteOPedido(abertas ?? [])) {
          // Grava a marca que faltava, para não repetir esta leitura a cada tique.
          await app.prisma.project.update({
            where: { id: projeto.id },
            data: { deployNoticeAskedKey: decisao.chave },
          })
          app.log.info(
            `[Scheduler] o pedido de aviso já está aberto em ${projeto.wingId}; só marquei aqui`
          )
          return
        }
      }

      // Caminho ÚNICO de escrita de issue no repositório do cliente.
      const criada = await criarIssueDeDesejo({
        repo: projeto.wingId,
        titulo: decisao.titulo,
        corpo: corpoDoPedidoDeAviso({
          repositorio: projeto.wingId,
          projectId: projeto.id,
          endereco,
        }),
        etiquetas: decisao.etiquetas,
        log: { onError: (m) => app.log.error(m), onWarn: (m) => app.log.warn(m) },
      })
      // A marca é gravada DEPOIS de a issue existir de verdade: gravar antes e
      // falhar a escrita deixaria o projeto marcado como "já pedido" sem tarefa
      // nenhuma — o silêncio exato que isto veio acabar.
      await app.prisma.project.update({
        where: { id: projeto.id },
        data: { deployNoticeAskedKey: decisao.chave },
      })
      app.log.info(
        `[Scheduler] pedi ao ${projeto.wingId} que o CD dele avise quando sobe ao ar (issue #${criada.numero})`
      )
    } catch (err) {
      app.log.error(
        err,
        `[Scheduler] não foi possível pedir o aviso de publicação a ${projeto.wingId}`
      )
    }
  }

  /**
   * A pergunta do dev que está esperando resposta — respondida de verdade.
   *
   * O dono pediu com todas as letras: "esta com duvidas ? responde !". O que
   * existia era decorativo: a vigília acordava o QA e contava a linha como
   * respondida, e a missão de QA só julga pull request. Aqui a pergunta é
   * LIDA, respondida pelo motor lendo o repositório, e a resposta é ESCRITA
   * na sessão — o único caminho que a API do serviço oferece (`sendMessage`).
   *
   * Uma pergunta por vez, a mais antiga: são poucas por projeto, e responder
   * em rajada gastaria motor sem necessidade — a próxima acordada pega a
   * seguinte.
   *
   * A lei continua: o agente NÃO INVENTA. Decisão de negócio, ou resposta que
   * ele não soube dar, sobem para o dono em vez de virar mensagem — quem
   * decide isso é código determinístico (`duvida-do-dev.ts`), nunca o modelo.
   */
  const responderDuvidaPendente = async (args: {
    projectId: string
    repository: string
    execute: StepExecutor
    contextBlocks: string[]
    /** ESTEIRA-T14: runtimeConfig.perguntasAoDono decide se o RA tenta antes do dono. */
    runtimeConfig: unknown
  }): Promise<void> => {
    // TODAS as que esperam, não só a mais antiga.
    //
    // Pegar só a primeira criava fome: se a mais antiga já tinha sido
    // respondida, a função saía e as outras nunca tinham vez. Medido ao vivo
    // em 26/08 — oito sessões esperando resposta na API do fornecedor, com
    // quarenta e oito acordadas do QA no mesmo período e apenas duas respostas,
    // as duas para a MESMA sessão.
    //
    // Responde UMA por acordada, mas a que de fato precisa: percorre até achar
    // quem ainda não foi respondida. Uma por vez porque cada resposta custa um
    // passo de motor, e a acordada seguinte pega a próxima.
    const candidatas = await app.prisma.devSession.findMany({
      where: { projectId: args.projectId, state: 'AWAITING_USER_FEEDBACK', closedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        sessionName: true,
        issueNumber: true,
        answeredHash: true,
        // O carimbo da reserva: e ele que separa "alguem esta tentando agora"
        // de "a tentativa terminou e falhou". Ja era gravado; nao era lido.
        stateCheckedAt: true,
      },
      take: 20,
    })
    if (candidatas.length === 0) return

    for (const esperando of candidatas) {
      const apiKey = await chaveDaSessao(esperando.sessionName)
      const pergunta = await ultimaMensagemDoDevJules({
        apiKey,
        sessionName: esperando.sessionName,
        onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
      })
      if (!pergunta || pergunta.trim() === '') {
        app.log.warn(
          `[Scheduler] ${esperando.sessionName} está esperando resposta, mas não deu para ler a pergunta`
        )
        continue
      }

      // JÁ RESPONDIDA? Sai antes de gastar motor.
      //
      // Sem esta trava, a mesma pergunta seria lida e respondida a cada acordada
      // do QA — e são várias por hora, pela agenda, pela fila do SM e pela
      // própria vigília. O dev receberia a mesma resposta em rajada, o dono
      // receberia o mesmo aviso em rajada, e uma segunda sessão esperando nunca
      // teria vez, porque a busca sempre pega a mais antiga. Trocar silêncio por
      // spam não é conserto.
      const hashDaPergunta = hashDaMensagem(pergunta)
      const decisao = decidirSobreAPergunta({
        hashDaPergunta,
        marca: esperando.answeredHash,
        // O carimbo da reserva. Sem ele, uma acordada que chegasse no meio da
        // tentativa de outra a contava como tentativa JÁ GASTA e subia o
        // contador — e a devolução da primeira, condicional à marca dela, não
        // valia mais. Foi assim que as tarefas #248 e #3799 chegaram a
        // `desisti` mesmo com a devolução funcionando.
        marcadaEm: esperando.stateCheckedAt,
        agora: new Date(),
      })
      // Já respondida, ou já desistimos dela: passa para a próxima em vez de
      // sair. Sair aqui era a fome — a mais antiga já resolvida fazia todas as
      // outras esperarem para sempre.
      if (decisao.acao === 'nada') continue

      if (decisao.acao === 'desistir') {
        // Bateu o teto com a mesma pergunta ainda na mesa. Parar de tentar é
        // certo — não vira laço queimando motor. Parar em SILÊNCIO não: é
        // trabalho parado que ninguém mais destrava sozinho.
        //
        // A desistência é marcada com escrita CONDICIONAL, como a reserva: sem
        // isso, duas acordadas na mesma janela mandariam o mesmo aviso duas
        // vezes ao dono. Um aviso, uma vez.
        const primeiro = await app.prisma.devSession
          .updateMany({
            where: { sessionName: esperando.sessionName, answeredHash: esperando.answeredHash },
            data: { answeredHash: marcarDesistencia(hashDaPergunta, decisao.tentativas) },
          })
          .catch(() => ({ count: 0 }))
        // Outra acordada já marcou a desistência desta: segue para a próxima.
        if (primeiro.count === 0) continue

        const projetoDaDesistencia = await app.prisma.project.findUnique({
          where: { id: args.projectId },
        })
        if (projetoDaDesistencia) {
          await avisarDonoDoProjeto(
            projetoDaDesistencia,
            `GitOrch: o dev parou na tarefa #${esperando.issueNumber} de ${args.repository} e eu ` +
              `tentei responder ${decisao.tentativas} vezes sem conseguir. O trabalho está parado ` +
              `esperando essa resposta.`
          )
        }
        return
      }

      // RESERVA antes de gastar motor. Duas acordadas do QA na mesma janela liam
      // a mesma marca, as duas passavam pela conferência e as duas escreviam na
      // sessão — o dev recebeu a mesma resposta duas vezes no mesmo minuto, e o
      // produto pagou o motor em dobro. A escrita é condicional à marca lida:
      // quem não escreve nenhuma linha perdeu a corrida e sai calado.
      const minha = await reservarAResposta({
        prisma: app.prisma as unknown as PrismaParaReserva,
        sessionName: esperando.sessionName,
        hashDaPergunta,
        tentativa: decisao.tentativa,
        marcaLida: esperando.answeredHash,
        agora: new Date(),
      })
      // Outra acordada pegou esta: tenta a próxima em vez de desistir da vez.
      if (!minha) continue

      // Se quem falhar for o MOTOR, a tentativa é DEVOLVIDA. O dono recebeu
      // (26/08 21:49): "tentei responder 3 vezes sem conseguir" na tarefa #246 —
      // e as três mortes foram `Individual quota reached`, nenhuma tinha a ver
      // com a pergunta. Como `desisti` não tem volta, algumas horas sem cota
      // condenavam a pergunta para sempre: o motor voltaria e ninguém tentaria
      // de novo. Uma tentativa é "formulei uma resposta e ela não serviu";
      // motor sem cota não formulou nada.
      let resultadoDaDuvida: Awaited<ReturnType<typeof runDuvidaMissionViaRails>>
      try {
        resultadoDaDuvida = await runDuvidaMissionViaRails({
          pergunta,
          repository: args.repository,
          issueNumber: esperando.issueNumber,
          execute: args.execute,
          contextBlocks: args.contextBlocks,
        })
      } catch (err) {
        if (!isEngineFault(err, err instanceof Error ? err.message : String(err))) throw err
        await devolverAReserva({
          prisma: app.prisma as unknown as PrismaParaReserva,
          sessionName: esperando.sessionName,
          hashDaPergunta,
          tentativa: decisao.tentativa,
          marcaAnterior: esperando.answeredHash,
          agora: new Date(),
        }).catch(() => false)
        app.log.warn(
          err,
          `[Scheduler] o motor não deu conta de responder a dúvida da tarefa #${esperando.issueNumber} ` +
            `de ${args.repository}; a tentativa foi devolvida e a pergunta continua na fila`
        )
        return
      }
      let { destino, mensagemParaODev } = resultadoDaDuvida
      // ESTEIRA-T14: o QA não conseguiu responder tecnicamente. Por padrão
      // (so-executivo), o RA tenta ANTES de incomodar o dono — o dono não
      // deveria ver uma pergunta técnica que o produto ainda nem tentou
      // resolver a sério. As outras políticas pulam o RA de propósito (quem
      // configurou quer o humano vendo todo bloqueio técnico na hora).
      const politica = resolvePoliticaDePerguntasAoDono(args.runtimeConfig)
      let respostaVeioDoRa = false
      if (destino.tipo === 'escalar-ao-ra') {
        if (politica === 'so-executivo') {
          const resultadoRa = await runDuvidaTecnicaViaRa({
            pergunta,
            repository: args.repository,
            issueNumber: esperando.issueNumber,
            motivoDaEscalada: destino.motivo,
            execute: args.execute,
            contextBlocks: args.contextBlocks,
          })
          if (resultadoRa.aprendizadoParaGravar) {
            // O acerto do RA vira aprendizado do QA — é o coração do T14: da
            // próxima vez que o mesmo tema aparecer, o QA responde sozinho
            // (blocoDeContextoDoJules já injeta estes aprendizados no prompt
            // dele, sem nenhuma outra mudança de encanamento).
            await registrarAprendizado({
              prisma: app.prisma as unknown as PrismaEventoDoJules,
              projectId: args.projectId,
              aprendizado: {
                padrao:
                  `Pergunta técnica na issue #${esperando.issueNumber} — "` +
                  `${pergunta.replace(/\s+/g, ' ').trim().slice(0, 160)}" -> resposta: ` +
                  resultadoRa.aprendizadoParaGravar.replace(/\s+/g, ' ').trim().slice(0, 300),
                origem: 'resposta-tecnica',
                issueNumber: esperando.issueNumber,
              },
              onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
            }).catch(() => undefined)
          }
          destino = resultadoRa.destino
          mensagemParaODev = resultadoRa.mensagemParaODev
          respostaVeioDoRa = true
        } else {
          // executivo-e-tecnico-bloqueante | tudo: pula o RA, o bloqueio
          // técnico vai direto ao dono. Motivo PRÓPRIO desta política — o
          // texto de destinoDaDuvida fala em "o RA tenta", e aqui o RA nunca
          // chega a rodar; usar aquele motivo mentiria sobre o que aconteceu.
          destino = {
            tipo: 'perguntar-ao-dono',
            motivo:
              'é bloqueio técnico e a configuração deste projeto pede visibilidade imediata ' +
              '(sem esperar o RA tentar).',
          }
        }
      }

      if (destino.tipo === 'perguntar-ao-dono' || !mensagemParaODev) {
        // Sobe para quem pode decidir. Sem chat ligado não há a quem perguntar:
        // fica o registro no log, que é o que sobra — nunca uma resposta
        // inventada mandada ao dev.
        const motivo = destino.tipo === 'perguntar-ao-dono' ? destino.motivo : 'sem resposta útil'
        app.log.info(
          `[Scheduler] a dúvida do dev na tarefa #${esperando.issueNumber} de ${args.repository} sobe para o dono: ${motivo}`
        )
        // O aviso ao dono também é marcado: sem isto, o MESMO aviso chegaria ao
        // chat dele a cada acordada do QA enquanto a sessão continuasse parada.
        await registrarResposta({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName: esperando.sessionName,
          hashDaPergunta: marcarRespondida(hashDaPergunta),
          agora: new Date(),
        }).catch(() => undefined)
        const projeto = await app.prisma.project.findUnique({ where: { id: args.projectId } })
        if (projeto) {
          await avisarDonoDoProjeto(
            projeto,
            `GitOrch: o dev parou na tarefa #${esperando.issueNumber} de ${args.repository} e ` +
              `perguntou algo que eu não devo responder sozinho — ${motivo}\n\nA pergunta dele:\n` +
              pergunta.slice(0, 900)
          )
        }
        return
      }

      const saiu = await responderSessaoJules({
        apiKey,
        sessionName: esperando.sessionName,
        texto: mensagemParaODev,
        onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
      })
      // ESTEIRA-T14, política 'tudo': visibilidade total — o dono também vê
      // as dúvidas técnicas que o produto resolveu sozinho. NUNCA bloqueante:
      // é aviso, o dev já foi respondido antes desta linha rodar.
      if (saiu && politica === 'tudo') {
        const projetoParaAviso = await app.prisma.project.findUnique({
          where: { id: args.projectId },
        })
        if (projetoParaAviso) {
          await avisarDonoDoProjeto(
            projetoParaAviso,
            `GitOrch: o dev perguntou algo técnico na tarefa #${esperando.issueNumber} de ` +
              `${args.repository} e ${respostaVeioDoRa ? 'o RA' : 'o QA'} já respondeu — nada bloqueado.`
          ).catch(() => undefined)
        }
      }
      if (saiu) {
        // A marca de RESPONDIDA só é gravada quando a mensagem de fato chegou —
        // é a diferença entre "tentei" e "respondi", e foi confundir as duas que
        // deixou treze sessões presas por até sete dias.
        await registrarResposta({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName: esperando.sessionName,
          hashDaPergunta: marcarRespondida(hashDaPergunta),
          agora: new Date(),
        }).catch((err: unknown) =>
          app.log.warn(err, `[Scheduler] não deu para marcar a dúvida como respondida`)
        )
        // D52 + D51: o dev PRECISOU perguntar — sinal de que a issue faltou
        // contexto. Vira aprendizado para o PO/RA escreverem issues melhores.
        await registrarAprendizado({
          prisma: app.prisma as unknown as PrismaEventoDoJules,
          projectId: args.projectId,
          aprendizado: {
            padrao:
              `O dev precisou perguntar na issue #${esperando.issueNumber} — a issue faltou ` +
              `contexto: "${pergunta.replace(/\s+/g, ' ').trim().slice(0, 180)}". ` +
              'Incluir isso no corpo de issues parecidas.',
            origem: 'duvida-do-dev',
            issueNumber: esperando.issueNumber,
          },
          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
        }).catch(() => undefined)
      }
      app.log.info(
        saiu
          ? `[Scheduler] respondi a dúvida do dev na tarefa #${esperando.issueNumber} de ${args.repository}`
          : `[Scheduler] a resposta para ${esperando.sessionName} NÃO chegou ao dev`
      )
      // Respondeu (ou escalou) uma: a próxima acordada pega a seguinte.
      return
    }
  }

  const abrirConsertoDePublicacao = async (args: {
    projeto: NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>
    sessao: LinhaDeSessao
    evidencia: EvidenciaDeConserto
  }): Promise<number | null> => {
    const decisao = decidirConsertoDePublicacao({
      repositorio: args.projeto.wingId,
      shaDaMescla: args.sessao.mergeCommitSha ?? '',
      numeroDoPr: args.sessao.pullRequestNumber,
      issueDaEntrega: args.sessao.issueNumber,
      marcaAnterior: args.sessao.deployFixKey,
      evidencia: args.evidencia,
    })
    if (!decisao.abrir) {
      app.log.info(
        `[Scheduler] sem tarefa de conserto para ${args.sessao.sessionName}: ${decisao.motivo}`
      )
      return null
    }

    let numero: number
    try {
      // Caminho ÚNICO de escrita de issue no repositório do cliente. Uma
      // segunda cópia desta chamada divergiria em silêncio da primeira, e o
      // cliente descobriria pela issue errada.
      const criada = await criarIssueDeDesejo({
        repo: args.projeto.wingId,
        titulo: decisao.titulo,
        corpo: decisao.corpo,
        etiquetas: decisao.etiquetas,
        // Abrir issue no repositório do cliente é escrita: passa pela guarda de
        // autonomia com o nível DESTE projeto. Sem isto a chamada cairia no
        // padrão que recusa, e a tarefa de conserto nunca seria aberta.
        fetchImpl: fetchDoRepositorio({ nivel: () => args.projeto.autonomia }),
        log: {
          onError: (m) => app.log.error(m),
          onWarn: (m) => app.log.warn(m),
        },
      })
      numero = criada.numero
    } catch (err) {
      app.log.error(
        err,
        `[Scheduler] não foi possível abrir a tarefa de conserto de ${args.projeto.wingId} para ${args.sessao.sessionName}`
      )
      return null
    }

    // A marca é gravada DEPOIS de a issue existir de verdade. Gravar antes e
    // falhar a escrita deixaria a sessão marcada como "já consertada" sem
    // tarefa nenhuma — o silêncio exato que este mecanismo veio acabar. A
    // ordem escolhida deixa uma janela estreita no sentido oposto (issue
    // criada, marca não gravada, segunda issue na varredura seguinte); por
    // isso o corpo da issue carrega a mesma chave como marcador, e a falha
    // desta gravação vira ERRO no log, nunca silêncio.
    await registrarConsertoDePublicacao({
      prisma: app.prisma as unknown as PrismaDevSession,
      sessionName: args.sessao.sessionName,
      chave: decisao.chave,
    }).catch((err) =>
      app.log.error(
        err,
        `[Scheduler] tarefa de conserto #${numero} criada em ${args.projeto.wingId}, mas a marca de controle não pôde ser gravada em ${args.sessao.sessionName}`
      )
    )
    app.log.info(
      `[Scheduler] tarefa de conserto #${numero} aberta em ${args.projeto.wingId} para ${args.sessao.sessionName} (marca ${decisao.chave})`
    )
    return numero
  }

  const TAMANHO_DA_PAGINA_DE_EXECUCOES = 50

  /**
   * A tarefa fecha quando a entrega dela entra — não importa QUEM mesclou.
   *
   * O dono diagnosticou melhor que eu (27/08): "já vi PRs merged com issue
   * open". Medido no banco: 16 tarefas do gitorch e 9 do patinhas abertas com
   * a entrega já mesclada, e o produto SABIA — o commit do merge estava
   * gravado na linha da entrega. A #128 chegou a ter CINCO entregas, porque
   * tarefa aberta volta para a fila do gerente e é delegada de novo; a entrega
   * nova nasce em conflito com a que já entrou.
   *
   * `fecharTarefaEntregue` só rodava dentro da missão de QA, logo depois de o
   * produto mesclar com as próprias mãos. Auto-merge do repositório ou clique
   * de gente não fechavam nada. Aqui é a MESMA regra, aplicada também nesses
   * casos.
   */
  const varrerTarefasEntregues = async (): Promise<void> => {
    let linhas: Array<{
      issueNumber: number
      pullRequestNumber: number | null
      mergeCommitSha: string | null
      projectId: string
      updatedAt: Date
    }>
    try {
      linhas = await app.prisma.devSession.findMany({
        where: { mergeCommitSha: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: {
          issueNumber: true,
          pullRequestNumber: true,
          mergeCommitSha: true,
          projectId: true,
          updatedAt: true,
        },
      })
    } catch (err) {
      app.log.error(err, '[Scheduler] varredura de tarefas entregues não conseguiu ler as entregas')
      return
    }

    const porProjeto = new Map<string, typeof linhas>()
    for (const l of entregasQueMerecemConferencia(linhas, new Date())) {
      const lista = porProjeto.get(l.projectId) ?? []
      lista.push(l)
      porProjeto.set(l.projectId, lista)
    }

    for (const [projectId, entregas] of porProjeto) {
      const projeto = await app.prisma.project
        .findUnique({ where: { id: projectId }, select: { wingId: true, isActive: true } })
        .catch(() => null)
      if (!projeto?.isActive) continue

      const githubToken =
        process.env['GITORCH_GITHUB_TOKEN'] ??
        (await mintInstallationToken({
          repository: projeto.wingId,
          onError: (m) => app.log.error(m),
          onWarn: (m) => app.log.warn(m),
        })) ??
        undefined
      if (!githubToken) continue

      const rest = async (metodo: string, caminho: string, corpo?: unknown): Promise<unknown> => {
        const r = await ghComGuarda(`https://api.github.com${caminho}`, {
          method: metodo,
          headers: {
            authorization: `Bearer ${githubToken}`,
            accept: 'application/vnd.github+json',
            ...(corpo ? { 'content-type': 'application/json' } : {}),
          },
          ...(corpo ? { body: JSON.stringify(corpo) } : {}),
        })
        if (!r.ok) throw new Error(`GitHub ${metodo} ${caminho} falhou (${r.status})`)
        return r.json()
      }

      for (const entrega of entregas) {
        try {
          const issue = (await rest(
            'GET',
            `/repos/${projeto.wingId}/issues/${entrega.issueNumber}`
          )) as { state?: string }
          if (issue.state !== 'open') continue

          const recado = recadoDeTarefaJaEntregue({
            pullRequestNumber: entrega.pullRequestNumber,
            mergeCommitSha: entrega.mergeCommitSha as string,
          })
          await rest('POST', `/repos/${projeto.wingId}/issues/${entrega.issueNumber}/comments`, {
            body: recado,
          })
          await rest('PATCH', `/repos/${projeto.wingId}/issues/${entrega.issueNumber}`, {
            state: 'closed',
          })
          app.log.info(
            `[Scheduler] ${projeto.wingId}: tarefa #${entrega.issueNumber} encerrada — a entrega dela já estava mesclada`
          )
        } catch (err) {
          // Best-effort por tarefa: uma issue apagada ou sem permissão não
          // pode deixar as outras abertas para sempre.
          app.log.warn(
            `[Scheduler] ${projeto.wingId}: não consegui conferir a tarefa #${entrega.issueNumber}: ${(err as Error).message}`
          )
        }
      }
    }
  }

  /**
   * A árvore do plano se encerra sozinha quando o trabalho dela acaba.
   *
   * O PO monta fase > épico > feature > tarefa e pendura uma na outra pelo
   * mecanismo nativo de sub-issue. Só a TAREFA fechava; o resto ficava aberto
   * para sempre. Medido em 27/08 no gitorch: 11 fases, 15 épicos e 19 features
   * abertas — 45 issues de pura estrutura contra 20 tarefas de verdade. Foi o
   * que fez o dono perguntar por que o repositório tem tanta issue "mesmo com
   * PR merged": a maior parte não era trabalho pendente, era esqueleto.
   */
  const varrerArvoreDosPlanos = async (): Promise<void> => {
    let projetos: Array<{ id: string; wingId: string }>
    try {
      projetos = await app.prisma.project.findMany({
        where: { isActive: true, accessSuspendedAt: null },
        select: { id: true, wingId: true },
      })
    } catch (err) {
      app.log.error(err, '[Scheduler] varredura da árvore não conseguiu listar projetos')
      return
    }

    for (const projeto of projetos) {
      const githubToken =
        process.env['GITORCH_GITHUB_TOKEN'] ??
        (await mintInstallationToken({
          repository: projeto.wingId,
          onError: (m) => app.log.error(m),
          onWarn: (m) => app.log.warn(m),
        })) ??
        undefined
      if (!githubToken) continue

      const rest = async (metodo: string, caminho: string, corpo?: unknown): Promise<unknown> => {
        const resposta = await ghComGuarda(`https://api.github.com${caminho}`, {
          method: metodo,
          headers: {
            authorization: `Bearer ${githubToken}`,
            accept: 'application/vnd.github+json',
            ...(corpo ? { 'content-type': 'application/json' } : {}),
          },
          ...(corpo ? { body: JSON.stringify(corpo) } : {}),
        })
        if (!resposta.ok) {
          throw new Error(`GitHub ${metodo} ${caminho} falhou (${resposta.status})`)
        }
        return resposta.json()
      }

      // Uma leitura só das issues abertas do plano, reaproveitada pelos três
      // níveis: sem isto seriam três varreduras idênticas contra a API.
      let abertasDoPlano: Array<{ number: number; node_id: string; body?: string | null }> = []
      try {
        abertasDoPlano = (await rest(
          'GET',
          `/repos/${projeto.wingId}/issues?state=open&labels=${encodeURIComponent(agentLabel('po'))}&per_page=100`
        )) as typeof abertasDoPlano
      } catch (err) {
        app.log.warn(`[Scheduler] árvore de ${projeto.wingId}: ${(err as Error).message}`)
        continue
      }

      const cliente = new ProjectV2Client({ token: githubToken })
      const resultado = await varrerArvoreDoPlano({
        porta: {
          listarPaisAbertos: async (nivel) =>
            abertasDoPlano
              .filter((i) => new RegExp(`gitorch:node:\\d+:${nivel}:`).test(i.body ?? ''))
              .map((i) => ({ number: i.number, nodeId: i.node_id })),
          filhosDe: async (nodeId) =>
            (await cliente.listSubIssues(nodeId)).map((f) => ({
              number: f.number,
              aberto: !f.closed,
            })),
          fechar: async (numero, recado) => {
            await rest('POST', `/repos/${projeto.wingId}/issues/${numero}/comments`, {
              body: recado,
            })
            await rest('PATCH', `/repos/${projeto.wingId}/issues/${numero}`, { state: 'closed' })
          },
        },
        log: {
          info: (m) => app.log.info(`[Scheduler] ${projeto.wingId} ${m}`),
          warn: (m) => app.log.warn(`[Scheduler] ${projeto.wingId} ${m}`),
        },
      })
      if (resultado.fechados.length > 0) {
        app.log.info(
          `[Scheduler] árvore de ${projeto.wingId}: encerrei ${resultado.fechados.length} item(ns) de estrutura (${resultado.fechados.map((n) => `#${n}`).join(', ')})`
        )
      }
    }
  }

  const varrerPublicacoes = async (): Promise<void> => {
    let sessoes: LinhaDeSessao[]
    try {
      sessoes = await app.prisma.devSession.findMany({
        where: { closedAt: null, mergeCommitSha: { not: null } },
      })
    } catch (err) {
      app.log.error(
        err,
        '[Scheduler] varredura de publicações não conseguiu listar sessões mescladas'
      )
      return
    }
    if (sessoes.length === 0) return

    const agora = new Date()
    const candidatas = sessoesParaAcompanharPublicacao(sessoes, agora)

    for (const sessao of candidatas) {
      // Item 1 da revisão pós-Leva A: calculado ANTES do try — precisa
      // valer tanto para o caminho onde a leitura funciona (estados presos
      // que `acompanharPublicacao` devolve) quanto para os dois onde ela
      // NUNCA funciona (sem credencial; exceção no meio do caminho), que
      // levam ao `catch` mais abaixo, fora do escopo de qualquer `const`
      // declarada dentro do try.
      //
      // Importante 5 (Leva A): a fonte é a LINHA (`stateCheckedAt`, gravado
      // por `registrarMescla` no instante do merge), não um relógio em
      // memória do processo — sobrevive a reinício.
      //
      // Item 7 (leva B2) — invariante e por que `undefined` agora FECHA em
      // vez de nunca fechar: `registrarMescla` (dev-session-store.ts) é o
      // ÚNICO escritor de `mergeCommitSha`, e grava `stateCheckedAt` na
      // MESMA chamada — uma linha que chega até aqui (já filtrada por
      // `mergeCommitSha` não-nulo, na consulta acima) tem, hoje, SEMPRE
      // `stateCheckedAt` preenchido. `undefined` não deveria acontecer.
      // Antes desta correção, se acontecesse mesmo assim (edição manual do
      // banco, uma migração futura que desacople os dois campos), o código
      // tratava "não sei há quanto tempo" como "tempo desconhecido, então
      // nenhum teto dispara" — a ÚNICA direção que reabre o beco sem saída
      // que este teto absoluto existe para fechar (a sessão presa para
      // sempre, sem aviso, é sempre pior do que fechar cedo demais com
      // aviso). Por isso `undefined` agora conta como "já estourou o teto".
      const desdeAMescla = sessao.stateCheckedAt
        ? agora.getTime() - sessao.stateCheckedAt.getTime()
        : undefined
      const estourouTetoAbsoluto =
        desdeAMescla === undefined || desdeAMescla >= TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS

      // Espelhos para o `catch` mais abaixo — fora do escopo dos `const`
      // declarados dentro do try (que existem para preservar o
      // estreitamento de tipo do TypeScript dentro dos fechamentos de
      // leitura, `lerExecucoes` e companhia).
      let projetoParaCatch: Awaited<ReturnType<PrismaClient['project']['findUnique']>> = null
      let tokenParaCatch: string | undefined
      try {
        const projeto = await app.prisma.project.findUnique({ where: { id: sessao.projectId } })
        if (!projeto) continue
        projetoParaCatch = projeto

        const githubToken =
          process.env['GITORCH_GITHUB_TOKEN'] ??
          (await mintInstallationToken({
            repository: projeto.wingId,
            onError: (m) => app.log.error(m),
            onWarn: (m) => app.log.warn(m),
          })) ??
          undefined
        tokenParaCatch = githubToken
        if (!githubToken) {
          // Item 1: uma instalação revogada (ou um projeto suspenso) NUNCA
          // volta a ter credencial sozinha — é exatamente a "leitura que
          // falha para sempre" que o teto absoluto existe para fechar.
          // Antes dele, comportamento de sempre: carimba a cadência e tenta
          // de novo no próximo ciclo.
          if (estourouTetoAbsoluto) {
            await fecharComTetoAbsoluto({
              projeto,
              sessao,
              agora,
              desdeAMescla: desdeAMescla ?? TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
              ultimaObservacao:
                'perdemos a credencial do GitHub para este repositório e não conseguimos checar a publicação',
              githubToken: undefined,
            })
            continue
          }
          app.log.warn(
            `[Scheduler] varredura de publicações sem credencial do GitHub para ${projeto.wingId}; tenta no próximo ciclo`
          )
          // Importante 3 da revisão final: mesmo sem conseguir ler nada, a
          // cadência avança — senão uma instalação revogada ou um projeto
          // suspenso (credencial que nunca volta sozinha) vira reexame a
          // cada tique (~60s) em vez de dez em dez minutos, e sob limite de
          // taxa do GitHub o próprio laço alimenta o limite que o derrubou.
          await registrarCadenciaDePublicacao({
            prisma: app.prisma as unknown as PrismaDevSession,
            sessionName: sessao.sessionName,
            agora,
          }).catch((cadenciaErr) =>
            app.log.warn(
              cadenciaErr,
              `[Scheduler] falha ao carimbar cadência de publicação para ${sessao.sessionName}`
            )
          )
          continue
        }

        const declarado = comoPublicaDeclarado(projeto.runtimeConfig)

        // Quem publica na própria VM ou na mão nem chega a olhar o
        // repositório: era ESSA leitura que produzia os 403 em série (196 em
        // 24h na última contagem), porque a descoberta encontrava um ambiente
        // de outra ferramenta e passava a bater nele a cada tique. Descobrir o
        // mecanismo custa leitura no GitHub, e aqui não há o que achar.
        const mecanismo = dispensaOlharORepositorio(declarado)
          ? ({ tipo: 'nenhum' } as const)
          : await descobrirMecanismoComCache(
              projeto.wingId,
              githubToken,
              agora,
              projeto.runtimeConfig
            )
        const shaDaMescla = sessao.mergeCommitSha as string

        // Os CINCO caminhos de publicação (D49). Antes daqui o produto só
        // sabia observar o GitHub, e para quem publica fora dele — VM privada,
        // serviço externo sem registro, publicação na mão — isso significava
        // ficar 24 horas lendo o que não existe antes de desistir. Seis
        // entregas presas assim, medidas em 25/08.
        //
        // Só age quando o DONO declarou por onde publica. Sem declaração, o
        // caminho de sempre continua valendo inteiro: ele descobre pelo
        // repositório e, quando não acha nada, já fecha honestamente E
        // pergunta ao dono. Curto-circuitar ali só trocaria um desfecho bom
        // por outro pior — e faria a pergunta virar rotina.
        const desfecho = declarado
          ? desfechoDaPublicacao({ declarado, mecanismo })
          : { tipo: 'acompanhar-no-github' as const }

        if (desfecho.tipo === 'encerrar-sem-rastreio') {
          // Encerra JÁ, dizendo a verdade, em vez de esperar o teto de 24h por
          // uma confirmação impossível. O dono já disse que aqui não há o que
          // observar; insistir seria fingir que ainda vai descobrir.
          //
          // `entregue: true` de propósito: aqui o MERGE é a entrega — é a
          // mesma regra que o caminho de "o repositório provadamente não
          // publica" já aplica. Marcar "não entregue" deixaria na issue do
          // cliente um recado dizendo que a tarefa segue aberta até a
          // publicação ser confirmada, e essa confirmação nunca vai existir:
          // o card ficaria preso em revisão para sempre.
          await encerrarEntrega({
            projeto,
            sessao,
            agora,
            estado: 'sem-publicacao',
            entregue: true,
            motivo: desfecho.motivo,
            githubToken,
          })
          continue
        }

        if (desfecho.tipo === 'esperar-aviso') {
          // Antes de qualquer coisa: o CD deste cliente sabe avisar? Se não
          // souber, esperar é esperar para sempre — então o produto abre a
          // tarefa que instala a chamada lá (D50). A decisão é deduplicada,
          // então isto não vira uma issue por tique.
          await pedirOAvisoDePublicacao(projeto)

          // O aviso JÁ CHEGOU? A rota de aviso grava o veredito na linha, mas
          // quem encerra a entrega (fecha a sessão, avisa o dono, resolve o
          // card) é esta varredura — como em todos os outros caminhos. Sem
          // esta checagem a entrega ficava viva mesmo confirmada, e no fim das
          // 24 horas encerrava dizendo "o aviso não chegou", que era mentira:
          // ele tinha chegado horas antes e estava gravado ali do lado.
          if (sessao.deployState === 'no-ar' || sessao.deployState === 'falhou') {
            const chegouNoAr = sessao.deployState === 'no-ar'
            await encerrarEntrega({
              projeto,
              sessao,
              agora,
              estado: sessao.deployState,
              entregue: chegouNoAr,
              motivo: chegouNoAr
                ? 'quem publica avisou que esta versão subiu — entrega confirmada.'
                : 'quem publica avisou que a publicação desta versão FALHOU.',
              githubToken,
            })
            continue
          }

          // Publica fora do alcance do GitHub: nada a ler daqui. Quem confirma
          // é o CD do próprio cliente, pela rota de aviso de publicação
          // (`POST /api/projects/:id/publicado`). Só carimba a cadência para
          // não reexaminar a cada tique — e o teto absoluto continua valendo:
          // se o aviso nunca vier, a entrega encerra dizendo exatamente isso,
          // em vez de ficar aberta para sempre.
          if (estourouTetoAbsoluto) {
            await fecharComTetoAbsoluto({
              projeto,
              sessao,
              agora,
              desdeAMescla: desdeAMescla ?? TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
              ultimaObservacao: `${desfecho.motivo} — e esse aviso não chegou`,
              githubToken,
            })
          } else {
            await registrarCadenciaDePublicacao({
              prisma: app.prisma as unknown as PrismaDevSession,
              sessionName: sessao.sessionName,
              agora,
            }).catch((err) =>
              // Nunca em silêncio: sem a cadência carimbada esta entrega volta
              // a ser examinada a cada tique, e é justamente esse desperdício
              // que este ramo existe para evitar.
              app.log.warn(
                err,
                `[Scheduler] falha ao carimbar cadência de publicação para ${sessao.sessionName}`
              )
            )
          }
          continue
        }

        const veredito = await acompanharPublicacao({
          mecanismo,
          shaDaMescla,
          ...(desdeAMescla !== undefined ? { desdeAMescla } : {}),
          lerExecucoes: async (arquivo) => {
            const resp = (await ghGet(
              `/repos/${projeto.wingId}/actions/workflows/${arquivo}/runs?per_page=${TAMANHO_DA_PAGINA_DE_EXECUCOES}`,
              githubToken
            )) as { workflow_runs?: ExecucaoDeWorkflow[] }
            return resp.workflow_runs ?? []
          },
          lerEtapas: async (idDaExecucao) => {
            const resp = (await ghGet(
              `/repos/${projeto.wingId}/actions/runs/${idDaExecucao}/jobs`,
              githubToken
            )) as { jobs?: EtapaDaExecucao[] }
            return resp.jobs ?? []
          },
          lerPublicacoes: async (ambiente, sha) => {
            const resp = (await ghGet(
              `/repos/${projeto.wingId}/deployments?environment=${encodeURIComponent(ambiente)}&sha=${encodeURIComponent(sha)}`,
              githubToken
            )) as PublicacaoDeclarada[]
            return resp ?? []
          },
          lerEstadosDaPublicacao: async (idDaPublicacao) => {
            const resp = (await ghGet(
              `/repos/${projeto.wingId}/deployments/${idDaPublicacao}/statuses`,
              githubToken
            )) as EstadoDaPublicacao[]
            return resp ?? []
          },
        })

        // Item 1: qualquer estado NÃO-final que `acompanharPublicacao`
        // devolveu ('falhou', 'publicando', 'commit-errado') mas que já
        // passou do teto absoluto vira final AGORA — o backstop que fecha a
        // sessão mesmo quando nenhum teto ESPECÍFICO se aplicava a este
        // estado (um CD que falha e ninguém manda rodar de novo; uma
        // publicação represada esperando aprovação humana, que nunca é
        // "zero evidência" e por isso nunca entra na janela de tolerância;
        // `commit-errado` também cai aqui só como rede de segurança — na
        // prática o teto de 1h dele já resolve bem antes das 24h deste).
        if (
          veredito.estado !== 'no-ar' &&
          veredito.estado !== 'sem-publicacao' &&
          estourouTetoAbsoluto
        ) {
          await fecharComTetoAbsoluto({
            projeto,
            sessao,
            agora,
            desdeAMescla: desdeAMescla ?? TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
            ultimaObservacao: `${veredito.estado} — ${veredito.motivo}`,
            githubToken,
          })
          continue
        }

        // Achado 2: o estado ANTERIOR (antes de `registrarEstadoDaPublicacao`
        // sobrescrever) é o que decide se o dono já foi avisado desta MESMA
        // situação — "SPAM apaga sinal tanto quanto silêncio" (doutrina de
        // `session-watch.ts`). Lido AQUI, antes da escrita.
        const estadoAnterior = sessao.deployState

        await registrarPublicacaoEIncremento({ sessao, estado: veredito.estado, agora })

        if (veredito.estado === 'no-ar') {
          // A publicação PROVOU que é deste commit — agora o juiz abre o
          // endereço de verdade. O ensaio não decide se a sessão fecha (a
          // publicação já aconteceu, isso é fato consumado); é informação
          // ADICIONAL para o dono, sempre carregando o `motivo` (Tarefa 14),
          // nunca só o veredito — é ali que mora, por exemplo, o aviso de um
          // endereço recusado pela guarda antes de qualquer chamada.
          //
          // Menor 9 da revisão final da branch: no caminho de DEPLOYMENT o
          // GitHub entrega o endereço DE GRAÇA (`environment_url`,
          // `veredito.enderecos`, já comprovado do commit exato pela Tarefa
          // 13). No caminho de WORKFLOW não existe esse presente — nenhuma
          // leitura usada por `acompanharPorWorkflow` devolve URL — então
          // `veredito.enderecos` sai SEMPRE vazio ali, e sem isto o ensaio
          // ficava inerte (`sem-endereco`) para todo repositório que publica
          // por workflow, inclusive um projeto real do cliente. O endereço,
          // quando existe, só pode vir da CONFIGURAÇÃO do próprio projeto
          // (`runtimeConfig.ambientes.endereco`, irmã de `ambientes.caminhos`
          // — Tarefa 17). Sem essa configuração o comportamento honesto de
          // sempre se mantém: `testarAmbiente` responde `sem-endereco`,
          // visível ao dono na mesma nota que já acompanha todo veredito —
          // nunca um endereço inventado, e sempre pela guarda de rede
          // (`enderecoPermitido`/`buscarComGuarda`), exatamente como o
          // caminho de deployment.
          const enderecoConfigurado =
            mecanismo.tipo === 'workflow' ? resolveEnderecoDeAmbiente(projeto.runtimeConfig) : null
          const enderecosParaTestar =
            veredito.enderecos.length > 0
              ? veredito.enderecos
              : enderecoConfigurado
                ? [enderecoConfigurado]
                : veredito.enderecos
          const relatorio = await testarAmbiente({
            enderecos: enderecosParaTestar,
            // Configuração POR PROJETO (`runtimeConfig.ambientes.caminhos`,
            // Tarefa 14/17) — nunca chuta rota de cliente; sem config, testa
            // só a raiz.
            caminhos: resolveCaminhosDeAmbiente(projeto.runtimeConfig),
            buscar: buscarComGuarda,
          }).catch((err) => {
            app.log.warn(err, `[Scheduler] QA de ambiente falhou para ${sessao.sessionName}`)
            return null
          })
          const notaDeAmbiente = relatorio
            ? ` Ensaio do ambiente: ${relatorio.veredito} — ${relatorio.motivo}`
            : ''

          // O ensaio do ambiente REPROVADO também volta atrás: o produto
          // enxergava a tela não responder e a coisa morria num aviso de
          // chat. Agora vira tarefa de conserto, pelo MESMO serviço que
          // trata a publicação que falhou — só a evidência muda (a tela e o
          // código HTTP, no lugar das etapas do fluxo de publicação).
          //
          // Um ambiente INALCANÇÁVEL na primeira leitura é a exceção: pode
          // ser uma queda de rede de trinta segundos do lado de cá, e abrir
          // tarefa por isso é fabricar ruído no quadro do CLIENTE. Nesse
          // caso a entrega não fecha ainda — a próxima janela da vigília lê
          // de novo e decide com duas leituras na mão. Adia no MÁXIMO uma
          // janela: na segunda leitura o fecho acontece dando no que der.
          let numeroDoConserto: number | null = null
          if (relatorio) {
            const vereditoAnterior = sessao.envLastVerdict
            const observacoesSeguidas = vereditoAnterior === relatorio.veredito ? 2 : 1
            const marcou = await registrarVereditoDeAmbiente({
              prisma: app.prisma as unknown as PrismaDevSession,
              sessionName: sessao.sessionName,
              veredito: relatorio.veredito,
            })
              .then(() => true)
              .catch((err) => {
                app.log.warn(
                  err,
                  `[Scheduler] veredito do ambiente não pôde ser gravado para ${sessao.sessionName}`
                )
                return false
              })

            // Só adia quando a marca FOI gravada: sem ela a próxima leitura
            // recomeçaria a contagem do zero, e a entrega nunca fecharia.
            if (
              marcou &&
              aguardaSegundaLeituraDoAmbiente({
                veredito: relatorio.veredito,
                observacoesSeguidas,
                recusadoPelaGuarda: relatorio.recusadoPelaGuarda,
              })
            ) {
              app.log.warn(
                `[Scheduler] ambiente de ${projeto.wingId} não respondeu na primeira leitura de ${sessao.sessionName}; confirmando na próxima janela antes de decidir`
              )
              // A cadência TEM que ser carimbada antes de sair por aqui. Sem
              // isto o `continue` pula o carimbo lá do fim do laço, a sessão é
              // reexaminada a cada tique (~60s) em vez de a cada dez minutos,
              // e a "segunda leitura" chega um MINUTO depois da primeira. Uma
              // queda de rede de trinta segundos passaria a produzir duas
              // leituras seguidas de 'inalcancavel' e abriria issue falsa no
              // repositório do CLIENTE — exatamente o que a regra das duas
              // leituras existe para impedir. Todos os outros `continue` deste
              // laço carimbam antes de sair; este era o único que não.
              await registrarCadenciaDePublicacao({
                prisma: app.prisma as unknown as PrismaDevSession,
                sessionName: sessao.sessionName,
                agora,
              }).catch((cadenciaErr) =>
                app.log.warn(
                  cadenciaErr,
                  `[Scheduler] falha ao carimbar cadência de publicação para ${sessao.sessionName}`
                )
              )
              continue
            }

            numeroDoConserto = await abrirConsertoDePublicacao({
              projeto,
              sessao,
              evidencia: {
                origem: 'ambiente',
                veredito: relatorio.veredito,
                motivo: relatorio.motivo,
                enderecos: enderecosParaTestar,
                recusadoPelaGuarda: relatorio.recusadoPelaGuarda,
                testes: relatorio.testes,
                observacoesSeguidas,
              },
            })
          }
          const notaDoConserto = numeroDoConserto === null ? '' : notaDeConserto(numeroDoConserto)

          app.log.info(
            `[Scheduler] publicação confirmada para ${sessao.sessionName} (${veredito.motivo}).${notaDeAmbiente}`
          )
          await fecharSessaoEArquivar({
            sessionName: sessao.sessionName,
            motivo: 'merged',
            agora,
          })
          await avisarDonoDoProjeto(
            projeto,
            `GitOrch: a entrega de ${projeto.wingId} foi ao ar. ${veredito.motivo}${notaDeAmbiente}${notaDoConserto}`
          )
          // Item 2/Leva B: só AGORA — com a publicação confirmada — a
          // tarefa fecha como entregue e o card vai para "done". Nunca no
          // merge (desenho antigo, `qa-rails-mission.ts`).
          await resolverEntregaDoBoard({
            projeto,
            sessao,
            githubToken,
            entregue: true,
            motivo: veredito.motivo,
          })
        } else if (veredito.estado === 'falhou' || veredito.estado === 'commit-errado') {
          // Não fecha: o CD pode ser retentado pelo cliente, e uma execução
          // presa na fila (commit-errado) pode ser sucedida pela certa —
          // `sessoesParaAcompanharPublicacao` reexamina no próximo ciclo.
          //
          // Achado 2 da revisão: sem teto de mescla igual a Tarefa 10, esta
          // varredura reexamina esta sessão a CADA cadência (dez em dez
          // minutos) até o veredito virar outra coisa — e sem dedupe, cada
          // reexame reenviava o MESMO aviso, para sempre. "SPAM apaga sinal
          // tanto quanto silêncio" (doutrina de `session-watch.ts`). O
          // dedupe é por TRANSIÇÃO DE ESTADO (`estadoAnterior`, lido acima,
          // antes da escrita): mesma leitura de antes ('falhou' seguido de
          // 'falhou', ou 'commit-errado' seguido de 'commit-errado') não
          // reavisa; qualquer mudança real (inclusive a alternância entre os
          // dois, ou a primeira vez) rearma o aviso.
          //
          // O que faltava: além de AVISAR, agir. Uma publicação que falhou
          // volta atrás como tarefa de conserto no repositório do cliente,
          // no padrão que o Scrum Master exige para poder delegá-la — fora
          // do padrão ela nasceria morta. A sessão NÃO fecha aqui: a entrega
          // continua sem estar no ar, e fechá-la seria mentir para o quadro.
          // O dedup vive na própria linha da sessão (`deployFixKey`), por
          // commit: sem ele, cada varredura abriria mais uma issue no
          // repositório do CLIENTE, para sempre.
          const numeroDoConserto = await abrirConsertoDePublicacao({
            projeto,
            sessao,
            evidencia: {
              origem: 'publicacao',
              estado: veredito.estado,
              motivo: veredito.motivo,
              etapas: veredito.etapas,
            },
          })
          // UM aviso, não dois: o aviso reabre quando o estado muda (a
          // leitura é nova) ou quando o conserto acabou de virar tarefa (o
          // dono precisa do número da issue) — nunca a cada varredura.
          if (estadoAnterior !== veredito.estado || numeroDoConserto !== null) {
            const etapasTexto = veredito.etapas.map((e) => `${e.nome}: ${e.resultado}`).join('; ')
            await avisarDonoDoProjeto(
              projeto,
              `GitOrch: a publicação de ${projeto.wingId} (commit ${shaDaMescla}) precisa de atenção — ${veredito.motivo}${etapasTexto ? ` Etapas: ${etapasTexto}.` : ''}${numeroDoConserto === null ? '' : notaDeConserto(numeroDoConserto)}`
            )
          }
        } else if (veredito.estado === 'sem-publicacao') {
          app.log.info(
            `[Scheduler] ${projeto.wingId} não publica (${veredito.motivo}) — encerrando ${sessao.sessionName}`
          )
          await fecharSessaoEArquivar({
            sessionName: sessao.sessionName,
            motivo: 'merged',
            agora,
          })
          // Achado 3 da revisão: fechar em silêncio era o caminho mais
          // provável de esconder uma falha real (junto do achado 1 — zero
          // evidência virando "não publica" cedo demais). O dono é avisado
          // UMA vez, aqui mesmo, porque `sem-publicacao` é sempre um
          // veredito FINAL (a sessão fecha e nunca mais é reexaminada) —
          // este `avisarDonoDoProjeto` só roda uma vez por sessão por
          // construção, sem precisar de dedupe. A mensagem diz em
          // linguagem de negócio, sem jargão, qual dos dois motivos foi:
          // repositório sem mecanismo de publicação nenhum (Tarefa 12 já
          // sabia, na hora) ou janela de espera esgotada sem nada aparecer
          // (achado 1).
          const motivoDeNegocio =
            mecanismo.tipo === 'nenhum'
              ? 'não identificamos, no GitHub, como este repositório publica o código (nenhum ambiente ou fluxo de publicação configurado) — o código está mesclado, mas o GitOrch não tem como confirmar que ele foi ao ar.'
              : 'esperamos, mas não apareceu nenhuma publicação para este commit dentro do tempo de espera — pode ser um CD que não roda para este tipo de mudança, ou algo que precisa de atenção manual.'
          await avisarDonoDoProjeto(
            projeto,
            `GitOrch: a entrega de ${projeto.wingId} (commit ${shaDaMescla}) foi mesclada, mas ${motivoDeNegocio} ${veredito.motivo}`
          )

          // E PERGUNTA, em vez de só avisar — ordem do dono (D47): "se os
          // agentes do gitorch tem duvidas sobre o projeto, deve-se usar sempre
          // o askquestions SEMPRE, nao podem achar nada".
          //
          // O aviso acima conta o que aconteceu; ele não resolve nada sozinho,
          // porque o produto continua sem saber como aquele projeto vai ao ar.
          // Medido no patinhas: nenhum ambiente do repositório se declara
          // produção, porque a publicação real acontece nas VMs do dono — e
          // isso o GitHub nunca vai contar. Adivinhando, o produto ficou 992
          // vezes em 24 horas batendo num 403.
          //
          // `ask` deduplica pela chave: respondida uma vez para aquele
          // repositório, a pergunta não volta. É a segunda metade do pedido do
          // dono, "para que nunca mais questione o usuario".
          // O serviço é decorado pelo plugin do Telegram (plugins/telegram.ts):
          // a MESMA instância que cria a pergunta e a entrega com botões.
          // Ausente quando o Telegram não está ligado — aí o produto segue com
          // o aviso acima, que é o que ele consegue.
          await perguntarComoPublica(projeto)
          // Item 2/Leva B: "sem-publicacao" tem DOIS motivos honestos bem
          // diferentes — o repositório PROVADAMENTE não publica (aqui o
          // merge JÁ é a entrega: fecha como entregue, card vai para
          // "done") ou esperamos e não apareceu nada dentro do prazo (aqui
          // NÃO fecha como entregue — ver `resolverEntregaDoBoard`, card
          // volta para "review", tarefa fica aberta com o motivo).
          await resolverEntregaDoBoard({
            projeto,
            sessao,
            githubToken,
            entregue: mecanismo.tipo === 'nenhum',
            motivo: veredito.motivo,
          })
        }
        // 'publicando': nada a fazer agora — a próxima passagem (depois da
        // cadência) reexamina.
      } catch (err) {
        app.log.warn(
          err,
          `[Scheduler] varredura de publicação falhou na sessão ${sessao.sessionName}; tenta no próximo ciclo`
        )
        // Item 1: a MESMA "leitura que nunca funciona" do ramo "sem
        // credencial" mais acima, só que descoberta mais tarde (a
        // credencial existia, mas uma chamada no meio do caminho falhou —
        // 403 persistente, por exemplo). `projetoParaCatch` só fica
        // preenchido se a falha aconteceu DEPOIS de resolver o projeto; sem
        // ele não há como avisar o dono nem escrever no board, então cai no
        // comportamento de sempre (só carimba a cadência).
        if (estourouTetoAbsoluto && projetoParaCatch) {
          await fecharComTetoAbsoluto({
            projeto: projetoParaCatch,
            sessao,
            agora,
            desdeAMescla: desdeAMescla ?? TETO_ABSOLUTO_DE_ACOMPANHAMENTO_MS,
            ultimaObservacao: `a leitura do GitHub falhou repetidamente (${String(err).slice(0, 160)})`,
            githubToken: tokenParaCatch,
          }).catch((fecharErr) =>
            app.log.warn(
              fecharErr,
              `[Scheduler] fechar por teto absoluto falhou para ${sessao.sessionName}`
            )
          )
          continue
        }
        // Importante 3 da revisão final: a cadência avança mesmo numa
        // exceção no meio do caminho (um 403 do GitHub, por exemplo) — sem
        // isto, uma falha PERSISTENTE reexamina a cada tique (~60s) em vez
        // de dez em dez minutos, e sob limite de taxa do GitHub o próprio
        // laço alimenta o limite que o derrubou.
        await registrarCadenciaDePublicacao({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName: sessao.sessionName,
          agora,
        }).catch((cadenciaErr) =>
          app.log.warn(
            cadenciaErr,
            `[Scheduler] falha ao carimbar cadência de publicação para ${sessao.sessionName}`
          )
        )
      }
    }
  }

  // A agenda padrão vale para TODO projeto ativo, não só para os que nasceram
  // depois de ela existir.
  //
  // `ensureDefaultSchedules` só era chamada na criação do projeto. Quando um
  // papel novo entra na agenda padrão — foi o caso do `qa` — os projetos que
  // já existiam ficavam para trás em silêncio, e a correção não valia para
  // ninguém em produção. Roda UMA vez por processo, é idempotente por papel, e
  // um erro aqui não fica gravado como "já feito": a marca só é assumida
  // depois do sucesso, então o próximo tique tenta de novo.
  let agendasCompletadas = false
  const completarAgendasDosProjetos = async () => {
    if (agendasCompletadas) return
    try {
      const projetos = await app.prisma.project.findMany({
        where: { isActive: true },
        select: { id: true },
      })
      let criadas = 0
      for (const projeto of projetos) {
        criadas += await ensureDefaultSchedules(app.prisma, projeto.id)
      }
      agendasCompletadas = true
      if (criadas > 0) {
        app.log.info(
          `[Scheduler] agenda padrão completada: ${criadas} entrada(s) criada(s) em ${projetos.length} projeto(s)`
        )
      }
    } catch (err) {
      app.log.error(err, '[Scheduler] falha ao completar a agenda padrão; tenta no próximo tique')
    }
  }

  /** De hora em hora, como o vigia do GitHub. */
  const CADENCIA_DA_RENOVACAO_DE_MOTORES_MS = 60 * 60_000
  let ultimaRenovacaoDeMotores = 0

  /**
   * Renova UM motor: materializa a credencial num HOME temporário, chama o CLI
   * e devolve ao cofre o que ele renovou.
   *
   * É o caminho já provado do executor local, e a prova de que funciona é de
   * 20/08: rodar o CLI no HOME do usuário fez o token pular de 20/07 para
   * 20/08. O refresh token ainda valia; o que faltava era chamar o CLI.
   *
   * O prompt é o menor possível de propósito — a renovação é efeito colateral
   * de o CLI subir, não do que ele responde. Gastar contexto aqui seria pagar
   * duas vezes pelo mesmo efeito.
   */
  const renovarUmMotor = async (
    userId: string,
    runtime: string
  ): Promise<{ ok: boolean; saida: string }> => {
    // UMA RENOVAÇÃO POR VEZ, e a trava vale contra o OUTRO caminho também: a
    // captura que roda depois de cada missão. O refresh token de alguns
    // provedores é de uso único, e duas renovações simultâneas fazem a segunda
    // queimar o token — derrubando a credencial do cliente por culpa nossa.
    // Medido em 26/08 com o codex: "Your refresh token has already been used".
    const minhaVez = await pegarATrava({
      prisma: app.prisma as unknown as PrismaParaTrava,
      userId,
      runtime,
      agora: new Date(),
    }).catch(() => false)
    if (!minhaVez) {
      // Não é erro: alguém está renovando agora. A próxima passada tenta.
      return { ok: true, saida: 'outra renovação desta conta já está em curso' }
    }

    const dir = path.join(os.tmpdir(), `gitorch-renova-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const materializou = await app.engineConnections.materializeToHome(userId, runtime, dir)
      if (!materializou) return { ok: false, saida: 'sem credencial no cofre' }

      // O MESMO comando da checagem de vida, e não um prompt: subir o CLI já
      // basta para ele renovar o token, e um comando barato de listar/status
      // não gasta cota nem contexto do cliente. Reaproveitado de
      // engine-liveness.ts para não existirem dois mapas de binário.
      const comando = livenessCommandFor(runtime)
      if (!comando) return { ok: false, saida: `motor ${runtime} sem comando conhecido` }

      const execucao = await Promise.resolve(
        realRuntimeCommandRunner({
          binary: comando.bin,
          args: comando.args,
          cwd: dir,
          env: { ...process.env, HOME: dir } as Record<string, string>,
          timeoutMs: 120_000,
        })
      ).catch((err: unknown) => ({
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }))

      // No FINALLY do try, não no caminho de sucesso: mesmo uma chamada que
      // termina mal pode ter renovado a credencial antes de terminar, e jogar
      // isso fora é perder de graça uma credencial boa.
      await app.engineConnections
        .captureFromHome(userId, runtime, dir)
        .catch((err: unknown) =>
          app.log.warn(`[Scheduler] não deu para devolver ${runtime} ao cofre: ${String(err)}`)
        )

      const saida = `${execucao.stdout ?? ''}\n${execucao.stderr ?? ''}`
      return { ok: execucao.exitCode === 0, saida }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await soltarATrava({
        prisma: app.prisma as unknown as PrismaParaTrava,
        userId,
        runtime,
        agora: new Date(Date.now() + VALIDADE_DA_TRAVA_MS),
      }).catch(() => undefined)
    }
  }

  /**
   * O vigia que mantém os MOTORES vivos (promessa do dono: "conectar uma vez e
   * nunca mais").
   *
   * O motor que roda missão se renova de tabela — o CLI renova sozinho quando é
   * chamado, provado ao vivo em 20/08. O que morre é o motor que fica dias
   * PARADO: foi assim que o codex venceu em 29/07 sem ninguém notar e a esteira
   * ficou parada de 17 a 20/08.
   *
   * Renovar aqui é chamar o CLI num HOME temporário e devolver ao cofre o que
   * ele renovou — o mesmo caminho já provado do executor local, que
   * materializa, roda e captura de volta.
   *
   * Contas do MESMO provedor vão em SÉRIE: em alguns provedores o refresh token
   * é rotativo, e renovar duas contas do mesmo provedor em paralelo perde uma
   * delas. Provedores diferentes correm juntos, que não têm esse risco.
   *
   * Nunca rejeita: falha aqui não pode derrubar o tique.
   */
  const renovarMotoresDoRelogio = async (): Promise<void> => {
    if (Date.now() - ultimaRenovacaoDeMotores < CADENCIA_DA_RENOVACAO_DE_MOTORES_MS) return
    ultimaRenovacaoDeMotores = Date.now()

    const agora = new Date()
    const conexoes = await app.prisma.engineConnection.findMany({
      where: { runtime: { not: 'github' } },
      select: { userId: true, runtime: true, status: true, expiresAt: true, updatedAt: true },
    })

    const aRenovar = conexoes.filter((c) => decidirRenovacaoDoMotor(c, agora).tipo === 'renovar')
    if (aRenovar.length === 0) return

    // Um grupo por provedor; dentro do grupo, um de cada vez.
    await Promise.all(
      agruparPorProvedor(aRenovar).map(async (grupo) => {
        for (const conexao of grupo) {
          const motivo = decidirRenovacaoDoMotor(conexao, agora).motivo
          const resultado = await renovarUmMotor(conexao.userId, conexao.runtime)
          if (resultado.ok) {
            app.log.info(
              `[Scheduler] motor ${conexao.runtime} do dono ${conexao.userId} renovado (${motivo})`
            )
            continue
          }
          if (ehRevogacaoDefinitiva(resultado.saida)) {
            // A ÚNICA exceção à promessa de conectar uma vez e nunca mais — e
            // exceção significa AVISAR, não marcar em silêncio. Antes disto o
            // aviso ia só para o log, que ninguém lê, e o dono só descobria
            // quando a esteira parava. Pergunta dele, textual: "pq não recebo
            // informação via telegram pra fazer renew?".
            app.log.warn(
              `[Scheduler] motor ${conexao.runtime} do dono ${conexao.userId} foi REVOGADO; o cliente precisa reconectar`
            )
            const jaEstavaCaido = !deveAvisarSobreOMotor(conexao.status)
            await app.prisma.engineConnection
              .updateMany({
                where: { userId: conexao.userId, runtime: conexao.runtime },
                data: { status: 'needs_reconnect' },
              })
              .catch(() => undefined)

            // Só na VIRADA: a vigília roda de hora em hora, e sem isto o mesmo
            // recado chegaria vinte e quatro vezes por dia. Spam apaga sinal
            // tanto quanto silêncio.
            if (!jaEstavaCaido) {
              const dono = await app.prisma.user
                .findUnique({ where: { id: conexao.userId }, select: { email: true } })
                .catch(() => null)
              const chatId = await resolveNotifyChatId(
                app.prisma,
                { userId: conexao.userId, user: dono },
                {
                  instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
                  instanceChatId:
                    process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
                }
              ).catch(() => null)
              const avisar = buildTelegramNotifier({
                botToken:
                  process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
                ...(chatId ? { chatId } : {}),
              })
              if (avisar) await avisar(recadoDeMotorRevogado(conexao.runtime))
            }
            continue
          }
          // Transitório: tenta de novo na próxima passada, calado. Marcar como
          // revogado por causa de uma queda de rede seria tirar o acesso do
          // cliente por um problema nosso.
          app.log.warn(
            `[Scheduler] não deu para renovar ${conexao.runtime} do dono ${conexao.userId} agora; tenta na próxima hora`
          )
        }
      })
    )
  }

  /**
   * Relê a cota dos motores pelo RELÓGIO, não por missão completada.
   *
   * O caminho antigo (`refreshModels` depois de cada missão) tinha dois nós
   * cegos medidos em 30/08: só rodava depois de uma missão COMPLETAR, e saía
   * antes se o catálogo de modelos viesse vazio. Motor parado um dia = painel
   * do dono sem número novo — e número velho de cota é pior que número
   * ausente, porque parece verdade.
   *
   * Nunca rejeita: uma conexão que falha não pode derrubar o tique inteiro.
   */
  const varrerCotasDosMotores = async () => {
    const conexoes = await app.prisma.engineConnection.findMany({
      select: { userId: true, runtime: true, status: true, quotaRefreshedAt: true },
    })
    const vencidas = cotasAReler(conexoes, new Date())
    if (vencidas.length === 0) return
    for (const conexao of vencidas) {
      // Em série de propósito: cada leitura materializa a credencial num HOME
      // temporário e roda o binário do motor. Em paralelo, dois motores do
      // mesmo dono disputariam o mesmo refresh token de uso único — o defeito
      // que derrubou a conta do Codex em 26/08.
      try {
        const leu = await app.engineConnections.refreshQuota(conexao.userId, conexao.runtime)
        if (!leu) {
          app.log.debug(
            `[Scheduler] cota do ${conexao.runtime} não veio nesta passada; o painel segue sem número em vez de mostrar o antigo`
          )
        }
      } catch (err) {
        app.log.warn(err, `[Scheduler] falhou ao reler a cota do ${conexao.runtime}`)
      }
    }
  }

  /**
   * Garante o campo Sprint no quadro de cada projeto — a caixa "Acerta o campo
   * Sprint" que o fluxograma da leva 2 promete e que NUNCA existiu no produto.
   *
   * `garantirSprintNoQuadro` foi construída e testada no bloco 3 e ficou ÓRFÃ:
   * nenhum caminho de produção a chamava. Conferido na fonte em 30/08 — o
   * quadro #2 do gitorch tinha os 13 campos padrão do GitHub e nenhum campo de
   * iteração. Se a função tivesse rodado uma vez, o campo existiria.
   *
   * Roda no RELÓGIO, e não ao plugar, por dois motivos: os projetos que já
   * existem nunca passariam de novo pelo onboarding, e um quadro que perde o
   * campo (o cliente pode apagá-lo) volta a ser consertado sozinho.
   *
   * ESCREVE NO QUADRO DO CLIENTE, então cada chamada vai embrulhada em
   * `fetchDoRepositorio` com o nível daquele projeto. GraphQL não carrega o
   * repositório na URL — a mutation nomeia o quadro por id —, então a guarda
   * por endereço (`ghComGuarda`) não serve aqui e o nível entra explícito.
   *
   * Nunca rejeita: um projeto que falha não derruba o tique nem os outros.
   */
  const varrerSprintDosProjetos = async () => {
    const projetos = await app.prisma.project.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        wingId: true,
        autonomia: true,
        sprintDias: true,
        userId: true,
      },
    })
    if (projetos.length === 0) return

    const { resultados } = await garantirSprintDosProjetos({
      listarProjetos: async () => projetos,

      // A credencial que ALCANÇA este repositório. O App do produto não
      // enxerga quadro de conta pessoal ("Resource not accessible by
      // integration", provado no patinhas-3d-crafts): para esses vale a
      // credencial do próprio cliente, guardada cifrada no projeto — o campo
      // existe exatamente para onde o App não chega. Preferimos a do cliente
      // quando ela existe, porque é a que tem o alcance maior.
      credencialDoProjeto: async (p) => {
        const doCliente = await lerCredencialDoProjeto({ prisma: app.prisma, projectId: p.id })
        if (doCliente) return { token: doCliente, origem: 'cliente' as const }
        const doApp = p.userId
          ? ((await app.engineConnections?.getRawGithubToken(p.userId)) ?? null)
          : null
        return doApp ? { token: doApp, origem: 'app' as const } : null
      },

      quadroDoProjeto: async (p, token) => {
        // COM TETO. Sem ele, uma conexão pendurada com o GitHub (rede parada,
        // sem RST) trava esta varredura, e como ela roda dentro do tique sob
        // `tickEmAndamento`, trava o RELÓGIO INTEIRO — nenhuma missão, nenhuma
        // cota, nenhum deploy, e o único sinal seria "tick anterior ainda em
        // andamento" a cada 60s. Nada falha, então nenhum vigia pega.
        const cliente = new ProjectV2Client({
          token,
          fetchImpl: fetchComTeto(fetchSemPermissao(), TIMEOUT_DE_CHAMADA_GITHUB_MS),
        })
        const [owner, repo] = p.wingId.split('/')
        const quadros = await cliente.listarQuadrosDoRepositorio({
          owner: owner ?? '',
          repo: repo ?? '',
        })
        return decidirQuadro({ candidatos: quadros.map((q) => ({ ...q, linkado: true })) })
      },

      // O cliente que ESCREVE: guarda de autonomia com o nível deste projeto,
      // lido na hora da chamada (o dono pode mudar pelo painel a qualquer
      // momento e a mudança não pode esperar um ciclo).
      clienteDeQuadro: (p, token) =>
        new ProjectV2Client({
          token,
          // `fetchDoRepositorio` já junta teto de tempo e guarda de autonomia;
          // o teto vai explícito para ficar igual ao resto do relógio.
          fetchImpl: fetchDoRepositorio({
            nivel: () => p.autonomia,
            timeoutMs: TIMEOUT_DE_CHAMADA_GITHUB_MS,
          }),
        }),

      garantir: (cliente, args) =>
        garantirSprintNoQuadro(cliente, {
          ...args,
          // No FUSO DO DONO, não no do servidor. Quem LÊ a sprint já usa
          // `hojeNoFuso()`; se quem ESCREVE usar UTC, entre 21h e a meia-noite
          // de Brasília os dois discordam e o painel diz "quadro configurado,
          // nenhuma sprint correndo" por até 3 horas.
          hoje: hojeNoFuso(),
        }),
      log: {
        warn: (m: string) => app.log.warn(m),
        info: (m: string) => app.log.info(m),
        debug: (m: string) => app.log.debug(m),
      },
    })

    // Só o que MUDOU vira linha de log. "Já estava pronto" é o caso comum a
    // cada minuto — registrá-lo encheria o log e esconderia o que importa.
    for (const r of resultados) {
      if (r.estado === 'criado' || r.estado === 'configurado') {
        app.log.info(`[Scheduler] sprint no quadro de ${r.repo}: ${r.estado} — ${r.motivo}`)
      } else if (r.estado === 'falhou') {
        app.log.warn(`[Scheduler] sprint de ${r.repo} não deu nesta passada: ${r.motivo}`)
      } else if (
        r.estado === 'conflito_de_nome' ||
        r.estado === 'sem_credencial' ||
        // `sem_quadro` existia no resultado e não aparecia em ramo nenhum do
        // log: o projeto travado numa escolha de quadro ficava invisível aqui
        // pelo mesmo motivo que ficava na varredura irmã. Ele já vinha DITO por
        // ela (`garantir-sprint-dos-projetos.ts`), com o motivo dentro, e morria
        // fora desta lista — metade da lição aplicada é silêncio do mesmo jeito.
        r.estado === 'sem_quadro'
      ) {
        // Estados que só o DONO resolve. Precisam aparecer: um projeto preso
        // aqui fica sem sprint para sempre, e sem log ninguém descobre por quê
        // — o mesmo silêncio que esta leva veio acabar. Não é `warn` de defeito
        // nosso; é aviso de que falta uma ação dele.
        app.log.info(`[Scheduler] sprint de ${r.repo} depende de você: ${r.motivo}`)
      }
    }
  }

  /**
   * Põe DENTRO da sprint o trabalho que o produto tem em mãos agora.
   *
   * A irmã de cima (`varrerSprintDosProjetos`) garante que o CICLO existe.
   * Esta garante que ele não fica vazio. Eram metades do mesmo trabalho, e só
   * a primeira tinha sido feita: medido em 31/08/2026 no quadro #2 do dono,
   * 122 itens e 4 com o campo Sprint preenchido — os 4 criados naquele dia,
   * porque `setSprint` só dispara no instante em que o Produto monta a árvore.
   * O que já estava no quadro nunca entrava em ciclo nenhum, e o painel
   * anunciava "Sprint 1 · 30 ago a 1 set" sem um item dentro.
   *
   * NÃO roda a cada tique. Uma sprint dura dias; entrar no ciclo dez minutos
   * depois de o trabalho começar é indistinguível de entrar na hora, e a cada
   * minuto seriam cinco chamadas por projeto ao GitHub para, quase sempre,
   * não mudar nada.
   *
   * Nunca rejeita: um projeto que falha não derruba o tique nem os outros.
   */
  const CADENCIA_PADRAO_DOS_ITENS_DA_SPRINT_MS = 10 * 60_000
  const CADENCIA_DOS_ITENS_DA_SPRINT_MS = (() => {
    const bruto = process.env['GITORCH_SPRINT_ITENS_CADENCIA_MS']
    if (bruto === undefined) return CADENCIA_PADRAO_DOS_ITENS_DA_SPRINT_MS
    const lido = Number(bruto)
    // Mesma cicatriz de `GITORCH_RECONCILIACAO_CADENCIA_MS`: `Number(x) ?? padrão`
    // NÃO protege nada — string vazia vira 0, texto vira NaN, negativo passa
    // inteiro, e nos três casos `agora - ultima < cadência` é sempre falsa. A
    // varredura passaria a rodar a CADA TIQUE, ou seja, cinco chamadas por
    // projeto ao GitHub por minuto, por causa de um erro de digitação.
    if (!Number.isFinite(lido) || lido <= 0) {
      app.log.warn(
        `[Scheduler] GITORCH_SPRINT_ITENS_CADENCIA_MS inválido ('${bruto}'); ` +
          `usando o padrão de ${CADENCIA_PADRAO_DOS_ITENS_DA_SPRINT_MS}ms`
      )
      return CADENCIA_PADRAO_DOS_ITENS_DA_SPRINT_MS
    }
    return lido
  })()
  let ultimaVarreduraDeItensDaSprint = 0

  /**
   * As issues abertas em que algum agente está com a bola.
   *
   * UMA CHAMADA POR ETIQUETA porque o parâmetro `labels` da API do GitHub é
   * E, não OU: mandar as três juntas traria só as issues que têm as três ao
   * mesmo tempo, que é sempre nenhuma. São três chamadas a cada dez minutos.
   */
  /**
   * Itens por página e teto de páginas: mil issues abertas POR ETIQUETA.
   *
   * O teto existe para não girar para sempre num repositório absurdo, e é
   * generoso de propósito — `gitorch:agent:sm`, `:jules` e `:qa` só marcam o
   * que está em execução AGORA; mil delas abertas ao mesmo tempo já é um
   * estado que o dono precisa saber, e é justamente o que o aviso diz.
   */
  const ISSUES_POR_PAGINA = 100
  const MAX_PAGINAS_DE_ISSUES = 10

  const issuesComEtiquetaDeExecucao = async (
    repo: string,
    githubToken: string,
    /** Chamado quando o teto cortou a leitura de uma etiqueta. */
    onTruncado?: (etiqueta: string, lidas: number) => void
  ): Promise<number[]> => {
    const numeros = new Set<number>()
    for (const etiqueta of ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA) {
      let lidas = 0
      // Começa VERDADEIRO: só vira falso quando uma página volta incompleta,
      // que é a única prova de que a lista acabou. Sair do laço pelo teto
      // deixa o aviso de pé — o lado seguro é avisar a mais.
      let cortou = true
      for (let pagina = 1; pagina <= MAX_PAGINAS_DE_ISSUES; pagina++) {
        // PAGINA DE VERDADE. Sem `page`, o GitHub devolve só as cem primeiras
        // e o resto SOME — sem erro e sem log. É o mesmo defeito que o
        // `items(first: 100)` do quadro tinha até hoje de manhã, e não era
        // teórico lá: 18 de 118 itens sumiam, incluindo as issues que o dev
        // assíncrono estava trabalhando naquele instante.
        //
        // O fim da lista é detectado pela página INCOMPLETA, e não pelo header
        // `Link`, porque `ghGet` devolve o JSON já lido — trocar a assinatura
        // dele para expor headers mexeria em todas as outras leituras do
        // relógio. Os dois critérios dizem a mesma coisa: quando o `Link` não
        // traz `rel="next"`, a página veio com menos de `per_page`. O custo é
        // no máximo uma chamada a mais, quando o total é múltiplo exato de 100.
        const lista = (await ghGet(
          `/repos/${repo}/issues?state=open&per_page=${ISSUES_POR_PAGINA}` +
            `&page=${pagina}&labels=${encodeURIComponent(etiqueta)}`,
          githubToken
        )) as Array<{ number?: number; pull_request?: unknown }> | null
        const recebidas = lista?.length ?? 0
        lidas += recebidas
        for (const item of lista ?? []) {
          // A rota `/issues` devolve PULL REQUEST junto (o GitHub trata PR como
          // issue). O PR que importa já entra pela sessão viva, com o motivo
          // certo; deixá-lo entrar aqui de novo trocaria o motivo no relatório.
          if (typeof item.number === 'number' && !item.pull_request) numeros.add(item.number)
        }
        if (recebidas < ISSUES_POR_PAGINA) {
          cortou = false
          break
        }
      }
      // Teto silencioso recria o defeito que a paginação veio consertar, só
      // que mais tarde e maior. Mesmo contrato do `onTruncado` do quadro.
      if (cortou) onTruncado?.(etiqueta, lidas)
    }
    return [...numeros]
  }

  /**
   * Quando o quadro NÃO foi decidido: dizer, em vez de sumir.
   *
   * `decidirQuadro` se recusa a adivinhar DE PROPÓSITO (resolver-quadro.ts:
   * casar por título já adotou o quadro de um repositório para outro sem
   * relação nenhuma). A recusa está certa. O que estava errado era ela sumir:
   * este ramo era um `continue` mudo, e por causa dele o
   * `loureng/patinhas-3d-crafts` — 3 quadros ligados, medido em 31/08/2026 —
   * nunca entrava em sprint nenhuma. Metade da frota ativa parada, sem log,
   * sem linha no painel, sem recado: "não deu" ficava indistinguível de
   * "tentei e estava tudo certo". É a mesma disciplina da varredura irmã
   * (garantir-sprint-dos-projetos.ts:112) — ausência DITA, não silenciada.
   *
   * DOIS canais, e cada um por um motivo:
   *  - `events` com `type: 'audit'` é o que a timeline do Painel lê
   *    (painel.ts:665) — é ali que a LISTA DE CANDIDATOS fica guardada e o
   *    dono a reencontra. Sem a lista ele sabe que há um problema e continua
   *    sem saber entre o que escolher. (`painel_escreveu` existe no banco e
   *    nenhuma tela abre: gravar lá seria trocar um silêncio por outro.)
   *  - Telegram porque, pela régua do ESTEIRA-T15, isto é executivo: uma
   *    DECISÃO que só o dono pode tomar, e que não se resolve sozinha com o
   *    tempo.
   *
   * UM AVISO POR DIA, com o relógio no BANCO e não em variável do processo —
   * a lição da retrospectiva semanal, algumas centenas de linhas acima: este
   * serviço reinicia várias vezes por dia, e memória de processo trocaria
   * "uma vez por dia" por "uma vez por reinício". O LOG fica de fora do
   * silêncio de propósito: é stream, sai no máximo na cadência desta caixa, e
   * é por ele que se vê que o estado ainda dura.
   */
  const ASSUNTO_DO_QUADRO_INDEFINIDO = 'sprint-sem-quadro'
  const SILENCIO_ENTRE_AVISOS_DE_QUADRO_MS = 24 * 60 * 60 * 1000

  const avisarQuadroIndefinido = async (
    p: NotifiableProject & { id: string; wingId: string },
    decisao: DecisaoDeQuadro
  ): Promise<void> => {
    const candidatos =
      decisao.acao === 'escolher'
        ? decisao.candidatos.map((q) => `#${q.number} "${q.title}"`).join(', ')
        : ''
    const lista = candidatos ? ` Candidatos: ${candidatos}.` : ''

    // Não é `warn` de defeito nosso: é aviso de que falta uma ação do dono —
    // mesma escolha de nível da irmã.
    app.log.info(
      `[Scheduler] sprint de ${p.wingId} não preenchida (${decisao.acao}): ${decisao.motivo}${lista}`
    )

    const ultimo = await app.prisma.event.findFirst({
      where: {
        projectId: p.id,
        type: 'audit',
        payload: { path: ['assunto'], equals: ASSUNTO_DO_QUADRO_INDEFINIDO },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (ultimo && Date.now() - ultimo.createdAt.getTime() < SILENCIO_ENTRE_AVISOS_DE_QUADRO_MS) {
      return
    }

    /**
     * O QUE O DONO PRECISA FAZER muda com o motivo — então o texto muda junto.
     *
     * São os três estados que `decidirQuadro` devolve fora de 'usar'
     * (resolver-quadro.ts), e o aviso dispara para os três. Mandar "escolha um
     * e deixe só ele ligado" para um repositório que não tem quadro NENHUM é
     * um recado sem sentido: não há entre o que escolher. E recado sem sentido
     * é tão inútil quanto o silêncio que esta caixa veio acabar — o dono lê,
     * não entende o que se espera dele, e o projeto continua parado.
     */
    const pedidoAoDono = (): string => {
      if (decisao.acao === 'escolher') {
        return (
          `não sei em qual quadro escrever: ${decisao.motivo}${lista} ` +
          `Escolha um e deixe só ele ligado ao repositório.`
        )
      }
      if (decisao.acao === 'sem_acesso') {
        // Hoje NÃO sai daqui: 'sem_acesso' só nasce com `podeEstarCego`, e
        // esta chamada não passa esse argumento. Fica escrito porque o estado
        // existe no tipo, e o dia em que a cegueira de conta pessoal chegar a
        // esta caixa não pode ser o dia em que ela manda o texto errado.
        return (
          `não enxergo os quadros desta conta: ${decisao.motivo} ` +
          `Autorize o acesso a quadros para a credencial do GitOrch.`
        )
      }
      // 'criar'. A ação do dono é outra: criar e ligar. O RELÓGIO não cria
      // quadro — quem cria é a entrada do projeto no produto
      // (repo-context-collector.ts, `resolveBoard`). Um projeto que chegou
      // aqui sem quadro não volta sozinho.
      return (
        `não há quadro utilizável neste repositório: ${decisao.motivo} ` +
        `Crie um quadro (Projects V2) e ligue ao repositório.`
      )
    }

    const texto =
      `GitOrch — a sprint de ${p.wingId} não anda porque ${pedidoAoDono()} ` +
      `Até lá, o trabalho vivo deste projeto fica fora do ciclo.`

    await app.prisma.event.create({
      data: {
        projectId: p.id,
        type: 'audit',
        payload: { texto, assunto: ASSUNTO_DO_QUADRO_INDEFINIDO, acao: decisao.acao },
      },
    })

    // O Telegram vai DEPOIS da marca gravada, nunca antes: a marca é o que
    // segura as 24 horas de silêncio, e mandar sem ela deixaria o recado
    // saindo a cada passada — a rajada de 29/08 outra vez.
    await avisarDonoDoProjeto(p, texto)
  }

  const varrerItensDaSprint = async () => {
    if (Date.now() - ultimaVarreduraDeItensDaSprint < CADENCIA_DOS_ITENS_DA_SPRINT_MS) return
    ultimaVarreduraDeItensDaSprint = Date.now()

    const projetos = await app.prisma.project.findMany({
      where: { isActive: true },
      select: { id: true, name: true, wingId: true, autonomia: true, userId: true },
    })

    // EM SÉRIE, pelo mesmo motivo da varredura irmã: dois projetos do mesmo
    // dono compartilham a credencial, e uma renovação no meio da outra derruba
    // as duas.
    for (const p of projetos) {
      try {
        const doCliente = await lerCredencialDoProjeto({ prisma: app.prisma, projectId: p.id })
        const token =
          doCliente ??
          (p.userId ? ((await app.engineConnections?.getRawGithubToken(p.userId)) ?? null) : null)
        if (!token) {
          // Ausência DITA, não silenciada — a mesma disciplina da varredura
          // irmã, que devolve `sem_credencial` em vez de sumir com o projeto.
          // Sem esta linha o projeto simplesmente não aparece, e "não tentei"
          // fica igual a "tentei e estava tudo certo". Não é `warn` de defeito
          // nosso: é aviso de que falta uma ação do dono.
          app.log.info(
            `[Scheduler] sprint de ${p.wingId} não preenchida: ` +
              `não há credencial que alcance este repositório`
          )
          continue
        }

        // Descobrir o quadro é LEITURA: vai com teto de tempo, sem guarda de
        // escrita. Sem teto, uma conexão pendurada trava o tique inteiro.
        const leitor = new ProjectV2Client({
          token,
          fetchImpl: fetchComTeto(fetchSemPermissao(), TIMEOUT_DE_CHAMADA_GITHUB_MS),
        })
        const [owner, repo] = p.wingId.split('/')
        const quadros = await leitor.listarQuadrosDoRepositorio({
          owner: owner ?? '',
          repo: repo ?? '',
        })
        const decisao = decidirQuadro({ candidatos: quadros.map((q) => ({ ...q, linkado: true })) })
        if (decisao.acao !== 'usar' || !decisao.quadro) {
          await avisarQuadroIndefinido(p, decisao)
          continue
        }

        const relatorio = await preencherSprintCorrente(
          {
            // ESCREVE no quadro do cliente: nível daquele projeto, lido na
            // hora da chamada (o dono pode mudar pelo painel a qualquer
            // momento e a mudança não pode esperar um ciclo).
            quadro: new ProjectV2Client({
              token,
              fetchImpl: fetchDoRepositorio({
                nivel: () => p.autonomia,
                timeoutMs: TIMEOUT_DE_CHAMADA_GITHUB_MS,
              }),
            }),
            nivel: () => p.autonomia,
            hoje: () => hojeNoFuso(),
            trabalhoAtivo: () =>
              levantarTrabalhoAtivo({
                sessoesVivas: () =>
                  app.prisma.devSession.findMany({
                    where: { projectId: p.id, closedAt: null },
                    select: { issueNumber: true, pullRequestNumber: true },
                  }),
                issuesComEtiquetaDeExecucao: () =>
                  issuesComEtiquetaDeExecucao(p.wingId, token, (etiqueta, lidas) => {
                    // O teto mordeu: o que ficou além dele não entra na sprint
                    // desta passada, e ninguém descobriria sozinho.
                    app.log.warn(
                      `[Scheduler] sprint de ${p.wingId}: não li a lista inteira de ` +
                        `"${etiqueta}", parei em ${lidas} pedido(s) abertos — ` +
                        `o que ficou além disso não entrou no ciclo desta passada.`
                    )
                  }),
              }),
          },
          { projectId: decisao.quadro.id }
        )

        // Só o que MUDOU vira linha de log — e o corte de leitura, que é
        // aviso sobre a própria resposta estar incompleta.
        if (relatorio.entraram.length > 0 || relatorio.leituraIncompleta) {
          app.log.info(`[Scheduler] sprint de ${p.wingId}: ${relatorio.oQueFiz}`)
        }
      } catch (err) {
        // A recusa da guarda NÃO é defeito: é o produto obedecendo ao nível
        // que o cliente escolheu. Misturar as duas faria um "só olhar"
        // legítimo aparecer como falha e esconderia a falha de verdade.
        if (err instanceof EscritaNaoAutorizadaError) {
          app.log.debug(`[Scheduler] sprint de ${p.wingId} não preenchida: ${err.message}`)
          continue
        }
        app.log.warn(
          err,
          `[Scheduler] não consegui pôr o trabalho de ${p.wingId} na sprint; tenta na próxima passada`
        )
      }
    }
  }

  const tick = async () => {
    // PRIMEIRO de tudo: um token do GitHub vencido no meio do tique derruba
    // qualquer missão que precise dele (materializeToHome recusa e a missão
    // sai sem GH_TOKEN). `renovarTokensGithubDoRelogio` nunca rejeita e só
    // gasta uma chamada de rede por conexão cujo ciclo de renovação venceu
    // — e (achado Baixo 5 da revisão da Task 5/F8) já registra o resumo da
    // passada sozinha, então nada precisa ser feito com o retorno aqui.
    await completarAgendasDosProjetos()
    await renovarTokensGithubDoRelogio(app)
    // Os MOTORES pelo mesmo motivo do GitHub, e com a mesma disciplina: o que
    // fica parado vence sozinho, e vencer em silêncio já parou a esteira por
    // três dias. Nunca rejeita.
    await renovarMotoresDoRelogio().catch((err) =>
      app.log.error(err, '[Scheduler] a renovação de motores falhou; tenta na próxima hora')
    )
    // Só DEPOIS: quem perdeu o acesso ao repositório não pode ter o dia
    // começando com uma missão escrevendo lá. `reconferirAcessoDoRelogio`
    // nunca rejeita e só pergunta ao GitHub sobre os projetos cujo ciclo
    // venceu — não é uma chamada por tique nem por missão.
    await reconferirAcessoDoRelogio(app)
    await processSetupMissions()
    await varrerSessoesDoDev()
    // Nunca derruba o tique: a varredura já isola cada arquivamento, este é o
    // último cinto de segurança, igual às vizinhas.
    // Antes da reconciliação de vagas de propósito: esta é a que devolve a
    // vaga presa por sessão que existe e não anda, o caso que trava o SM.
    await devolverVagasDeSessaoAbandonada().catch((err) =>
      app.log.warn(
        err,
        '[Scheduler] varredura de sessões abandonadas falhou; tenta no próximo ciclo'
      )
    )
    // Irmã da de cima: fecha a sessão que o Jules já CONCLUIU ou FALHOU e cuja
    // linha nunca fechou — a que encheu as vagas e parou a esteira em 29/08.
    await varrerCicloTerminalDaSessao().catch((err) =>
      app.log.warn(err, '[Scheduler] varredura do ciclo terminal falhou; tenta no próximo ciclo')
    )
    // ESTEIRA-L3-T12: o pull request que ficou sem sessão atrás. DEPOIS do
    // ciclo terminal de propósito — é ele que acaba de fechar a linha da sessão
    // que terminou, então o conjunto "tem sessão viva" que separa o trabalho
    // das duas varreduras já está atualizado nesta mesma passada.
    await varrerPrsOrfaos().catch((err) =>
      app.log.warn(err, '[Scheduler] vigia do pull request órfão falhou; tenta no próximo ciclo')
    )
    await reconciliarVagasDoDev().catch((err) =>
      app.log.error(err, '[Scheduler] reconciliação de vagas falhou; tenta na próxima hora')
    )
    // A cerimônia semanal. Nunca derruba o tique: uma retrospectiva que falha
    // não pode calar o resto do relógio.
    await rodarRetrospectiva().catch((err) =>
      app.log.error(err, '[Scheduler] retrospectiva falhou; tenta na semana que vem')
    )
    // A fila que o acordar do SM levantou: entrega aberta sem parecer nosso no
    // commit de agora. Nunca rejeita — `triggerAgentMission` já trata os
    // próprios erros e devolve `reason`.
    await drenarPassagemDeBastao().catch((err) =>
      app.log.error(err, '[Scheduler] a passagem de bastão falhou; tenta no próximo tique')
    )
    await drenarFilaDeJulgamento().catch((err) =>
      app.log.error(err, '[Scheduler] dreno da fila de julgamento falhou; tenta no próximo tick')
    )
    // Tarefa 17: falha aqui não pode derrubar o tick — o próprio
    // `varrerPublicacoes` já isola cada sessão em try/catch; este é só o
    // último cinto de segurança (mesmo padrão de `sweepExpiredEnvironments`
    // logo abaixo).
    // A árvore do plano ANTES das publicações: fechar um nível de estrutura é
    // barato (uma leitura por projeto) e evita que o quadro do cliente cresça
    // sem parar enquanto o resto do tique faz trabalho pesado.
    // ANTES da árvore, de propósito: fechar a tarefa é o que permite a
    // feature dela fechar em seguida, na mesma passada.
    await varrerTarefasEntregues().catch((err) =>
      app.log.error(
        err,
        '[Scheduler] varredura de tarefas entregues falhou; tenta no próximo ciclo'
      )
    )
    await varrerArvoreDosPlanos().catch((err) =>
      app.log.error(err, '[Scheduler] varredura da árvore do plano falhou; tenta no próximo ciclo')
    )
    await varrerPublicacoes().catch((err) =>
      app.log.error(err, '[Scheduler] varredura de publicações falhou; tenta no próximo tick')
    )
    // Depois das publicações e antes das missões: a cota manda no que o
    // relógio pode disparar, então é melhor decidir a leva de hoje com o
    // número de agora do que com o da última missão.
    await varrerCotasDosMotores().catch((err) =>
      app.log.error(err, '[Scheduler] varredura de cotas falhou; tenta no próximo tick')
    )
    // E o CATÁLOGO DE MODELOS, uma vez por dia, logo depois da cota e pelo
    // mesmo motivo dela — só que aqui o dado velho não desatualiza um painel,
    // ele aprova um modelo morto na hora de escolher com o que a missão roda.
    // Antes das missões de propósito: é esta lista que a guarda de modelo
    // consulta degrau a degrau.
    await varrerCatalogoDeModelosDoRelogio(app).catch((err) =>
      app.log.error(
        err,
        '[Scheduler] varredura de catálogo de modelos falhou; tenta no próximo tick'
      )
    )
    // A sprint do quadro do cliente. Vem depois da cota e antes das missões
    // porque é barata quando não há nada a fazer (uma leitura por projeto) e
    // porque a sprint precisa existir ANTES de o Produto pendurar tarefa nela.
    await varrerSprintDosProjetos().catch((err) =>
      app.log.error(err, '[Scheduler] varredura de sprint falhou; tenta no próximo tick')
    )
    // LOGO DEPOIS, e nesta ordem: o ciclo precisa existir antes de ter o que
    // pôr dentro dele. Na primeira passada de um quadro novo, a de cima cria a
    // sprint e esta já a preenche na mesma volta do relógio.
    await varrerItensDaSprint().catch((err) =>
      app.log.error(err, '[Scheduler] preenchimento da sprint falhou; tenta no próximo tick')
    )
    await sweepExpiredEnvironments()
    const now = new Date()
    let schedules
    try {
      schedules = await app.prisma.projectSchedule.findMany({
        where: { isActive: true, project: { isActive: true } },
      })
    } catch (err) {
      // Nunca deixar o tick rejeitar: um erro de banco não pode derrubar o
      // processo (setInterval não trata a promise).
      app.log.error(err, '[Scheduler] tick falhou ao ler agendas; tentando no próximo minuto')
      return
    }

    for (const schedule of schedules) {
      if (!isF6AgentRole(schedule.agentRole)) {
        app.log.warn(
          `[Scheduler] Agenda ${schedule.id} com papel desconhecido '${schedule.agentRole}'; ignorando`
        )
        continue
      }

      let due = false
      try {
        // O relógio DESTA agenda, e não o do tique. Os dois projetos tinham os
        // quatro papéis no mesmo horário e o carimbo do último disparo era
        // idêntico até os milissegundos (os dois RA às 18:01:00.339) — e a
        // conta de motores é do DONO, não do projeto, então eles disputavam o
        // mesmo motor no mesmo segundo. Recuar o relógio em N minutos adianta
        // a agenda em N sem tocar no cron, que segue em hora redonda: é o que
        // o dono lê e edita, e o desvio é decisão nossa, não dado dele.
        due = isScheduleDue(
          schedule.cron,
          schedule.lastTriggeredAt,
          relogioDaAgenda(now, schedule.projectId, schedule.agentRole)
        )
      } catch (err) {
        app.log.warn(
          `[Scheduler] Agenda ${schedule.id} com cron inválido '${schedule.cron}': ${String(err)}`
        )
        continue
      }
      if (!due) continue

      try {
        const claimed = await app.prisma.projectSchedule.updateMany({
          where: { id: schedule.id, lastTriggeredAt: schedule.lastTriggeredAt },
          data: { lastTriggeredAt: now },
        })
        if (claimed.count === 0) continue // outro tick já reivindicou esta janela

        const result = await triggerAgentMission(schedule.agentRole, schedule.projectId)

        // Recusa temporária: devolve a janela (reverte o claim) para reprocessar.
        if (!result.triggered && result.reason && RETRYABLE_REASONS.has(result.reason)) {
          await app.prisma.projectSchedule.updateMany({
            where: { id: schedule.id, lastTriggeredAt: now },
            data: { lastTriggeredAt: schedule.lastTriggeredAt },
          })
        }
      } catch (err) {
        app.log.error(err, `[Scheduler] falha ao processar agenda ${schedule.id}`)
      }
    }
  }

  // Loop de verificação a cada minuto (GITORCH_SCHEDULER_TICK_MS sobrescreve —
  // usado pelo E2E do funil completo com GITORCH_FAKE_ENGINES=1 para não
  // esperar até 60s pela missão clone_and_start_engines processar; ausente,
  // comportamento de sempre). Não roda sob teste para não vazar timer nem
  // disparar missão real contra o Prisma de teste (paridade com
  // under-pressure). A execução é envolvida para nunca propagar rejeição (o
  // processo não cai).
  // Importante 8 da revisão final da branch: `tick` faz I/O de rede
  // sequencial através de vários projetos — um tique pode, sozinho, demorar
  // mais que o próprio intervalo do relógio. Sem uma trava de "já em
  // andamento", dois `tick()` corriam sobre a MESMA linha de sessão ao mesmo
  // tempo; o dedupe de aviso em `varrerPublicacoes` (`estadoAnterior`, lido
  // antes de escrever) é ler-depois-escrever, não atômico, então os dois
  // avisariam o dono e fechariam a sessão em duplicidade. A trava é
  // deliberadamente simples: um `boolean` no fechamento do plugin, marcado
  // antes de chamar `tick()` e liberado no `finally`, para um disparo do
  // `setInterval` que encontra o anterior ainda rodando simplesmente pular
  // este tique (a próxima janela tenta de novo).
  let tickEmAndamento = false

  // INCIDENTE DE 26/08/2026: um tique que rejeita repetidamente (ex.: P2022 de
  // coluna inexistente, propagado por processSetupMissions) não crasha o
  // processo (NRestarts não sobe) nem grava linha em `missions` (o watchdog
  // externo de "missões falhadas" não pega) — só vira log, tique após tique,
  // e ninguém é avisado. `conferirBancoNoArranque` fecha o caso do BOOT; isto
  // aqui fecha o resto: falha recorrente DEPOIS que o processo já subiu. Sem
  // persistir em `events` de propósito — ver aviso-de-tick-quebrado.ts.
  let estadoDoTickQuebrado: EstadoDaJanela = JANELA_LIMPA
  const avisarInstanciaDoTick = notificadorDaInstancia()

  const intervalId =
    process.env['NODE_ENV'] === 'test'
      ? undefined
      : setInterval(
          () => {
            if (tickEmAndamento) {
              app.log.warn(
                '[Scheduler] tick anterior ainda em andamento; pulando este disparo do relógio'
              )
              return
            }
            tickEmAndamento = true
            void tick()
              .then(() => {
                estadoDoTickQuebrado = decidirAvisoDeTickQuebrado(
                  estadoDoTickQuebrado,
                  false,
                  new Date(),
                  MINUTOS_ATE_ALERTAR_TICK_QUEBRADO,
                  null
                ).novoEstado
              })
              .catch((err) => {
                app.log.error(err, '[Scheduler] tick rejeitou')
                const motivo = err instanceof Error ? err.message : String(err)
                const decisao = decidirAvisoDeTickQuebrado(
                  estadoDoTickQuebrado,
                  true,
                  new Date(),
                  MINUTOS_ATE_ALERTAR_TICK_QUEBRADO,
                  motivo
                )
                estadoDoTickQuebrado = decisao.novoEstado
                if (decisao.mensagem && avisarInstanciaDoTick) {
                  avisarInstanciaDoTick(decisao.mensagem).catch((avisoErr) =>
                    app.log.error(avisoErr, '[Scheduler] não consegui avisar sobre tique quebrado')
                  )
                }
              })
              .finally(() => {
                tickEmAndamento = false
              })
          },
          Number(process.env['GITORCH_SCHEDULER_TICK_MS'] ?? 60 * 1000)
        )

  // Clean up interval on app close
  app.addHook('onClose', async () => {
    if (intervalId) {
      clearInterval(intervalId)
    }
  })

  // Exposto para rotas administrativas e QA real dispararem missões sob demanda.
  app.decorate('triggerAgentMission', triggerAgentMission)
})

declare module 'fastify' {
  interface FastifyInstance {
    triggerAgentMission: (
      role: F6AgentRole,
      projectId?: string,
      onboardingSequence?: F6AgentRole[],
      origem?: OrigemDoDisparo
    ) => Promise<TriggerResult>
  }
}

export default schedulerPlugin
export { schedulerPlugin }
