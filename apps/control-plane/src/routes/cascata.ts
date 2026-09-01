import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import {
  F6_AGENT_ROLES,
  isF6AgentRole,
  isF6AgentRuntime,
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
} from '@gitorch/agents'
import type { F6AgentRole, F6AgentRuntime } from '@gitorch/agents'
import {
  ESFORCOS_DO_MOTOR,
  COMO_O_MOTOR_EXPRESSA_ESFORCO,
  esforcoValidoNoMotor,
  valorDeModeloParaOMotor,
} from '../services/esforco-por-motor.js'
import { padraoDoDegrau } from '../services/padrao-do-degrau.js'
import { nomeDeExibicaoDoModelo, ehLinhaDeModelo } from '../services/catalogo-vivo-de-modelos.js'

/**
 * A CASCATA POR AGENTE — ler, gravar, e listar as opções reais.
 *
 * MULTI-TENANT, e isto é a parte que não pode dar errado: a cascata é do
 * CLIENTE, mora em `Project.runtimeConfig.agents` (uma coluna jsonb que já
 * existe — nenhuma migração nova é necessária) e nunca numa configuração
 * global. O projeto é buscado pelo `id` dentro do contexto de tenant que o
 * middleware do Prisma abre por `userId` (plugins/prisma.ts + plugins/auth.ts),
 * o mesmo isolamento do resto do produto; projeto de outro dono simplesmente
 * não é encontrado, e a resposta é 404 — nunca a cascata alheia.
 *
 * E as OPÇÕES saem do catálogo coletado daquele dono (`engine_connections`),
 * nunca de uma lista escrita à mão que envelhece. Foi uma lista escrita à mão
 * que matou 24 missões em 9h48 no dia 31/08.
 */

interface DegrauEntrada {
  runtime?: unknown
  model?: unknown
  effort?: unknown
  fallbacks?: unknown
}

interface Degrau {
  runtime: string
  model?: string
  effort?: string
}

interface PapelDaCascata extends Degrau {
  fallbacks?: Degrau[]
}

interface CorpoDaCascata {
  agents?: Record<string, DegrauEntrada>
}

/** Erro de validação com a mensagem que vai para o dono, na porta. */
class CascataInvalida extends Error {}

/**
 * Valida UM degrau. Recusa o que é certamente errado e é uma lista fechada que
 * nós medimos — motor e esforço. Nunca "aproxima" um valor para o vizinho.
 */
function validarDegrau(degrau: DegrauEntrada, onde: string): Degrau {
  const runtime = degrau.runtime
  if (typeof runtime !== 'string' || !isF6AgentRuntime(runtime)) {
    throw new CascataInvalida(
      `${onde}: motor inválido ${JSON.stringify(runtime)}. Use um de: codex, claude, antigravity`
    )
  }

  const model = degrau.model
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new CascataInvalida(`${onde}: modelo precisa ser texto não vazio`)
  }

  const effort = degrau.effort
  if (effort !== undefined) {
    if (typeof effort !== 'string') {
      throw new CascataInvalida(`${onde}: esforço precisa ser texto`)
    }
    // O Antigravity é um caso à parte, e recusar aqui é dizer a verdade na
    // tela: `agy --model X --effort high` é ERRO DURO do CLI (medido ao vivo
    // em 01/09/2026 — "--effort is not supported for model ..."), e a cascata
    // sempre fixa o modelo. Aceitar a escolha e ignorá-la depois em silêncio
    // faria o dono acreditar num esforço que nunca seria aplicado.
    if (COMO_O_MOTOR_EXPRESSA_ESFORCO[runtime as F6AgentRuntime] === 'no-nome-do-modelo') {
      throw new CascataInvalida(
        `${onde}: o motor "${runtime}" não tem esforço separado do modelo — ` +
          `escolha a variante do modelo (ex.: "Gemini 3.7 Flash (High)" em vez de "(Medium)")`
      )
    }
    if (!esforcoValidoNoMotor(runtime, effort)) {
      throw new CascataInvalida(
        `${onde}: o motor "${runtime}" não tem o esforço "${effort}". ` +
          `Aceita: ${(ESFORCOS_DO_MOTOR[runtime as F6AgentRuntime] ?? []).join(', ')}`
      )
    }
  }

  return {
    runtime,
    ...(typeof model === 'string' ? { model: model.trim() } : {}),
    ...(typeof effort === 'string' ? { effort } : {}),
  }
}

function validarCascata(agents: Record<string, DegrauEntrada>): Record<string, PapelDaCascata> {
  const saida: Record<string, PapelDaCascata> = {}
  for (const [papel, entrada] of Object.entries(agents)) {
    if (!isF6AgentRole(papel)) {
      throw new CascataInvalida(
        `papel inválido "${papel}". Use um de: ${F6_AGENT_ROLES.join(', ')}`
      )
    }
    if (!entrada || typeof entrada !== 'object') {
      throw new CascataInvalida(`${papel}: degrau precisa ser um objeto`)
    }
    const principal = validarDegrau(entrada, papel)
    const brutos = entrada.fallbacks
    if (brutos !== undefined && !Array.isArray(brutos)) {
      throw new CascataInvalida(`${papel}: fallbacks precisa ser uma lista`)
    }
    const fallbacks = (brutos ?? []).map((fb, i) =>
      validarDegrau((fb ?? {}) as DegrauEntrada, `${papel}.fallbacks[${i}]`)
    )
    saida[papel] = { ...principal, ...(brutos !== undefined ? { fallbacks } : {}) }
  }
  return saida
}

/** Um modelo que SAIU do catálogo do provedor, com a data em que a coleta viu. */
interface ModeloQueSaiu {
  nome: string
  sumiuEm: string | null
}

interface CatalogoDoMotor {
  /** o que o provedor lista HOJE. */
  modelos: string[]
  /** o que ele listava e não lista mais — marcado, nunca apagado. */
  indisponiveis: ModeloQueSaiu[]
}

/**
 * Catálogo por motor DAQUELE dono, direto de engine_connections.
 *
 * Traz o vivo E o que saiu. O que saiu vem de `models_unavailable`, a coluna
 * que a coleta carimba quando o provedor remove um modelo (PR de 31/08) em vez
 * de apagar a linha — e ela existe exatamente para esta pergunta: o modelo que
 * o cliente escolheu ainda está no ar? Ler só `models` faria o modelo morto
 * sumir da tela, que é a forma mais silenciosa possível de esconder isso dele.
 */
async function catalogosDoDono(
  app: FastifyInstance,
  userId: string | null | undefined
): Promise<Record<string, CatalogoDoMotor>> {
  if (!userId) return {}
  const linhas = await app.prisma.engineConnection
    .findMany({
      where: { userId, runtime: { not: 'github' } },
      select: { runtime: true, models: true, modelsUnavailable: true },
    })
    .catch(() => [] as Array<{ runtime: string; models: unknown; modelsUnavailable: unknown }>)

  const catalogos: Record<string, CatalogoDoMotor> = {}
  for (const linha of linhas as Array<{
    runtime: string
    models: unknown
    modelsUnavailable: unknown
  }>) {
    const modelos = Array.isArray(linha.models)
      ? linha.models
          .filter((m): m is string => typeof m === 'string')
          .filter(ehLinhaDeModelo)
          .map(nomeDeExibicaoDoModelo)
          .filter(Boolean)
      : []

    // A mesma normalização do lado vivo, e de propósito: as linhas antigas do
    // banco guardam `slug<TAB>Nome`, e um lado normalizado enquanto o outro
    // não faria o MESMO modelo aparecer duas vezes na tela — uma como escolha
    // possível, outra como "saiu do ar".
    const indisponiveis = Array.isArray(linha.modelsUnavailable)
      ? (linha.modelsUnavailable as unknown[])
          .filter(
            (m): m is { nome: string; sumiuEm?: unknown } =>
              typeof m === 'object' &&
              m !== null &&
              typeof (m as { nome?: unknown }).nome === 'string' &&
              (m as { nome: string }).nome.length > 0
          )
          .map((m) => ({
            nome: nomeDeExibicaoDoModelo(m.nome),
            sumiuEm: typeof m.sumiuEm === 'string' ? m.sumiuEm : null,
          }))
          .filter((m) => m.nome.length > 0)
      : []

    if (!Array.isArray(linha.models) && indisponiveis.length === 0) continue
    catalogos[linha.runtime] = { modelos, indisponiveis }
  }
  return catalogos
}

/** Só os modelos VIVOS, que é o que a conferência de catálogo pergunta. */
function modelosVivos(catalogos: Record<string, CatalogoDoMotor>, runtime: string): string[] {
  return catalogos[runtime]?.modelos ?? []
}

export const cascataRoutes = async (app: FastifyInstance): Promise<void> => {
  const acharProjeto = async (
    id: string
  ): Promise<{ id: string; userId: string | null; runtimeConfig: unknown } | null> =>
    (await app.prisma.project.findFirst({
      where: { id },
      select: { id: true, userId: true, runtimeConfig: true },
    })) as { id: string; userId: string | null; runtimeConfig: unknown } | null

  /**
   * As OPÇÕES da tela: por motor, os modelos do catálogo daquele dono e a
   * escada de esforço real daquele motor.
   *
   * `valor` é o que vai para o `--model`; `rotulo` é o que a tela mostra. Os
   * dois diferem no claude e a diferença é fatal: o catálogo guarda o nome de
   * vitrine ("Claude Opus 5") e o CLI só aceita o identificador
   * ("claude-opus-5") — medido ao vivo em 01/09/2026. Uma tela que gravasse o
   * rótulo montaria uma cascata em que todo degrau de claude morre.
   */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/cascata/opcoes',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const projeto = await acharProjeto(request.params.id)
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      const catalogos = await catalogosDoDono(app, projeto.userId)
      const motores = (Object.keys(COMO_O_MOTOR_EXPRESSA_ESFORCO) as F6AgentRuntime[]).map(
        (runtime) => {
          const doCatalogo = catalogos[runtime]
          return {
            runtime,
            esforcos: [...(ESFORCOS_DO_MOTOR[runtime] ?? [])],
            /**
             * true quando escolher esforço É escolher outro modelo (Antigravity).
             * A tela precisa saber para não oferecer um seletor que o motor
             * recusa com erro duro.
             */
            esforcoNoNomeDoModelo: COMO_O_MOTOR_EXPRESSA_ESFORCO[runtime] === 'no-nome-do-modelo',
            modelos: (doCatalogo?.modelos ?? []).map((rotulo) => ({
              valor: valorDeModeloParaOMotor(runtime, rotulo),
              rotulo,
            })),
            /**
             * O que o provedor REMOVEU, com a data. Vai separado do vivo porque
             * não é opção legítima — é aviso. A tela precisa poder mostrar o
             * modelo morto que o cliente escolheu DIZENDO que ele morreu, em
             * vez de fazê-lo sumir do seletor: `<select>` cujo `value` não está
             * entre as `<option>` desenha a primeira, e o dono leria uma
             * escolha que nunca fez.
             */
            indisponiveis: (doCatalogo?.indisponiveis ?? []).map((m) => ({
              valor: valorDeModeloParaOMotor(runtime, m.nome),
              rotulo: m.nome,
              sumiuEm: m.sumiuEm,
            })),
          }
        }
      )
      return reply.send({ motores })
    }
  )

  /** A cascata do projeto — a escolhida, ou o padrão escrito, marcado como tal. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/cascata',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const projeto = await acharProjeto(request.params.id)
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      const config = (projeto.runtimeConfig ?? {}) as { agents?: Record<string, PapelDaCascata> }
      const escolhida = Boolean(
        config.agents && typeof config.agents === 'object' && Object.keys(config.agents).length > 0
      )
      if (escolhida) return reply.send({ escolhida: true, agents: config.agents })

      // Nunca escolheu: devolve o PADRÃO, e o padrão é resolvido contra o
      // catálogo vivo do motor padrão de cada papel — não um literal.
      const catalogos = await catalogosDoDono(app, projeto.userId)
      const agents: Record<string, Degrau> = {}
      for (const role of F6_AGENT_ROLES) {
        const runtime = motorPadraoDoPapel(role)
        const padrao = padraoDoDegrau({ role, runtime, catalogo: modelosVivos(catalogos, runtime) })
        agents[role] = {
          runtime,
          ...(padrao.model ? { model: valorDeModeloParaOMotor(runtime, padrao.model) } : {}),
          ...(padrao.effort ? { effort: padrao.effort } : {}),
        }
      }
      return reply.send({ escolhida: false, agents })
    }
  )

  /**
   * Grava a cascata do projeto. Substitui `agents` INTEIRO (a tela manda o
   * estado completo dos quatro papéis) e preserva todo o resto do
   * `runtimeConfig` — quadro, ambientes, política de perguntas. Uma gravação
   * de cascata nunca pode apagar a configuração do quadro do cliente.
   */
  app.put<{ Params: { id: string }; Body: CorpoDaCascata }>(
    '/api/projects/:id/cascata',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: CorpoDaCascata }>,
      reply: FastifyReply
    ) => {
      const agents = request.body?.agents
      if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
        return reply.code(400).send({ error: 'agents é obrigatório e precisa ser um objeto' })
      }

      let validada: Record<string, PapelDaCascata>
      try {
        validada = validarCascata(agents)
      } catch (err) {
        if (err instanceof CascataInvalida) return reply.code(400).send({ error: err.message })
        throw err
      }

      const projeto = await acharProjeto(request.params.id)
      if (!projeto) return reply.code(404).send({ error: 'Project not found' })

      // AVISO, não bloqueio, para o modelo fora do catálogo. Bloquear trocaria
      // desperdício por paralisação — o catálogo pode estar vazio (coleta
      // nunca rodou) ou atrasado, e recusar por isso impediria o dono de
      // configurar o próprio produto. Calar seria repetir 31/08: o cliente
      // escolheria um modelo morto sem uma linha em lugar nenhum dizendo isso.
      const catalogos = await catalogosDoDono(app, projeto.userId)
      const avisos: string[] = []
      for (const [papel, degrauDoPapel] of Object.entries(validada)) {
        const todos = [degrauDoPapel, ...(degrauDoPapel.fallbacks ?? [])]
        for (const d of todos) {
          const catalogo = modelosVivos(catalogos, d.runtime)
          if (!d.model || catalogo.length === 0) continue
          // Compara pelos DOIS lados já convertidos: o cliente pode ter
          // gravado o rótulo ("GPT-5.5") ou o identificador ("gpt-5.5"), e os
          // dois são a mesma escolha.
          const alvo = valorDeModeloParaOMotor(d.runtime, d.model)
          const cabe = catalogo.some(
            (m) => m === d.model || valorDeModeloParaOMotor(d.runtime, m) === alvo
          )
          if (!cabe) {
            avisos.push(
              `${papel}: "${d.model}" não está no catálogo vivo do motor "${d.runtime}" ` +
                `(${catalogo.length} disponíveis). O degrau vai rodar com o modelo padrão do ` +
                `próprio motor até você escolher um da lista.`
            )
          }
        }
      }

      const atual = (projeto.runtimeConfig ?? {}) as Record<string, unknown>
      // Só `agents` é substituído; o resto do runtimeConfig do cliente (quadro,
      // ambientes, política de perguntas) viaja intacto. O cast é para o tipo
      // JSON do Prisma — a forma já foi validada acima, campo a campo.
      const runtimeConfig = { ...atual, agents: validada } as unknown as Prisma.InputJsonValue
      const atualizado = await app.prisma.project.update({
        where: { id: projeto.id },
        data: { runtimeConfig },
        select: { id: true, runtimeConfig: true, updatedAt: true },
      })

      return reply.send({ id: atualizado.id, agents: validada, avisos })
    }
  )
}

/**
 * O motor padrão de cada papel. Importado do pacote de agentes pela mesma
 * fonte que o scheduler usa — sem uma segunda lista para divergir da primeira.
 */
function motorPadraoDoPapel(role: F6AgentRole): F6AgentRuntime {
  return DEFAULT_AGENT_RUNTIME_ASSIGNMENTS[role].runtime
}

export default cascataRoutes
