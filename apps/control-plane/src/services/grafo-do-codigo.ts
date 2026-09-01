// Ponte com o graphify — o grafo de código da máquina (CLI, não MCP).
//
// D6 do desenho da leva 2 ("Analista diagnostica") exige que "já resolvido"
// use O GRAFO DO CÓDIGO, não só o texto da issue. O graphify já existe na
// máquina (`which graphify`) mas, medido em 01/09, nenhum caminho do produto
// o invocava — esta é a primeira ponte real.
//
// Dois comandos bastam pro que este diagnóstico precisa:
//   `graphify extract <path> --code-only` — indexação AST local, SEM chave de
//   LLM (nenhuma está configurada nesta máquina — conferido antes de escrever
//   este arquivo). Não tenta o backend `claude-cli` (que chamaria `claude -p`
//   dentro do processo do produto) de propósito: mais lento, e o produto não
//   deveria depender de o operador ter uma sessão do Claude Code aberta.
//   `graphify query "<pergunta>"` — travessia BFS por palavras-chave (com
//   IDF), NÃO é uma pergunta em linguagem natural respondida por LLM. Devolve
//   os nós do grafo cujo rótulo bate com os termos da pergunta, cada um com o
//   arquivo de origem (`src=...`).
//
// Cada função aqui devolve um resultado EXPLÍCITO de indisponibilidade
// (`{ ok: false, motivo }` / `{ disponivel: false, motivo }`) em vez de
// lançar ou engolir o erro num catch mudo — quem chama decide o que fazer, e
// o motivo real aparece no diagnóstico final. Nunca finge que consultou o
// grafo quando não conseguiu.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type ExecFileImpl = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; cwd?: string }
) => Promise<{ stdout: string; stderr: string }>

/** O mesmo `execFile` promisificado usado no resto do control-plane (workspace-diagnosis.ts, graph-export.ts). */
export const defaultExecFileImpl: ExecFileImpl = promisify(execFile)

export interface GrafoPronto {
  ok: true
}
export interface GrafoIndisponivel {
  ok: false
  motivo: string
}
export type ResultadoDaExtracao = GrafoPronto | GrafoIndisponivel

export interface OpcoesDoGrafo {
  execFileImpl?: ExecFileImpl
  timeoutMs?: number
  graphifyBin?: string
  existsSyncImpl?: (caminho: string) => boolean
}

function caminhoDoGraphJson(workspacePath: string): string {
  return path.join(workspacePath, 'graphify-out', 'graph.json')
}

function mensagemDoErro(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const stderr = (e.stderr ?? '').trim()
  return stderr.length > 0 ? stderr : (e.message ?? String(err))
}

/**
 * Garante que existe um `graph.json` (extração AST local, sem LLM) para este
 * workspace. Reaproveita um grafo já extraído — não reprocessa o repo a cada
 * chamada (o diagnóstico roda uma vez por issue; extrair de novo a cada uma
 * inviabilizaria o custo).
 */
export async function garantirGrafoDoRepositorio(
  workspacePath: string,
  opcoes: OpcoesDoGrafo = {}
): Promise<ResultadoDaExtracao> {
  const exec = opcoes.execFileImpl ?? defaultExecFileImpl
  const graphifyBin = opcoes.graphifyBin ?? 'graphify'
  const existsSyncImpl = opcoes.existsSyncImpl ?? existsSync
  const timeoutMs = opcoes.timeoutMs ?? 5 * 60 * 1000

  if (existsSyncImpl(caminhoDoGraphJson(workspacePath))) {
    return { ok: true }
  }

  try {
    await exec(graphifyBin, ['extract', workspacePath, '--code-only', '--out', workspacePath], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, motivo: `graphify extract falhou: ${mensagemDoErro(err)}` }
  }
}

/**
 * Um nó do grafo que a consulta encontrou, com o arquivo de origem (quando o
 * graphify o reporta).
 *
 * `semente: true` = o RÓTULO deste nó bateu direto com um termo da pergunta
 * (aparece em "Start: [...]" no cabeçalho da saída do `graphify query`).
 * `semente: false` = o nó só apareceu por estar a até 2 saltos (BFS depth=2)
 * de uma semente — ex.: `App.tsx` aparece em QUASE TODA consulta de UI porque
 * importa a página inteira, sem que o termo procurado tenha nada a ver com
 * `App.tsx` em si. MEDIDO AO VIVO em 01/09/2026 contra o Jardim das
 * Patinhas: um "arquivo alterado depois da issue" que era só vizinho (nunca
 * semente) foi exatamente o padrão por trás de 5 dos 11 falsos positivos da
 * primeira medição — ver o relatório da tarefa. Por isso quem decide
 * "já resolvido" (diagnostico-de-issues.ts) só confia em nó SEMENTE.
 */
export interface NoDoGrafo {
  label: string
  arquivo?: string
  semente: boolean
}

export interface ConsultaDisponivel {
  disponivel: true
  /** Saída bruta do `graphify query`, para auditoria/depuração. */
  bruto: string
  nos: NoDoGrafo[]
}
export interface ConsultaIndisponivel {
  disponivel: false
  motivo: string
}
export type ResultadoDaConsulta = ConsultaDisponivel | ConsultaIndisponivel

// `graphify query` imprime uma linha por nó encontrado, no formato:
//   NODE <label> [src=<arquivo> loc=<Lxx> community=<n>]
// e um cabeçalho com os rótulos-semente que casaram com a pergunta:
//   Graph: <path> (<n> nodes) | Traversal: BFS depth=2 | Start: ['a', 'b'] | <n> nodes found
// (conferidos ao vivo contra um graph.json real em 01/09/2026).
const LINHA_DE_NO = /^NODE\s+(.+?)\s+\[src=(\S+)/
const LINHA_DE_CABECALHO = /\|\s*Start:\s*\[(.*?)\]\s*\|/
const ITEM_DA_LISTA_PYTHON = /'((?:[^'\\]|\\.)*)'/g

/**
 * Extrai os rótulos-semente do cabeçalho (`Start: ['a', 'b']`, formato de
 * lista Python que o graphify imprime). Falha de parsing (o CLI mudou o
 * formato, por exemplo) devolve conjunto VAZIO — não "todos os nós são
 * semente": um cabeçalho não reconhecido não pode virar permissão ampla por
 * engano, mesmo raciocínio de `normalizarNivel` em autonomia.ts.
 */
function sementesDoCabecalho(bruto: string): Set<string> {
  const cabecalho = bruto.match(LINHA_DE_CABECALHO)?.[1]
  if (!cabecalho) return new Set()
  const sementes = new Set<string>()
  for (const item of cabecalho.matchAll(ITEM_DA_LISTA_PYTHON)) {
    const valor = item[1]
    if (valor) sementes.add(valor)
  }
  return sementes
}

/**
 * Consulta o grafo já extraído. `pergunta` é o texto de onde o graphify
 * extrai os termos de busca (o próprio CLI faz IDF + stopwords PT/EN/etc. —
 * não é preciso pré-processar aqui).
 */
export async function consultarGrafoDeCodigo(
  workspacePath: string,
  pergunta: string,
  opcoes: OpcoesDoGrafo & { budget?: number } = {}
): Promise<ResultadoDaConsulta> {
  const exec = opcoes.execFileImpl ?? defaultExecFileImpl
  const graphifyBin = opcoes.graphifyBin ?? 'graphify'
  const timeoutMs = opcoes.timeoutMs ?? 30_000
  const budget = opcoes.budget ?? 800
  const graphJsonPath = caminhoDoGraphJson(workspacePath)

  let stdout: string
  try {
    const resultado = await exec(
      graphifyBin,
      ['query', pergunta, '--graph', graphJsonPath, '--budget', String(budget)],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
    )
    stdout = resultado.stdout
  } catch (err) {
    return { disponivel: false, motivo: `graphify query falhou: ${mensagemDoErro(err)}` }
  }

  const sementes = sementesDoCabecalho(stdout)
  const nos: NoDoGrafo[] = []
  for (const linha of stdout.split('\n')) {
    const achado = linha.match(LINHA_DE_NO)
    if (!achado) continue
    const label = achado[1]
    const arquivo = achado[2]
    if (!label) continue
    const semente = sementes.has(label)
    nos.push(arquivo ? { label, arquivo, semente } : { label, semente })
  }
  return { disponivel: true, bruto: stdout, nos }
}

export interface HistoricoPronto {
  ok: true
}
export interface HistoricoIndisponivel {
  ok: false
  motivo: string
}

/**
 * Garante histórico git COMPLETO no workspace — não só o `graph.json`.
 *
 * MEDIDO AO VIVO em 01/09/2026, contra um clone `--depth 1` (o MESMO comando
 * que `LocalWorkspaceProvider` usa pra clonar o repositório do cliente —
 * packages/workspace-engine/src/local-provider.ts): com histórico raso,
 * `git log -1` devolve a mesma data (a do próprio clone) para QUALQUER
 * arquivo, porque só existe um commit local. Isso fazia TODO arquivo parecer
 * "alterado agora" — inclusive um arquivo cuja última mudança real era três
 * semanas ANTES da issue. `dataDaUltimaAlteracao` sozinha não tinha como
 * perceber isso: o `git log` não FALHA num clone raso, só devolve a resposta
 * errada em silêncio. Por isso esta checagem é SEPARADA e roda ANTES de
 * qualquer leitura de data — sem histórico completo, o sinal temporal de
 * "já resolvido" não mede nada, e é melhor dizer isso explicitamente do que
 * confiar numa data que não significa o que parece significar.
 */
export async function garantirHistoricoCompletoDoGit(
  workspacePath: string,
  opcoes: OpcoesDoGrafo = {}
): Promise<HistoricoPronto | HistoricoIndisponivel> {
  const exec = opcoes.execFileImpl ?? defaultExecFileImpl
  const timeoutMs = opcoes.timeoutMs ?? 2 * 60 * 1000

  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-shallow-repository'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      cwd: workspacePath,
    })
    if (stdout.trim() !== 'true') {
      return { ok: true }
    }
  } catch (err) {
    return {
      ok: false,
      motivo: `não foi possível checar se o clone é raso (git rev-parse --is-shallow-repository): ${mensagemDoErro(err)}`,
    }
  }

  try {
    await exec('git', ['fetch', '--unshallow'], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      cwd: workspacePath,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, motivo: `git fetch --unshallow falhou: ${mensagemDoErro(err)}` }
  }
}

/**
 * Data (epoch ms) da última alteração de um arquivo no histórico git do
 * workspace, ou `undefined` se não der para ler (arquivo fora do controle de
 * versão, workspace sem `.git`, erro de processo). É um sinal SECUNDÁRIO —
 * "o código bate com o texto da issue" não é "a issue foi resolvida"; quase
 * todo bug report bate por palavra-chave com o próprio código que tem o bug.
 * A data separa "código relacionado existe" (sempre verdade) de "código
 * relacionado MUDOU depois de a issue ter sido aberta" (evidência real de
 * resolução). Falha aqui não impede o diagnóstico — o chamador trata
 * `undefined` como "não foi possível confirmar recência", nunca como "não
 * resolvido" silencioso: as duas frases aparecem separadas no motivo final.
 */
export async function dataDaUltimaAlteracao(
  workspacePath: string,
  arquivo: string,
  execFileImpl: ExecFileImpl = defaultExecFileImpl
): Promise<number | undefined> {
  try {
    const { stdout } = await execFileImpl('git', ['log', '-1', '--format=%cI', '--', arquivo], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      cwd: workspacePath,
    })
    const iso = stdout.trim()
    if (!iso) return undefined
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : undefined
  } catch {
    return undefined
  }
}
