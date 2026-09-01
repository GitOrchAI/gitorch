// D6 do desenho aprovado em 30/08 ("A lógica da leva 2"): a caixa "Analista
// diagnostica" — { já resolvido · repetido · parado · risco · vago } — que
// NÃO EXISTIA no produto. O que existia (resolver-quadro.ts) é decisão de
// QUADRO ('usar'/'criar'/'escolher'), outra coisa inteiramente.
//
// As cinco categorias são as do desenho, sem uma sexta. Uma issue pode não
// cair em nenhuma — o diagnóstico é sobre o que MERECE atenção, não uma
// classificação obrigatória de toda issue aberta.
//
// ORDEM DE PRIORIDADE (a mesma do desenho, e a mesma da leitura humana): já
// resolvido > repetido > parado > risco > vago. Uma issue cai na PRIMEIRA que
// bater — "já resolvido" é a mais valiosa (fecha o item de verdade) e "vago"
// é a mais fraca (só pede mais informação), então uma issue que seja as duas
// coisas ganha o rótulo que mais ajuda quem for agir.
//
// Este diagnóstico é LEITURA. Nenhuma função aqui escreve no GitHub — a
// garantia "NÃO TOCA EM NADA" (em vermelho no desenho do dono) é estrutural:
// não existe chamada de escrita neste arquivo, não é um `if` de autonomia que
// alguém pode esquecer de checar. O nível "Sugerir" (D7, propor fechar/
// juntar/quebrar) consome este achado depois — não é construído aqui.
//
// RISCO CENTRAL (por que "já resolvido" é conservador de propósito): medido
// em 01/09/2026 contra as 96 issues abertas do Jardim das Patinhas — ver o
// resultado e a conferência à mão no relatório da tarefa. Um falso positivo
// aqui fecharia issue viva do cliente.

import {
  garantirGrafoDoRepositorio,
  garantirHistoricoCompletoDoGit,
  consultarGrafoDeCodigo,
  dataDaUltimaAlteracao,
  defaultExecFileImpl,
  type ExecFileImpl,
  type NoDoGrafo,
  type ResultadoDaConsulta,
} from './grafo-do-codigo.js'

export const CATEGORIAS_DE_DIAGNOSTICO = [
  'ja_resolvido',
  'repetido',
  'parado',
  'risco',
  'vago',
] as const
export type CategoriaDeDiagnostico = (typeof CATEGORIAS_DE_DIAGNOSTICO)[number]

export interface IssueParaDiagnostico {
  number: number
  title: string
  body?: string | null
  createdAt: string
  updatedAt: string
  labels?: string[]
}

export interface AchadoDeDiagnostico {
  issue: number
  categoria: CategoriaDeDiagnostico
  motivo: string
  evidencia?: string
}

export interface ResultadoDoDiagnostico {
  achados: AchadoDeDiagnostico[]
  /**
   * Preenchido quando o grafo não pôde ser preparado — "já resolvido" não foi
   * checado para NENHUMA issue deste lote. Nunca fica em branco por engano:
   * ou o grafo funcionou, ou aqui está o motivo real de não ter funcionado.
   */
  grafoIndisponivel?: string
}

export interface DependenciasDoDiagnostico {
  /** Workspace já clonado do repositório do cliente (mesmo clone que o resto do produto reaproveita). */
  workspacePath: string
  garantirGrafo?: typeof garantirGrafoDoRepositorio
  garantirHistorico?: typeof garantirHistoricoCompletoDoGit
  consultarGrafo?: typeof consultarGrafoDeCodigo
  execFileImpl?: ExecFileImpl
  /** Injetável para teste determinístico. Default: Date.now(). */
  agora?: number
  /** Dias sem atualização para contar como "parado". Default 45. */
  diasParaParado?: number
  /** Sobreposição de conteúdo (Jaccard) mínima para contar como "repetido". Default 0.6. */
  limiarDeRepeticao?: number
}

// ---------------------------------------------------------------------------
// Texto: um único tokenizador para tudo, de propósito.
//
// ARMADILHA JÁ PAGA (resolver-quadro.ts, 29/08): comparar por NOME colidiu —
// "acme-api" e "acme_api" são o mesmo projeto e uma comparação de string crua
// os trata como diferentes. Tokenizar por `[a-z0-9]+` separa em `-`, `_`,
// espaço e qualquer outra pontuação igualmente: "acme-api" e "acme_api" viram
// os MESMOS dois tokens (["acme", "api"]). Um único tokenizador usado tanto
// para "repetido" quanto para "já resolvido" garante que essa lição vale nos
// dois lugares, não só onde alguém lembrou de aplicá-la.
// ---------------------------------------------------------------------------

function normalizarSemAcento(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function tokenizar(texto: string): string[] {
  return normalizarSemAcento(texto).match(/[a-z0-9]+/g) ?? []
}

const PALAVRAS_IGNORADAS = new Set([
  'para',
  'como',
  'quando',
  'onde',
  'este',
  'esta',
  'essa',
  'esse',
  'isso',
  'numa',
  'com',
  'sem',
  'que',
  'uma',
  'um',
  'dos',
  'das',
  'nao',
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'ainda',
  'pelo',
  'pela',
  'pode',
  'deve',
  'pois',
  'entao',
  'apos',
  'antes',
  'issue',
  'bug',
])

// ---------------------------------------------------------------------------
// 1) JÁ RESOLVIDO — a única categoria que usa o grafo do código.
//
// Duas evidências, as DUAS exigidas, nenhuma sozinha basta:
//   (a) TEXTUAL — os termos significativos do título da issue aparecem nos
//       nós SEMENTE que o grafo devolve para aquele título (o grafo "conhece"
//       o assunto).
//   (b) TEMPORAL — pelo menos um dos arquivos das sementes foi alterado no
//       git DEPOIS de a issue ter sido aberta.
//
// SÓ NÓ SEMENTE conta — nunca um nó trazido só por estar a 1-2 saltos de uma
// semente (`graphify query` faz BFS depth=2). MEDIDO AO VIVO em 01/09/2026
// contra as 96 issues abertas do Jardim das Patinhas: usar TODOS os nós
// devolvidos (semente ou não) resultou em taxa de erro de 64% (7 falsos
// positivos em 11) — o padrão dominante era um arquivo "hub" (`App.tsx`,
// alcançado por BFS a partir de qualquer componente de página, não porque o
// termo da issue tivesse a ver com ele) sendo alterado por um commit
// TOTALMENTE não relacionado, e essa coincidência bastava pra passar nas duas
// checagens. Restringir às sementes elimina essa classe de falso positivo —
// ver o relatório da tarefa para a conferência issue-a-issue.
//
// Só (a) marca "código relacionado existe", que é verdade pra quase todo bug
// report sobre uma feature que já existe — é exatamente o padrão que fechou
// issue viva na avaliação anterior de uma régua irmã (L3-T18). Só (b) faria
// qualquer commit recente no arquivo errado disparar um falso positivo. As
// duas juntas são o que o desenho pede: "assim que ele sabe que algo JÁ FOI
// RESOLVIDO" — não "assim que ele sabe que o assunto existe no código".
// ---------------------------------------------------------------------------

const LIMIAR_DE_COBERTURA = 0.7
const MINIMO_DE_PALAVRAS_BATENDO = 2

function palavrasSignificativas(texto: string): string[] {
  return tokenizar(texto).filter((t) => t.length >= 4 && !PALAVRAS_IGNORADAS.has(t))
}

// Mesmo restrito a nós SEMENTE, um arquivo de ROTEAMENTO ainda engana: medido
// ao vivo, `src/App.tsx` bateu como semente de verdade pro título de #3868
// ("...Checkout/Flow") e de #3867 ("...admin/orders") — não por proximidade
// no BFS, mas porque o roteador tem UMA LINHA por página
// (`const AdminOrders = lazy(() => import("./pages/admin/Orders"))`), então
// ele contém um identificador com o nome de CADA feature da aplicação. Isso é
// estrutural, não um vizinho ruim: nenhum limiar de cobertura elimina, porque
// o "roteador" é feito para bater com tudo. Os DOIS commits que dispararam o
// falso positivo mexiam no roteador por um motivo TOTALMENTE alheio às duas
// issues (uma rota nova de Mercado Livre). Excluir estes nomes de arquivo
// convencionais da checagem de recência é estreito de propósito — não filtra
// nada além do próprio roteador.
const ARQUIVOS_DE_ROTEAMENTO = new Set([
  'app.tsx',
  'app.jsx',
  'app.ts',
  'main.tsx',
  'main.ts',
  'index.tsx',
  'index.ts',
  'router.tsx',
  'router.ts',
  'routes.tsx',
  'routes.ts',
])

function ehArquivoDeRoteamento(arquivo: string): boolean {
  const base = arquivo.split('/').pop() ?? arquivo
  return ARQUIVOS_DE_ROTEAMENTO.has(base.toLowerCase())
}

function coberturaDeEvidencia(
  palavras: string[],
  nos: NoDoGrafo[]
): { cobertura: number; achadas: string[] } {
  if (palavras.length === 0) return { cobertura: 0, achadas: [] }
  const textoDosNos = nos
    .map((n) => `${n.label} ${n.arquivo ?? ''}`)
    .join(' ')
    .toLowerCase()
  const achadas = palavras.filter((p) => textoDosNos.includes(p))
  return { cobertura: achadas.length / palavras.length, achadas }
}

interface AvaliacaoDeResolucao {
  resolvido: boolean
  motivo: string
  evidencia?: string
}

async function avaliarJaResolvido(
  issue: IssueParaDiagnostico,
  resultado: ResultadoDaConsulta,
  workspacePath: string,
  execFileImpl: ExecFileImpl
): Promise<AvaliacaoDeResolucao> {
  if (!resultado.disponivel) {
    return { resolvido: false, motivo: `grafo não respondeu para esta issue: ${resultado.motivo}` }
  }
  const sementes = resultado.nos.filter((n) => n.semente)
  if (sementes.length === 0) {
    return {
      resolvido: false,
      motivo:
        'nenhum nó SEMENTE do grafo bateu com o título da issue (só vizinhos por proximidade, se algum)',
    }
  }

  const palavras = palavrasSignificativas(issue.title)
  const { cobertura, achadas } = coberturaDeEvidencia(palavras, sementes)
  if (
    palavras.length === 0 ||
    cobertura < LIMIAR_DE_COBERTURA ||
    achadas.length < MINIMO_DE_PALAVRAS_BATENDO
  ) {
    return {
      resolvido: false,
      motivo: `evidência textual insuficiente nos nós semente do grafo (${achadas.length}/${palavras.length} termo(s) do título)`,
    }
  }

  const arquivos = [
    ...new Set(
      sementes
        .map((n) => n.arquivo)
        .filter((a): a is string => !!a)
        .filter((a) => !ehArquivoDeRoteamento(a))
    ),
  ]
  const criadaEm = Date.parse(issue.createdAt)
  if (arquivos.length === 0 || !Number.isFinite(criadaEm)) {
    return {
      resolvido: false,
      motivo: `código relacionado encontrado ("${achadas.join(', ')}") mas sem arquivo específico (fora do roteador) e data de criação da issue para confirmar recência`,
    }
  }

  const alteracoes = await Promise.all(
    arquivos.map(async (arquivo) => ({
      arquivo,
      ultimaAlteracao: await dataDaUltimaAlteracao(workspacePath, arquivo, execFileImpl),
    }))
  )
  const semNenhumaData = alteracoes.every((a) => a.ultimaAlteracao === undefined)
  if (semNenhumaData) {
    return {
      resolvido: false,
      motivo: `código relacionado encontrado (${arquivos.join(', ')}) mas não foi possível ler a data de alteração via git — recência não confirmada`,
    }
  }

  const alteradoDepois = alteracoes.find(
    (a) => a.ultimaAlteracao !== undefined && a.ultimaAlteracao > criadaEm
  )
  if (!alteradoDepois || alteradoDepois.ultimaAlteracao === undefined) {
    return {
      resolvido: false,
      motivo: `código relacionado existe (${arquivos.join(', ')}) mas NENHUM arquivo mudou depois de a issue #${issue.number} ter sido aberta — provável código pré-existente, não uma correção`,
    }
  }

  const quando = new Date(alteradoDepois.ultimaAlteracao).toISOString()
  return {
    resolvido: true,
    motivo: `o grafo do código aponta ${achadas.length}/${palavras.length} termo(s) do título ("${achadas.join(', ')}") em ${arquivos.length} arquivo(s), e "${alteradoDepois.arquivo}" foi alterado em ${quando} — depois de a issue #${issue.number} ter sido aberta`,
    evidencia: `${alteradoDepois.arquivo} (alterado ${quando})`,
  }
}

// ---------------------------------------------------------------------------
// 2) REPETIDO — compara CONTEÚDO (título + corpo), não título/nome. A issue
// mais NOVA é marcada como repetição da mais ANTIGA (a mais antiga fica
// "limpa": é o item original).
// ---------------------------------------------------------------------------

function tokensDeConteudo(issue: IssueParaDiagnostico): Set<string> {
  const texto = `${issue.title} ${issue.body ?? ''}`
  return new Set(tokenizar(texto).filter((t) => t.length >= 3 && !PALAVRAS_IGNORADAS.has(t)))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersecao = 0
  for (const token of a) {
    if (b.has(token)) intersecao++
  }
  const uniao = a.size + b.size - intersecao
  return uniao === 0 ? 0 : intersecao / uniao
}

/** Sobreposição de conteúdo (0 a 1) entre duas issues — Jaccard sobre os tokens de título+corpo. */
export function similaridadeDeConteudo(a: IssueParaDiagnostico, b: IssueParaDiagnostico): number {
  return jaccard(tokensDeConteudo(a), tokensDeConteudo(b))
}

export interface RepeticaoEncontrada {
  original: number
  similaridade: number
}

/** Para cada issue repetida, a issue original (mais antiga) e a similaridade medida. */
export function detectarRepetidos(
  issues: IssueParaDiagnostico[],
  limiar = 0.6
): Map<number, RepeticaoEncontrada> {
  const resultado = new Map<number, RepeticaoEncontrada>()
  const ordenadas = [...issues].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  for (let i = 0; i < ordenadas.length; i++) {
    const atual = ordenadas[i]
    if (!atual || resultado.has(atual.number)) continue
    for (let j = 0; j < i; j++) {
      const anterior = ordenadas[j]
      if (!anterior || resultado.has(anterior.number)) continue
      const similaridade = similaridadeDeConteudo(atual, anterior)
      if (similaridade >= limiar) {
        resultado.set(atual.number, { original: anterior.number, similaridade })
        break
      }
    }
  }
  return resultado
}

// ---------------------------------------------------------------------------
// 3) PARADO — sem atualização há tempo demais.
// ---------------------------------------------------------------------------

export function avaliarParado(
  issue: IssueParaDiagnostico,
  agora: number,
  diasParaParado = 45
): { parado: boolean; motivo: string } {
  const atualizado = Date.parse(issue.updatedAt)
  if (!Number.isFinite(atualizado)) {
    return { parado: false, motivo: 'data de atualização inválida' }
  }
  const diasParado = Math.floor((agora - atualizado) / (24 * 60 * 60 * 1000))
  if (diasParado >= diasParaParado) {
    return {
      parado: true,
      motivo: `sem atualização há ${diasParado} dias (limite: ${diasParaParado})`,
    }
  }
  return { parado: false, motivo: `atualizada há ${diasParado} dia(s)` }
}

// ---------------------------------------------------------------------------
// 4) RISCO — termos e labels que pedem cuidado extra antes de mexer.
// ---------------------------------------------------------------------------

const TERMOS_DE_RISCO = [
  'senha',
  'vazamento',
  'vulnerab',
  'seguranca',
  'quebra',
  'breaking',
  'producao',
  'dados perdidos',
  'perda de dados',
  'credencial',
  'exploit',
  'injection',
  'xss',
  'csrf',
  'exposto',
  'exposta',
  'vazando',
  'invasao',
  'ataque',
  'malicioso',
  'privilegio',
]

const LABELS_DE_RISCO = new Set([
  'security',
  'seguranca',
  'critical',
  'critico',
  'urgent',
  'p0',
  'p1',
])

export function avaliarRisco(issue: IssueParaDiagnostico): { risco: boolean; motivo: string } {
  const texto = normalizarSemAcento(`${issue.title} ${issue.body ?? ''}`)
  const termoBatido = TERMOS_DE_RISCO.find((termo) => texto.includes(normalizarSemAcento(termo)))
  if (termoBatido) {
    return { risco: true, motivo: `menciona termo de risco: "${termoBatido}"` }
  }
  const labelBatida = (issue.labels ?? []).find((label) =>
    LABELS_DE_RISCO.has(normalizarSemAcento(label))
  )
  if (labelBatida) {
    return { risco: true, motivo: `tem a label de risco "${labelBatida}"` }
  }
  return { risco: false, motivo: 'nenhum sinal de risco encontrado' }
}

// ---------------------------------------------------------------------------
// 5) VAGO — sem detalhe suficiente para agir.
// ---------------------------------------------------------------------------

const MINIMO_DE_PALAVRAS_NO_CORPO = 15

export function avaliarVago(issue: IssueParaDiagnostico): { vago: boolean; motivo: string } {
  const corpo = (issue.body ?? '').trim()
  if (corpo.length === 0) {
    return { vago: true, motivo: 'issue sem corpo/descrição' }
  }
  const palavras = corpo.split(/\s+/).filter(Boolean)
  const temEstrutura = /```|^\s*[-*\d]/m.test(corpo)
  if (palavras.length < MINIMO_DE_PALAVRAS_NO_CORPO && !temEstrutura) {
    return {
      vago: true,
      motivo: `corpo com só ${palavras.length} palavra(s) e sem lista/passos/bloco de código`,
    }
  }
  return { vago: false, motivo: `corpo com ${palavras.length} palavra(s)` }
}

// ---------------------------------------------------------------------------
// Orquestração: as cinco, na ordem do desenho.
// ---------------------------------------------------------------------------

function perguntaAoGrafo(issue: IssueParaDiagnostico): string {
  return issue.title
}

export async function diagnosticarIssues(
  issues: IssueParaDiagnostico[],
  deps: DependenciasDoDiagnostico
): Promise<ResultadoDoDiagnostico> {
  const garantirGrafo = deps.garantirGrafo ?? garantirGrafoDoRepositorio
  const garantirHistorico = deps.garantirHistorico ?? garantirHistoricoCompletoDoGit
  const consultarGrafo = deps.consultarGrafo ?? consultarGrafoDeCodigo
  const execFileImpl = deps.execFileImpl ?? defaultExecFileImpl
  const agora = deps.agora ?? Date.now()
  const diasParaParado = deps.diasParaParado ?? 45
  const limiarDeRepeticao = deps.limiarDeRepeticao ?? 0.6

  const achados: AchadoDeDiagnostico[] = []
  const jaAchado = new Set<number>()

  // 1) JÁ RESOLVIDO
  //
  // O clone que o produto usa (LocalWorkspaceProvider) é RASO (`--depth 1`) —
  // sem aprofundar o histórico primeiro, `dataDaUltimaAlteracao` compararia
  // toda issue contra a data do próprio clone, e TUDO pareceria "alterado
  // agora" (medido ao vivo em 01/09/2026 contra o Jardim das Patinhas — ver o
  // relatório da tarefa). O histórico só precisa ser aprofundado UMA VEZ por
  // lote, não por issue.
  const grafo = await garantirGrafo(deps.workspacePath)
  const historico = grafo.ok
    ? await garantirHistorico(deps.workspacePath, { execFileImpl })
    : undefined
  let grafoIndisponivel: string | undefined
  if (!grafo.ok) {
    grafoIndisponivel = grafo.motivo
  } else if (historico && !historico.ok) {
    grafoIndisponivel = `histórico git incompleto — sinal de recência não confiável: ${historico.motivo}`
  } else {
    for (const issue of issues) {
      const resultado = await consultarGrafo(deps.workspacePath, perguntaAoGrafo(issue))
      const avaliacao = await avaliarJaResolvido(issue, resultado, deps.workspacePath, execFileImpl)
      if (avaliacao.resolvido) {
        achados.push({
          issue: issue.number,
          categoria: 'ja_resolvido',
          motivo: avaliacao.motivo,
          ...(avaliacao.evidencia !== undefined ? { evidencia: avaliacao.evidencia } : {}),
        })
        jaAchado.add(issue.number)
      }
    }
  }

  // 2) REPETIDO
  const repetidos = detectarRepetidos(issues, limiarDeRepeticao)
  for (const issue of issues) {
    if (jaAchado.has(issue.number)) continue
    const rep = repetidos.get(issue.number)
    if (rep) {
      achados.push({
        issue: issue.number,
        categoria: 'repetido',
        motivo: `${Math.round(rep.similaridade * 100)}% de sobreposição de conteúdo com a issue #${rep.original}`,
        evidencia: `issue #${rep.original}`,
      })
      jaAchado.add(issue.number)
    }
  }

  // 3) PARADO
  for (const issue of issues) {
    if (jaAchado.has(issue.number)) continue
    const parado = avaliarParado(issue, agora, diasParaParado)
    if (parado.parado) {
      achados.push({ issue: issue.number, categoria: 'parado', motivo: parado.motivo })
      jaAchado.add(issue.number)
    }
  }

  // 4) RISCO
  for (const issue of issues) {
    if (jaAchado.has(issue.number)) continue
    const risco = avaliarRisco(issue)
    if (risco.risco) {
      achados.push({ issue: issue.number, categoria: 'risco', motivo: risco.motivo })
      jaAchado.add(issue.number)
    }
  }

  // 5) VAGO
  for (const issue of issues) {
    if (jaAchado.has(issue.number)) continue
    const vago = avaliarVago(issue)
    if (vago.vago) {
      achados.push({ issue: issue.number, categoria: 'vago', motivo: vago.motivo })
      jaAchado.add(issue.number)
    }
  }

  return grafoIndisponivel !== undefined ? { achados, grafoIndisponivel } : { achados }
}
