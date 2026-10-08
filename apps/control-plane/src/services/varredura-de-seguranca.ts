// A etapa do tique que mede a nota de segurança (diária) e a conformidade
// (semanal) de cada repositório. Só LÊ o GitHub do cliente; grava no banco
// (uma ficha por repositório em `repo_items`) e no painel (um aviso quando a
// nota muda ou aparece algo novo).
//
// Por que não pesa num tique que já estoura o minuto (o tique ainda a dispara
// em segundo plano, sem esperá-la, com guarda contra sobreposição):
//  - no máximo UM projeto por passada, o de ficha mais antiga;
//  - o gate é a própria ficha (`atualizado_em`): sobrevive a deploy, e um
//    projeto medido há menos de 24 h (conformidade: 7 dias) nem entra;
//  - abandona o projeto depois do orçamento de tempo, sem gravar nada;
//  - respeita o freio de cota do GitHub (pula com uma linha de log);
//  - quem falhou fica de lado por algumas horas, em memória.

import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { branchPadraoDoRepositorio } from './base-do-dev.js'
import {
  calcularNotaDeSeguranca,
  checksNaoVerificados,
  coletarSegurancaDoRepositorio,
  repositorioValido,
  type ColetaDeSeguranca,
} from './nota-de-seguranca.js'
import {
  conferirConformidade,
  lerArquivosDeSchemaPelaApi,
  licencasEmAtencaoDoProjeto,
  listarLicencasPeloSbom,
  type ResultadoDeConformidade,
} from './conformidade-do-repositorio.js'
import { erroDaRespostaDoGitHub } from './erro-do-github.js'
import {
  donoDoRepositorio,
  freioDeCotaAtivo,
  pularSeFreioDeCotaAtivo,
  registrarFreioDeCota,
} from './freio-de-cota-do-github.js'
import { registrarNoPainelSeForNovo } from './registro-no-painel.js'
import { limparSurrogatesEmJson, mascararCredenciais, mensagemDoErro } from './texto-seguro.js'

/** As fichas que esta etapa mede e lê (as outras de segurança têm dono próprio). */
const TIPOS_DA_MEDICAO = ['seguranca', 'conformidade'] as const

export const CADENCIA_DA_SEGURANCA_MS = 24 * 60 * 60_000
export const CADENCIA_DA_CONFORMIDADE_MS = 7 * 24 * 60 * 60_000
/** Quem falhou (credencial ausente, tempo esgotado, nada medido) espera isto. */
export const CADENCIA_DE_NOVA_TENTATIVA_MS = 3 * 60 * 60_000
export const ORCAMENTO_DA_SEGURANCA_MS = 20_000

const ETAPA = 'varrerSegurancaDosProjetos'

export interface ProjetoDaSeguranca {
  id: string
  /** `dono/repo`. */
  wingId: string
  runtimeConfig: unknown
}

export interface FichaMedida {
  projectId: string
  tipo: 'seguranca' | 'conformidade'
  atualizadoEm: Date
  estado: unknown
}

export interface CredencialDaSeguranca {
  /** Para o log ("cliente ou dono", "App do produto"); nunca o token. */
  origem: string
  token: string
}

export interface EscolhaDaSeguranca {
  escolhido: ProjetoDaSeguranca | null
  segurancaVencida: boolean
  conformidadeVencida: boolean
  /** Projetos vencidos que ficaram para os próximos tiques. */
  aguardando: number
  /** Projetos vencidos que o freio de cota segurou. */
  bloqueadosPeloFreio: number
}

/**
 * Decide qual projeto medir nesta passada — função pura, só das fichas: o gate
 * não depende de memória do processo. Ordem: ficha de segurança mais antiga
 * (sem ficha primeiro).
 */
export function escolherProjetoDaSeguranca(args: {
  projetos: ProjetoDaSeguranca[]
  fichas: FichaMedida[]
  agora: Date
  cadenciaMs: number
  cadenciaDaConformidadeMs: number
  novaTentativaMs: number
  falhasRecentes: ReadonlyMap<string, number>
  /** `true` = pula este projeto agora (freio de cota do dono). */
  bloqueado?: (projeto: ProjetoDaSeguranca) => boolean
}): EscolhaDaSeguranca {
  const agora = args.agora.getTime()
  const instante = (projectId: string, tipo: FichaMedida['tipo']): number => {
    const f = args.fichas.find((x) => x.projectId === projectId && x.tipo === tipo)
    return f ? f.atualizadoEm.getTime() : 0
  }

  const vencidos = args.projetos
    .map((projeto) => {
      const seguranca = instante(projeto.id, 'seguranca')
      const conformidade = instante(projeto.id, 'conformidade')
      return {
        projeto,
        seguranca,
        conformidade,
        segurancaVencida: agora - seguranca >= args.cadenciaMs,
        conformidadeVencida: agora - conformidade >= args.cadenciaDaConformidadeMs,
      }
    })
    .filter((c) => c.segurancaVencida || c.conformidadeVencida)
    .filter((c) => {
      const falhouEm = args.falhasRecentes.get(c.projeto.id)
      return falhouEm === undefined || agora - falhouEm >= args.novaTentativaMs
    })
    .sort((a, b) => a.seguranca - b.seguranca || a.conformidade - b.conformidade)

  let bloqueadosPeloFreio = 0
  for (let n = 0; n < vencidos.length; n += 1) {
    const candidato = vencidos[n]
    if (!candidato) continue
    if (args.bloqueado?.(candidato.projeto)) {
      bloqueadosPeloFreio += 1
      continue
    }
    return {
      escolhido: candidato.projeto,
      segurancaVencida: candidato.segurancaVencida,
      conformidadeVencida: candidato.conformidadeVencida,
      aguardando: vencidos.length - n - 1,
      bloqueadosPeloFreio,
    }
  }
  return {
    escolhido: null,
    segurancaVencida: false,
    conformidadeVencida: false,
    aguardando: 0,
    bloqueadosPeloFreio,
  }
}

/**
 * Junta duas leituras do mesmo repositório (credenciais diferentes): o que a
 * primeira mediu vale; a segunda só preenche o que ficou sem medida.
 */
export function mesclarColetas(
  primeira: ColetaDeSeguranca,
  segunda: ColetaDeSeguranca
): ColetaDeSeguranca {
  return {
    checks: {
      branchProtection: primeira.checks.branchProtection ?? segunda.checks.branchProtection,
      actionsFixadasPorSha:
        primeira.checks.actionsFixadasPorSha ?? segunda.checks.actionsFixadasPorSha,
      permissaoPadraoDoToken:
        primeira.checks.permissaoPadraoDoToken ?? segunda.checks.permissaoPadraoDoToken,
      codeowners: primeira.checks.codeowners ?? segunda.checks.codeowners,
      securityMd: primeira.checks.securityMd ?? segunda.checks.securityMd,
      dependabotConfigurado:
        primeira.checks.dependabotConfigurado ?? segunda.checks.dependabotConfigurado,
    },
    informativos: {
      revisaoObrigatoria:
        primeira.informativos.revisaoObrigatoria ?? segunda.informativos.revisaoObrigatoria,
    },
    arvore: primeira.arvore ?? segunda.arvore,
  }
}

export function textoDoEventoDaNota(args: {
  repositorio: string
  nota: number
  anterior: number | undefined
  maximo: number
  formula: string[]
}): string {
  const faltas = args.formula
    .filter((linha) => linha.endsWith(': FALTA'))
    .map((linha) => linha.replace(/: FALTA$/, ''))
  const antes = args.anterior === undefined ? '' : ` (antes: ${args.anterior})`
  const falta = faltas.length > 0 ? ` Falta: ${faltas.join('; ')}.` : ''
  return `Nota de segurança de ${args.repositorio}: ${args.nota} de 100${antes}, sobre ${args.maximo} itens medidos.${falta}`
}

const DOCUMENTOS_DA_CONFORMIDADE: Record<string, string> = {
  'codeowners-ausente': 'sem arquivo CODEOWNERS',
  'security-md-ausente': 'sem SECURITY.md',
  'actions-sem-sha': 'Actions sem versão fixada por SHA',
}

/** As chaves estáveis do que pede atenção. Indício de dado pessoal fica de fora: é informativo. */
export function problemasDaConformidade(r: ResultadoDeConformidade): string[] {
  const problemas: string[] = []
  if (r.codeownersAusente === true) problemas.push('codeowners-ausente')
  if (r.securityMdAusente === true) problemas.push('security-md-ausente')
  if (r.actionsSemSha === true) problemas.push('actions-sem-sha')
  if (r.licencas.estado === 'verificado') {
    for (const l of r.licencas.emAtencao) problemas.push(`licenca:${l.nome}:${l.licenca}`)
  }
  return problemas
}

/** O que há agora e não havia antes (`anterior` ausente = tudo é novo). */
export function diferencaDeProblemas(anterior: string[] | undefined, atuais: string[]): string[] {
  const conhecidos = new Set(anterior ?? [])
  return atuais.filter((p) => !conhecidos.has(p))
}

export function textoDoEventoDaConformidade(repositorio: string, novos: string[]): string {
  const partes: string[] = []
  for (const chave of novos) {
    const texto = DOCUMENTOS_DA_CONFORMIDADE[chave]
    if (texto) partes.push(texto)
  }
  const licencas = novos.filter((n) => n.startsWith('licenca:')).length
  if (licencas > 0) {
    partes.push(
      `${licencas === 1 ? '1 pacote' : `${licencas} pacotes`} com licença que pede atenção`
    )
  }
  return `Conformidade de ${repositorio}: ${partes.join('; ')}.`
}

function listaDeTextos(valor: unknown): string[] | undefined {
  return Array.isArray(valor) && valor.every((v) => typeof v === 'string')
    ? (valor as string[])
    : undefined
}

function propriedade(objeto: unknown, nome: string): unknown {
  if (typeof objeto !== 'object' || objeto === null) return undefined
  return Object.getOwnPropertyDescriptor(objeto, nome)?.value
}

export type ResultadoDaPassada =
  'nada-a-fazer' | 'medido' | 'abandonado' | 'freio' | 'sem-credencial' | 'sem-medida' | 'falhou'

export interface ResumoDaSeguranca {
  resultado: ResultadoDaPassada
  /** `dono/repo` do projeto escolhido, quando houve. */
  repositorio: string | null
  aguardando: number
}

/** Uma passada da etapa: escolhe UM projeto vencido e o mede. Nunca lança. */
export async function varrerSegurancaDosProjetos(deps: {
  prisma: Pick<PrismaClient, 'repoItem' | 'event'>
  projetos: ProjetoDaSeguranca[]
  agora: Date
  /** Credenciais que podem alcançar o repositório, na ordem de preferência. */
  credenciais: (projeto: ProjetoDaSeguranca) => Promise<CredencialDaSeguranca[]>
  /** Só leitura: o `fetch` sem permissão de escrita. */
  fetchImpl: typeof fetch
  /** Memória do processo: projeto → quando falhou. Do chamador, vive entre passadas. */
  falhasRecentes: Map<string, number>
  cadenciaMs?: number
  cadenciaDaConformidadeMs?: number
  novaTentativaMs?: number
  orcamentoMs?: number
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}): Promise<ResumoDaSeguranca> {
  const cadenciaMs = deps.cadenciaMs ?? CADENCIA_DA_SEGURANCA_MS
  const cadenciaDaConformidadeMs = deps.cadenciaDaConformidadeMs ?? CADENCIA_DA_CONFORMIDADE_MS
  const novaTentativaMs = deps.novaTentativaMs ?? CADENCIA_DE_NOVA_TENTATIVA_MS
  const orcamentoMs = deps.orcamentoMs ?? ORCAMENTO_DA_SEGURANCA_MS
  // Um log que quebra não derruba a passada: ela promete nunca lançar.
  const info = (m: string) => {
    try {
      deps.onInfo?.(`[Scheduler] ${m}`)
    } catch {
      // sem canal melhor para avisar que o próprio aviso falhou
    }
  }
  const aviso = (m: string) => {
    try {
      deps.onWarn?.(`[Scheduler] ${m}`)
    } catch {
      // idem
    }
  }

  if (deps.projetos.length === 0) {
    return { resultado: 'nada-a-fazer', repositorio: null, aguardando: 0 }
  }

  const fichas = (
    await deps.prisma.repoItem.findMany({
      where: {
        projectId: { in: deps.projetos.map((p) => p.id) },
        tipo: { in: [...TIPOS_DA_MEDICAO] },
        numero: 0,
      },
      select: { projectId: true, tipo: true, estado: true, atualizadoEm: true },
    })
  ).flatMap((f): FichaMedida[] =>
    f.tipo === 'seguranca' || f.tipo === 'conformidade'
      ? [{ projectId: f.projectId, tipo: f.tipo, estado: f.estado, atualizadoEm: f.atualizadoEm }]
      : []
  )

  const jaAvisados = new Set<string>()
  const escolha = escolherProjetoDaSeguranca({
    projetos: deps.projetos,
    fichas,
    agora: deps.agora,
    cadenciaMs,
    cadenciaDaConformidadeMs,
    novaTentativaMs,
    falhasRecentes: deps.falhasRecentes,
    bloqueado: (projeto) =>
      pularSeFreioDeCotaAtivo({
        etapa: ETAPA,
        repositorio: projeto.wingId,
        agora: deps.agora,
        jaAvisados,
        info,
      }),
  })

  const projeto = escolha.escolhido
  if (!projeto) {
    return {
      resultado: escolha.bloqueadosPeloFreio > 0 ? 'freio' : 'nada-a-fazer',
      repositorio: null,
      aguardando: 0,
    }
  }
  if (escolha.aguardando > 0) {
    info(`${ETAPA}: ${escolha.aguardando} projeto(s) vencido(s) ficam para os próximos tiques`)
  }

  const falhou = (resultado: ResultadoDaPassada): ResumoDaSeguranca => {
    deps.falhasRecentes.set(projeto.id, deps.agora.getTime())
    return { resultado, repositorio: projeto.wingId, aguardando: escolha.aguardando }
  }

  if (!repositorioValido(projeto.wingId)) {
    aviso(`${ETAPA}: ${projeto.wingId} não tem o formato dono/repo; pulado`)
    return falhou('falhou')
  }

  // O orçamento vale para a passada inteira: ao estourar, aborta as chamadas em
  // andamento e a passada devolve sem gravar nada.
  const controle = new AbortController()
  const temporizador = setTimeout(() => controle.abort(), orcamentoMs)
  const abandono = new Promise<'abandonado'>((resolve) => {
    controle.signal.addEventListener('abort', () => resolve('abandonado'), { once: true })
  })
  const dono = donoDoRepositorio(projeto.wingId)
  /** As credenciais desta passada: uma mensagem de erro que as cite não vai ao log. */
  let segredosDaPassada: string[] = []

  /** Leitura com o prazo da passada, o freio de cota e o aviso de limite de taxa. */
  const fetchDaPassada: typeof fetch = async (input, init) => {
    if (freioDeCotaAtivo(dono, new Date())) throw new Error('freio de cota do GitHub ativo')
    const sinal = init?.signal ? AbortSignal.any([init.signal, controle.signal]) : controle.signal
    return deps.fetchImpl(input, { ...init, signal: sinal })
  }
  const aoReceberRespostaRuim = (resposta: Response): void => {
    if (resposta.status !== 403 && resposta.status !== 429) return
    registrarFreioDeCota(
      dono,
      erroDaRespostaDoGitHub(`GitHub ${resposta.status} (${projeto.wingId})`, resposta),
      new Date()
    )
  }

  const executar = async (): Promise<ResumoDaSeguranca> => {
    const resumo = (resultado: ResultadoDaPassada): ResumoDaSeguranca => ({
      resultado,
      repositorio: projeto.wingId,
      aguardando: escolha.aguardando,
    })

    const credenciais = await deps.credenciais(projeto)
    segredosDaPassada = credenciais.map((c) => c.token)
    if (credenciais.length === 0) {
      aviso(`${ETAPA}: nenhuma credencial alcança ${projeto.wingId}; tenta de novo mais tarde`)
      return falhou('sem-credencial')
    }

    const branchPadrao = await branchPadraoDoRepositorio(async () => {
      for (const credencial of credenciais) {
        const resposta = await fetchDaPassada(`https://api.github.com/repos/${projeto.wingId}`, {
          headers: {
            Authorization: `Bearer ${credencial.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'gitorch',
          },
        })
        if (resposta.ok) return resposta.json()
        aoReceberRespostaRuim(resposta)
      }
      throw new Error('nenhuma credencial leu o repositório')
    })

    // A credencial do cliente/dono primeiro; a do App só completa o que ficou
    // sem medida (cada leitura extra pede só os itens que faltam).
    let coleta: ColetaDeSeguranca | null = null
    let credencialPrincipal: CredencialDaSeguranca | null = null
    for (const credencial of credenciais) {
      const pendentes = coleta ? checksNaoVerificados(coleta.checks) : undefined
      if (pendentes && pendentes.size === 0) break
      const lida = await coletarSegurancaDoRepositorio({
        repository: projeto.wingId,
        defaultBranch: branchPadrao,
        token: credencial.token,
        fetchImpl: fetchDaPassada,
        aoReceberRespostaRuim,
        ...(pendentes ? { apenas: pendentes } : {}),
      })
      coleta = coleta ? mesclarColetas(coleta, lida) : lida
      if (!credencialPrincipal && checksNaoVerificados(lida.checks).size < 6) {
        credencialPrincipal = credencial
      }
    }
    if (controle.signal.aborted) return falhou('abandonado')
    if (freioDeCotaAtivo(dono, new Date())) {
      // Parte das leituras foi barrada pela cota: gravar uma nota sobre menos
      // itens do que o normal seria mentir. Descarta e espera o freio.
      info(
        `${ETAPA}: freio de cota ativado durante a leitura de ${projeto.wingId}; passada descartada`
      )
      return resumo('freio')
    }

    if (!coleta || !credencialPrincipal) {
      aviso(`${ETAPA}: nenhum item de segurança de ${projeto.wingId} pôde ser verificado`)
      return falhou('sem-medida')
    }

    const nota = calcularNotaDeSeguranca(coleta.checks)
    if (nota.nota === null) return falhou('sem-medida')

    const medidoEm = deps.agora.toISOString()
    const dia = medidoEm.slice(0, 10)
    const anteriorDaSeguranca = fichas.find(
      (f) => f.projectId === projeto.id && f.tipo === 'seguranca'
    )
    const notaAnterior = propriedade(anteriorDaSeguranca?.estado, 'nota')

    // A conformidade vem na mesma passada, com os documentos e as Actions que a
    // nota já leu (nada de ler de novo).
    let conformidade: ResultadoDeConformidade | null = null
    if (escolha.conformidadeVencida) {
      const licencasEmAtencao = licencasEmAtencaoDoProjeto(projeto.runtimeConfig, aviso)
      conformidade = await conferirConformidade({
        listarLicencas: listarLicencasPeloSbom({
          repository: projeto.wingId,
          token: credencialPrincipal.token,
          fetchImpl: fetchDaPassada,
          aoReceberRespostaRuim,
        }),
        licencasEmAtencao,
        lerArquivosDeSchema: lerArquivosDeSchemaPelaApi({
          repository: projeto.wingId,
          token: credencialPrincipal.token,
          fetchImpl: fetchDaPassada,
          arvore: coleta.arvore,
          aoReceberRespostaRuim,
        }),
        codeownersAusente: coleta.checks.codeowners === null ? null : !coleta.checks.codeowners,
        securityMdAusente: coleta.checks.securityMd === null ? null : !coleta.checks.securityMd,
        actionsSemSha:
          coleta.checks.actionsFixadasPorSha === null ? null : !coleta.checks.actionsFixadasPorSha,
      })
      if (freioDeCotaAtivo(dono, new Date())) {
        info(
          `${ETAPA}: freio de cota ativado durante a conformidade de ${projeto.wingId}; passada descartada`
        )
        return resumo('freio')
      }
    }

    // Daqui para baixo só escreve no banco: o prazo vale para a leitura do
    // GitHub e não pode cortar uma gravação no meio.
    if (controle.signal.aborted) return falhou('abandonado')
    clearTimeout(temporizador)

    const gravar = (tipo: 'seguranca' | 'conformidade', estado: Prisma.InputJsonObject) =>
      deps.prisma.repoItem.upsert({
        where: { projectId_tipo_numero: { projectId: projeto.id, tipo, numero: 0 } },
        create: { projectId: projeto.id, tipo, numero: 0, estado: limparSurrogatesEmJson(estado) },
        update: { estado: limparSurrogatesEmJson(estado) },
      })

    await gravar('seguranca', {
      status: 'medido',
      nota: nota.nota,
      maximo: nota.maximo,
      formula: nota.formula,
      checks: { ...coleta.checks },
      informativos: { ...coleta.informativos },
      medidoEm,
    })
    if (notaAnterior !== nota.nota) {
      await registrarNoPainelSeForNovo({
        prisma: deps.prisma,
        projectId: projeto.id,
        chave: `nota-de-seguranca:${projeto.wingId}:${nota.nota}:${dia}`,
        texto: textoDoEventoDaNota({
          repositorio: projeto.wingId,
          nota: nota.nota,
          anterior: typeof notaAnterior === 'number' ? notaAnterior : undefined,
          maximo: nota.maximo,
          formula: nota.formula,
        }),
      })
    }

    if (conformidade) {
      const problemas = problemasDaConformidade(conformidade)
      const anteriorDaConformidade = fichas.find(
        (f) => f.projectId === projeto.id && f.tipo === 'conformidade'
      )
      const novos = diferencaDeProblemas(
        listaDeTextos(propriedade(anteriorDaConformidade?.estado, 'problemas')),
        problemas
      )
      await gravar('conformidade', {
        status: 'medido',
        medidoEm,
        licencas: conformidade.licencas,
        indiciosDePii: conformidade.indiciosDePii,
        documentos: {
          codeownersAusente: conformidade.codeownersAusente,
          securityMdAusente: conformidade.securityMdAusente,
          actionsSemSha: conformidade.actionsSemSha,
        },
        problemas,
      })
      if (novos.length > 0) {
        const identidade = createHash('sha1')
          .update([...novos].sort().join('|'))
          .digest('hex')
        await registrarNoPainelSeForNovo({
          prisma: deps.prisma,
          projectId: projeto.id,
          chave: `conformidade:${projeto.wingId}:${dia}:${identidade.slice(0, 8)}`,
          texto: textoDoEventoDaConformidade(projeto.wingId, novos),
        })
      }
    }

    deps.falhasRecentes.delete(projeto.id)
    return resumo('medido')
  }

  try {
    const feito = executar().catch((err: unknown): ResumoDaSeguranca => {
      if (controle.signal.aborted) return falhou('abandonado')
      // O recuo vem antes do aviso: um log que quebra não pode deixar a falha sem registro.
      const resumo = falhou('falhou')
      aviso(
        `${ETAPA}: ${projeto.wingId} falhou: ${mascararCredenciais(mensagemDoErro(err), segredosDaPassada)}`
      )
      return resumo
    })
    const desfecho = await Promise.race([feito, abandono])
    if (desfecho === 'abandonado' || desfecho.resultado === 'abandonado') {
      aviso(
        `${ETAPA}: ${projeto.wingId} abandonado depois de ${Math.round(orcamentoMs / 1000)} s; tenta de novo mais tarde`
      )
      return falhou('abandonado')
    }
    return desfecho
  } finally {
    clearTimeout(temporizador)
  }
}
