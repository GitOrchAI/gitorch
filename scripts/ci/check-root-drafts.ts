/**
 * Portao da raiz: reprova rascunho de automacao versionado na RAIZ do repo.
 *
 * POR QUE ISTO EXISTE
 * O dev assincrono deixa rascunho de automacao na raiz e REINCIDE. Neste repo
 * a raiz carregava `check-actions.mjs` (poller de Actions com `catch {}` vazio,
 * apontando pro nome antigo `loureng/gitorch`) e `patch.diff` (um bloco
 * SEARCH/REPLACE de ferramenta de edicao, commitado por engano). No PR #336 a
 * mesma mao deixou `fix_orchestrator.js`, `fix_telegram_bot_final.js` e
 * `get_telegram.js` — esses nunca chegaram na main so porque o PR nao mesclou.
 * Sem portao, a faxina se repete no mes que vem.
 *
 * PRINCIPIO DE PROJETO (anti fail-closed)
 * 1. So olha a RAIZ (profundidade 0). Nada em `scripts/`, `apps/`, `packages/`
 *    e avaliado — que e justamente para onde a mensagem manda mover.
 * 2. So olha arquivo RASTREADO pelo git. Lixo local nao versionado nao reprova.
 * 3. Tem escotilha explicita: `RAIZ_PERMITIDA`. Arquivo legitimo na raiz entra
 *    ali com o motivo e QUEM chama, e a entrada aparece na diff para revisao.
 * 4. A mensagem DIZ O QUE FAZER (mover para `scripts/` ou `tools/`). Mensagem
 *    que so nega treina a pessoa a contornar com `git add -f`.
 *
 * Uso: pnpm exec tsx scripts/ci/check-root-drafts.ts
 */

import { execFileSync } from 'node:child_process'

/**
 * Escotilha: arquivo da raiz que casa com o padrao mas e LEGITIMO e USADO.
 * Toda entrada precisa do motivo e de quem chama — a prova mora aqui.
 *
 * Hoje esta vazia: a raiz deste repo nao tem nenhum script legitimo solto.
 * Se um dia tiver, registre aqui em vez de afrouxar o padrao.
 */
export const RAIZ_PERMITIDA: Record<string, string> = {}

/** Verbos com que o dev batiza rascunho descartavel. */
const VERBOS_DE_RASCUNHO = [
  'patch',
  'fix',
  'check',
  'get',
  'debug',
  'clean',
  'verify',
  'temp',
  'tmp',
  'scratch',
  'run',
  'dump',
]

const EXTENSOES_DE_SCRIPT = 'py|js|cjs|mjs|ts|tsx|sh|bash|ps1|rb|pl'

/**
 * Marcador que denuncia rascunho no NOME, qualquer que seja a extensao.
 *
 * Existe porque as regras acima olham a EXTENSAO, e os dois piores achados da
 * faxina escapavam por ela: `nginx-fix.conf` (versao pobre da config real, que
 * derrubaria a API se alguem aplicasse) e `jules_sources.json` (124 KB de
 * despejo de API). Banir `.conf` e `.json` reprovaria `package.json` e
 * `tsconfig.json` — ou seja, travaria o CI. Entao o sinal tem que estar no
 * nome, nao na extensao.
 *
 * A lista e FAMILIA, nao inventario do que ja vimos: `-fix.` pega
 * `nginx-fix.conf` e tambem o `caddy-fix.conf` do mes que vem.
 *
 * FICARAM DE FORA de proposito (medido, nao chutado — a sonda rodou contra os
 * 962 nomes rastreados do gitorch e os 2554 do patinhas):
 *  - `resolution|resolved|conflict`: encosta em `MERGE_CONFLICT_RESOLUTION.md`,
 *    rastreado na raiz do patinhas. Entraria como CI vermelho no primeiro run,
 *    e nao ganharia nada: `merge-resolution.patch` ja cai em `saida-de-execucao`.
 *  - `test|teste`: `-test.ts` e convencao da industria, nao marca de rascunho.
 *  - `v2|v3`: sufixo de versao e legitimo em documento e em rota de API.
 *
 * CUIDADO ao um dia estender o portao para alem da raiz: `-fix.` encosta em
 * `.github/workflows/jules-ci-failure-fix.yml`, que e legitimo. Enquanto o
 * portao olhar so a profundidade 0, isso nao acontece.
 */
const MARCADORES_DE_RASCUNHO = [
  'fix',
  'fixes',
  'hotfix',
  'temp',
  'tmp',
  'wip',
  'draft',
  'rascunho',
  'old',
  'new',
  'copy',
  'copia',
  'bkp',
  'backup',
  'final',
]

/** Marcador de despejo de API/ferramenta, com extensao de DADOS. */
const MARCADORES_DE_DESPEJO = [
  'sources',
  'dump',
  'dumps',
  'raw',
  'payload',
  'payloads',
  'response',
  'responses',
  'output',
  'outputs',
]

/**
 * `.sql` NAO entra aqui: `schema_dump.sql` e rastreado na raiz do patinhas e
 * nao esta na lista de orfaos aprovada. Regra que trava o CI e pior que o
 * problema que ela resolve.
 */
const EXTENSOES_DE_DADOS = 'json|jsonl|ndjson|yaml|yml|csv|xml|har'

interface RegraDaRaiz {
  nome: string
  padrao: RegExp
  explicacao: string
  destino: string
}

export const REGRAS: RegraDaRaiz[] = [
  {
    nome: 'script-de-rascunho',
    padrao: new RegExp(
      `^(${VERBOS_DE_RASCUNHO.join('|')})[-_][^/]*\\.(${EXTENSOES_DE_SCRIPT})$`,
      'i'
    ),
    explicacao: 'script de automacao descartavel (nome comeca com verbo de rascunho)',
    destino:
      'mova para scripts/ e, se for para durar, cubra com teste ao lado (scripts/**/*.test.ts roda em `pnpm run test:scripts`)',
  },
  {
    nome: 'sobra-de-conflito',
    padrao:
      /^[^/]+\.(main|backup|bak|orig)\.[A-Za-z0-9]+$|^[^/]+\.(orig|rej|bak|resolved-section)$/i,
    explicacao: 'sobra de resolucao de conflito (a versao boa ja esta no arquivo canonico)',
    destino: 'apague — o git ja guarda os dois lados do conflito no historico',
  },
  {
    nome: 'saida-de-execucao',
    padrao: /^[^/]+\.(txt|log)$|^[^/]+\.patch$|^[^/]+\.diff$/i,
    explicacao: 'saida de build/lint/diff colada no repo (envelhece em horas e ninguem le)',
    destino: 'nao versione; se precisar guardar evidencia, anexe ao PR ou suba como artifact do CI',
  },
  {
    nome: 'marcador-de-rascunho',
    padrao: new RegExp(`^[^/]+[-_](${MARCADORES_DE_RASCUNHO.join('|')})\\.[A-Za-z0-9]+$`, 'i'),
    explicacao:
      'o proprio nome diz que e rascunho (-fix, -tmp, -old, -final...), e a extensao nao muda isso',
    destino:
      'aplique a correcao no arquivo canonico e apague este. Se for configuracao de verdade, ela mora no diretorio de config com o nome definitivo — nunca em cima de um `-fix`',
  },
  {
    nome: 'despejo-de-dados',
    padrao: new RegExp(
      `^[^/]+[-_](${MARCADORES_DE_DESPEJO.join('|')})\\.(${EXTENSOES_DE_DADOS})$`,
      'i'
    ),
    explicacao:
      'despejo de resposta de API versionado (envelhece em horas e costuma carregar dado de outra conta ou de outro repo)',
    destino:
      'nao versione resposta de API. Se precisar de fixture, recorte o minimo necessario e ponha em tests/fixtures/ com o nome do caso que ela cobre',
  },
  // As duas regras abaixo pegam a FAMILIA, nao so os nomes que ja vimos — e o
  // que impede a reincidencia com um nome novo (`sync_missions.sh`, `dump.mjs`).
  {
    nome: 'script-solto-na-raiz',
    padrao: /^[^/]+\.(sh|bash|ps1|py|rb|pl)$/i,
    explicacao: 'script de shell/python solto na raiz de um monorepo TypeScript',
    destino:
      'mova para scripts/. Se a raiz for mesmo o lugar dele, registre em RAIZ_PERMITIDA com quem o chama',
  },
  {
    nome: 'modulo-solto-na-raiz',
    padrao: /^(?![^/]*\.config\.(ts|js|mjs|cjs)$)[^/]+\.(ts|tsx|js|jsx|cjs|mjs)$/i,
    explicacao:
      'modulo TS/JS na raiz que nao e arquivo de configuracao — produto mora em apps/ ou packages/, ferramenta mora em scripts/',
    destino:
      'mova para apps/, packages/ ou scripts/. Se a raiz for mesmo o lugar dele, registre em RAIZ_PERMITIDA com quem o chama',
  },
]

/**
 * Variaveis que o git EXPORTA para os proprios hooks, apontando para o
 * repositorio de quem chamou. Elas tem PRECEDENCIA sobre o `cwd` do processo:
 * com `GIT_DIR`/`GIT_INDEX_FILE` no ambiente, `execFileSync('git', ..., { cwd:
 * outroRepo })` opera no repositorio ORIGINAL, nao no do `cwd`.
 *
 * Isto NAO e teoria — foi medido nesta branch. O `.husky/pre-commit` roda a
 * suite de scripts, e o teste de nome acentuado deste portao cria um repo
 * temporario e roda `git add -A` nele. Herdando o ambiente do hook, esse `add`
 * gravou no indice REAL: os 963 arquivos rastreados viraram delecao staged e
 * sobraram apenas os 2 do repo de teste (`correcao_ci.py` e `package.json`).
 * Quem nao olhasse o `git status` commitaria a arvore inteira como apagada.
 */
const VARIAVEIS_DE_REPO_DO_GIT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
]

/**
 * Ambiente sem as variaveis que sequestram a descoberta do repositorio, para
 * que o `cwd` volte a ser quem manda. Use SEMPRE que rodar git com `cwd`
 * explicito — em producao e, principalmente, em teste.
 */
export function ambienteGitIsolado(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const chave of VARIAVEIS_DE_REPO_DO_GIT) delete env[chave]
  return env
}

export interface AchadoDaRaiz {
  arquivo: string
  regra: string
  explicacao: string
  destino: string
}

/**
 * Decide se UM nome de arquivo da raiz e rascunho. Recebe so o nome — nao toca
 * disco — para poder ser testado dos dois lados sem fixture.
 */
export function classificarArquivoDaRaiz(
  nome: string,
  permitidos: Record<string, string> = RAIZ_PERMITIDA
): AchadoDaRaiz | null {
  if (nome.includes('/')) return null // so a raiz
  if (nome.startsWith('.')) return null // dotfile de config e legitimo
  if (Object.prototype.hasOwnProperty.call(permitidos, nome)) return null

  for (const regra of REGRAS) {
    if (regra.padrao.test(nome)) {
      return {
        arquivo: nome,
        regra: regra.nome,
        explicacao: regra.explicacao,
        destino: regra.destino,
      }
    }
  }
  return null
}

export function varrerRaiz(
  nomes: string[],
  permitidos: Record<string, string> = RAIZ_PERMITIDA
): AchadoDaRaiz[] {
  return nomes
    .map((n) => classificarArquivoDaRaiz(n, permitidos))
    .filter((a): a is AchadoDaRaiz => a !== null)
}

/**
 * Arquivos RASTREADOS na raiz (profundidade 0).
 *
 * `-z` NAO e detalhe: sem ele o git CITA e ESCAPA nome nao-ASCII, e o dono
 * destes dois repositorios e brasileiro. `correcao_ci.py` com cedilha e til
 * sai de `git ls-files` como `"corre\303\247\303\243o_ci.py"` — com aspas.
 * Nenhum dos padroes casa uma string que termina em `.py"`, entao o rascunho
 * batizado em portugues passava batido. Era a brecha mais provavel de ser
 * usada por acidente justamente aqui.
 *
 * Por que `-z` e nao `core.quotepath=false`: `quotepath` so desliga o escape
 * do byte nao-ASCII. Nome com aspas, barra invertida ou quebra de linha
 * CONTINUA citado. `-z` e o contrato do git para consumo por maquina (caminho
 * em bytes crus, terminado em NUL, citacao desligada) e resolve os tres casos
 * de uma vez, sem depender de configuracao da maquina de quem roda o CI.
 *
 * @param diretorio raiz do repositorio a inspecionar (default: cwd do processo).
 */
export function listarArquivosDaRaiz(diretorio?: string): string[] {
  const saida = execFileSync('git', ['ls-files', '-z', '--', ':(exclude)*/*'], {
    encoding: 'utf8',
    cwd: diretorio,
    env: ambienteGitIsolado(),
  })
  return saida.split('\0').filter((caminho) => caminho.length > 0)
}

export function montarMensagem(achados: AchadoDaRaiz[]): string {
  const linhas: string[] = ['', 'Rascunho de automacao na RAIZ do repositorio.', '']
  for (const a of achados) {
    linhas.push(`  - ${a.arquivo}`)
    linhas.push(`      o que e: ${a.explicacao}`)
    linhas.push(`      o que fazer: ${a.destino}`)
    linhas.push('')
  }
  linhas.push('A raiz e a vitrine do repo (e este repo e publico): quem chega nela')
  linhas.push('tem que entender o produto, nao tropecar no rascunho de ontem.')
  linhas.push('')
  linhas.push('Como resolver, na ordem:')
  linhas.push('  1. O script ainda serve?  git mv <arquivo> scripts/<arquivo>')
  linhas.push('     e adicione <arquivo>.test.ts ao lado para ele nao virar orfao.')
  linhas.push('  2. Era descartavel?       git rm <arquivo>')
  linhas.push('     (o historico do git guarda; apagar da raiz nao perde nada)')
  linhas.push('  3. E legitimo e a raiz e MESMO o lugar dele?')
  linhas.push('     adicione o nome em RAIZ_PERMITIDA, em')
  linhas.push('     scripts/ci/check-root-drafts.ts, com o motivo e QUEM chama.')
  linhas.push('')
  linhas.push('`git add -f` nao resolve: o portao roda no CI, nao no .gitignore.')
  linhas.push('')
  return linhas.join('\n')
}

function principal(): void {
  const achados = varrerRaiz(listarArquivosDaRaiz())
  if (achados.length === 0) {
    console.log('Raiz limpa: nenhum rascunho de automacao versionado.')
    return
  }
  console.error(montarMensagem(achados))
  process.exit(1)
}

const ehEntradaDireta =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('check-root-drafts.ts') ||
    process.argv[1].endsWith('check-root-drafts'))

if (ehEntradaDireta) {
  principal()
}
