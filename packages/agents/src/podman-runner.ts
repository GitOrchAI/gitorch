import { randomUUID } from 'node:crypto'
import type {
  RuntimeCommandRequest,
  RuntimeCommandResult,
  RuntimeCommandRunner,
} from './runtime-adapter.js'
import { realRuntimeCommandRunner } from './runtime-adapter.js'

export interface PodmanMount {
  /** Caminho no host. */
  source: string
  /** Caminho dentro do container. */
  target: string
  /** Somente-leitura. Default true: montagens de credencial nunca são graváveis. */
  readOnly?: boolean
}

// Ponto de montagem do workspace e do HOME do agente DENTRO do container.
// HOME fica FORA do workspace: caches/tokens que o CLI escreve no HOME não
// podem cair no repositório clonado (e vazar em um git add posterior).
const CONTAINER_WORKSPACE = '/workspace'
const CONTAINER_HOME = '/home/agent'

export interface CreatePodmanCommandRunnerOptions {
  /** Imagem OCI usada para rodar a missão. */
  image: string
  /** Binário do motor de containers no host (podman ou docker). */
  podmanBinary?: string
  /**
   * Mapeamento de usuário. 'keep-id' (default) é do podman rootless: arquivos
   * do workspace ficam legíveis pelo host. Para docker, passar false.
   */
  userNamespace?: string | false
  /**
   * Montagens adicionais (ex.: credenciais OAuth). São somente-leitura a menos
   * que readOnly=false explícito — conteúdo de repositório de terceiros dirige
   * o CLI (prompt injection), então nada montado é gravável sem intenção.
   */
  mounts?: PodmanMount[]
  /** Limite de memória do container (formato do podman, ex.: '2g'). */
  memoryLimit?: string
  /**
   * Limite de memória+swap do container (formato do podman, ex.: '2g'). Vira
   * `--memory-swap`. Default: igual a `memoryLimit` — ou seja, ZERO swap
   * adicional além do teto de RAM.
   *
   * SEM ISTO, provado ao vivo nesta VM que o podman deixa o container
   * escapar do `--memory` nominal: com `--memory=64m` sem `--memory-swap`
   * explícito, um processo que aloca 100MB (bem acima do teto) SOBREVIVE —
   * o rootless/crun aplica `memory.swap.max` igual ao `memory.max` por
   * padrão (permite até ~2x o teto antes do OOM killer agir). Passando
   * `--memory-swap` igual a `--memory` fecha essa folga: o mesmo teste
   * (100MB contra teto de 64m) é morto (SIGKILL, exit 137).
   */
  memorySwapLimit?: string
  /** Limite de processos dentro do container. */
  pidsLimit?: number
  /**
   * Teto de CPU do container (formato do podman `--cpus`, ex.: '1.5').
   * Sem isto o teto de 1,5 vCPU do plano de capacidade NÃO existia no caminho
   * podman (P2-4): uma missão em loop ocupava quantos cores quisesse na VM
   * compartilhada. Opcional para não mudar hosts já calibrados sem a env.
   */
  cpus?: string
  /** Runner usado para executar o podman em si (injetável para teste). */
  hostRunner?: RuntimeCommandRunner
  /**
   * Gancho por missão: prepara montagens específicas da missão (ex.: materializa
   * a credencial do dono do projeto num staging temporário) e devolve uma função
   * de limpeza chamada ao fim. Roda ANTES do container e permite montar dados
   * que só existem por missão, sem vazar entre tenants.
   */
  prepareMounts?: (
    request: RuntimeCommandRequest
  ) => Promise<{ mounts: PodmanMount[]; cleanup?: () => Promise<void> }>
  /**
   * Antes de QUALQUER missão, verifica que a imagem TEM o plugin de
   * segurança do GitOrch instalado (hooks.json em /opt/gitorch-plugin/gitorch)
   * — decisão do dono do projeto: `--dangerously-skip-permissions` (fixa no
   * código, ver scheduler.ts) só desliga a caixa de diálogo "posso
   * executar?" do motor; quem trava de verdade é o plugin de hooks do
   * GitOrch dentro do container. Sem essa verificação, se o plugin um dia
   * deixar de ser instalado na imagem, a flag ficaria sem NENHUM gate e nada
   * avisaria. `GITORCH_AGY_PLUGIN=0` (a env que desliga o plugin no
   * entrypoint da imagem, mesmo que ele exista nela) recusa pelo MESMO
   * motivo. Default false: só os dois pontos reais de produção
   * (buildMissionRunner/buildRemoteRuntimeStackIfConfigured em scheduler.ts)
   * ligam isto — os testes unitários deste módulo continuam exercitando só a
   * montagem do comando, sem depender de podman de verdade.
   */
  requireGitorchPlugin?: boolean
  /**
   * Identifica o RUNNER (não só engine+imagem) na chave do cache da
   * verificação do plugin. Achado importante da revisão pós-merge: sem isto,
   * o stack LOCAL e o stack REMOTO do free-tier (via SSH) podem ter o mesmo
   * `podmanBinary`+`image` por default e colidiam na MESMA chave — a
   * verificação "pelo mesmo runner remoto" prometida não acontecia de
   * verdade: a missão remota reusava, sem nunca checar, o resultado que
   * tinha sido verificado no host LOCAL (ou vice-versa). Produção sempre
   * passa algo que distingue os hosts reais (ex.: 'local' vs `ssh:<host>`);
   * default 'default' cobre quem não passa (testes, chamadas antigas).
   */
  runnerId?: string
}

/** Onde o plugin de segurança do GitOrch fica instalado na imagem (ver
 *  infra/agent-image/Containerfile: `COPY plugin /opt/gitorch-plugin`). */
export const GITORCH_PLUGIN_MARKER_PATH = '/opt/gitorch-plugin/gitorch/hooks.json'

export const GITORCH_PLUGIN_MISSING_MESSAGE =
  `GitOrch: missão recusada — a imagem do agente está sem o gate de segurança do GitOrch ` +
  `(${GITORCH_PLUGIN_MARKER_PATH} não encontrado). Sem o plugin instalado, ` +
  `--dangerously-skip-permissions ficaria sem NENHUMA trava real. Execução negada.`

export const GITORCH_PLUGIN_DISABLED_MESSAGE =
  'GitOrch: missão recusada — GITORCH_AGY_PLUGIN=0 desliga o plugin de segurança do GitOrch ' +
  'dentro do container. Sem o plugin ativo, --dangerously-skip-permissions ficaria sem NENHUMA ' +
  'trava real. Execução negada.'

// Cache por PROCESSO (nunca por missão): chaveado por engine+imagem, guarda a
// Promise da verificação — a primeira missão paga o custo de UM container
// descartável extra; todas as seguintes (mesma imagem) reusam o resultado.
const pluginPresenceCache = new Map<string, Promise<boolean>>()

/** Só para os testes isolarem casos entre si — nunca chamado em produção. */
export function resetGitorchPluginPresenceCache(): void {
  pluginPresenceCache.clear()
}

/**
 * Verifica, com cache por processo, que a imagem dada tem o plugin de
 * segurança do GitOrch instalado. Barata e determinística: sobe a própria
 * imagem com o entrypoint substituído por `sh -c 'test -f <marcador>'` — não
 * roda o entrypoint real (não materializa credencial nenhuma), só checa o
 * arquivo.
 *
 * `runnerId` (achado importante) entra na chave para não colidir stack local
 * com stack remoto quando engine+imagem batem por default — ver o comentário
 * de `runnerId` em CreatePodmanCommandRunnerOptions.
 *
 * Um resultado NEGATIVO nunca é cacheado (achado importante): uma falha
 * transitória do host runner (hiccup de rede, registry fora do ar) não pode
 * virar recusa permanente pro resto da vida do processo — a próxima missão
 * tenta de novo. Só o `true` (plugin confirmado presente) é cacheado, porque
 * esse fato não muda até a imagem trocar.
 */
export async function isGitorchPluginPresentInImage(
  image: string,
  podmanBinary: string,
  hostRunner: RuntimeCommandRunner,
  runnerId = 'default'
): Promise<boolean> {
  const cacheKey = `${runnerId}::${podmanBinary}::${image}`
  const cached = pluginPresenceCache.get(cacheKey)
  if (cached) return cached

  const check = (async () => {
    try {
      const result = await hostRunner({
        binary: podmanBinary,
        args: [
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          image,
          '-c',
          `test -f ${GITORCH_PLUGIN_MARKER_PATH}`,
        ],
        env: {},
      })
      return result.exitCode === 0
    } catch {
      // hostRunner não deveria lançar (realRuntimeCommandRunner e o SSH
      // runner capturam e devolvem exitCode!=0) — mas se lançar mesmo assim,
      // trata como "não confirmado" em vez de propagar, pelo mesmo motivo:
      // não pode virar recusa cacheada para sempre por uma exceção.
      return false
    }
  })()
  pluginPresenceCache.set(cacheKey, check)

  const present = await check
  if (!present) {
    // Não cacheia negativo: libera a chave pra próxima missão tentar de
    // novo, a menos que uma chamada concorrente já tenha posto uma tentativa
    // NOVA no lugar (não apaga o trabalho de outro caller).
    if (pluginPresenceCache.get(cacheKey) === check) {
      pluginPresenceCache.delete(cacheKey)
    }
  }
  return present
}

/**
 * Envolve a execução de um CLI de agente em um container descartável.
 *
 * Isolamento pretendido: o processo do agente enxerga SOMENTE o workspace da
 * missão (montado em /workspace) e as montagens explícitas — nunca o sistema
 * de arquivos do host, o .env do control plane ou credenciais de outros
 * usuários. O ambiente é passado explicitamente; nada do host vaza por padrão.
 */
export function createPodmanCommandRunner(
  options: CreatePodmanCommandRunnerOptions
): RuntimeCommandRunner {
  const podmanBinary = options.podmanBinary ?? 'podman'
  const hostRunner = options.hostRunner ?? realRuntimeCommandRunner

  return async (request: RuntimeCommandRequest): Promise<RuntimeCommandResult> => {
    // Porteiro (decisão do dono, ver comentário da opção): nunca roda missão
    // alguma sem confirmar que o gate de segurança do GitOrch está de pé.
    // Verificado ANTES de qualquer efeito colateral (inclusive prepareMounts,
    // que materializaria credencial à toa se a missão fosse recusada mesmo
    // assim).
    if (options.requireGitorchPlugin) {
      if ((process.env['GITORCH_AGY_PLUGIN'] ?? '1') === '0') {
        return { exitCode: 1, stdout: '', stderr: GITORCH_PLUGIN_DISABLED_MESSAGE, durationMs: 0 }
      }
      const present = await isGitorchPluginPresentInImage(
        options.image,
        podmanBinary,
        hostRunner,
        options.runnerId
      )
      if (!present) {
        return { exitCode: 1, stdout: '', stderr: GITORCH_PLUGIN_MISSING_MESSAGE, durationMs: 0 }
      }
    }

    const userNamespace = options.userNamespace ?? 'keep-id'
    // Nome fixo por execução: permite matar o container se o cliente podman for
    // morto por timeout (senão o agente segue rodando órfão, segurando RAM).
    const containerName = `gitorch-mission-${randomUUID()}`
    const memoryLimit = options.memoryLimit ?? '2g'
    // Default = o próprio memoryLimit: zero swap adicional (ver comentário da
    // opção). Só concede mais folga se o operador configurar explicitamente.
    const memorySwapLimit = options.memorySwapLimit ?? memoryLimit

    const args: string[] = [
      'run',
      '--rm',
      // `-i` mantém o stdin aberto até o container: é assim que o prompt chega ao
      // Antigravity CLI (que lê a missão do stdin). Sem isto o prompt via stdin
      // se perderia na borda do podman.
      ...(request.stdin !== undefined ? ['-i'] : []),
      '--name',
      containerName,
      // Mapeia o usuário do host para o mesmo uid dentro do container: os
      // arquivos criados no workspace continuam legíveis pelo host (rootless).
      ...(userNamespace ? [`--userns=${userNamespace}`] : []),
      '--memory',
      memoryLimit,
      '--memory-swap',
      memorySwapLimit,
      '--pids-limit',
      String(options.pidsLimit ?? 512),
      ...(options.cpus ? ['--cpus', options.cpus] : []),
      // Diretório de runtime gravável para CLIs que abrem sockets locais.
      '--tmpfs',
      '/tmp:rw,exec',
      // HOME gravável e efêmero, FORA do workspace.
      '--tmpfs',
      `${CONTAINER_HOME}:rw,exec`,
      '-e',
      `HOME=${CONTAINER_HOME}`,
      '-e',
      'XDG_RUNTIME_DIR=/tmp',
      '-w',
      CONTAINER_WORKSPACE,
    ]

    if (request.cwd) {
      args.push('-v', `${request.cwd}:${CONTAINER_WORKSPACE}:rw`)
    }

    // cleanup do staging por missão fica fora do try para o finally SEMPRE
    // alcançá-lo, mesmo que prepareMounts falhe depois de alocar.
    let cleanup: (() => Promise<void>) | undefined

    try {
      // Montagens por missão (ex.: credencial do dono materializada agora).
      const perMission = options.prepareMounts ? await options.prepareMounts(request) : undefined
      cleanup = perMission?.cleanup

      for (const mount of [...(options.mounts ?? []), ...(perMission?.mounts ?? [])]) {
        const mode = mount.readOnly === false ? 'rw' : 'ro'
        args.push('-v', `${mount.source}:${mount.target}:${mode}`)
      }

      // Ambiente explícito da missão (identificadores GITORCH_*, modelo etc.).
      for (const [key, value] of Object.entries(request.env)) {
        args.push('-e', `${key}=${value}`)
      }

      // Argumentos que referenciam o caminho do workspace NO HOST (ex.: a flag
      // de diretório do CLI) são traduzidos para o caminho DENTRO do container,
      // cobrindo tanto a forma exata quanto subcaminhos (`${cwd}/x`).
      const translatedArgs = request.cwd
        ? request.args.map((arg) => translateWorkspacePath(arg, request.cwd as string))
        : request.args

      args.push(options.image, request.binary, ...translatedArgs)

      const result = await hostRunner({
        binary: podmanBinary,
        args,
        // O ambiente do processo `podman` no host segue o allowlist padrão;
        // o ambiente DENTRO do container é somente o passado via -e acima.
        env: {},
        timeoutMs: request.timeoutMs,
        // Encaminha o prompt (quando entregue por stdin) para o `podman run -i`,
        // que o repassa ao stdin do processo do agente no container.
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      })

      // Fallback gracioso para hosts sem cgroup cpu (ex.: ARM VM rootless):
      // se a execução falha especificamente porque a flag `--cpus` exigiu o
      // controller `cpu` indisponível no kernel/cgroup v2 rootless do host,
      // re-tenta a missão sem a flag `--cpus` em vez de travar o agente.
      if (
        result.exitCode !== 0 &&
        args.includes('--cpus') &&
        /cgroup.*controller.*cpu|cpu.*controller.*not available/i.test(result.stderr)
      ) {
        const fallbackArgs = args.filter(
          (arg, idx, arr) => arg !== '--cpus' && arr[idx - 1] !== '--cpus'
        )
        return await hostRunner({
          binary: podmanBinary,
          args: fallbackArgs,
          env: {},
          timeoutMs: request.timeoutMs,
          ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        })
      }

      // Timeout (exit 124) mata só o cliente podman no host; o container pode
      // seguir vivo sob o conmon. Removê-lo à força libera RAM e o workspace.
      if (result.exitCode === 124) {
        try {
          await hostRunner({ binary: podmanBinary, args: ['rm', '-f', containerName], env: {} })
        } catch {
          // cleanup best-effort: o container pode já ter saído
        }
      }

      return result
    } finally {
      // Limpa o staging da credencial da missão, aconteça o que acontecer.
      if (cleanup) {
        await cleanup().catch(() => undefined)
      }
    }
  }
}

/**
 * Traduz um caminho do host para o caminho dentro do container quando ele é o
 * workspace da missão ou um subcaminho dele.
 */
function translateWorkspacePath(arg: string, hostCwd: string): string {
  if (arg === hostCwd) return CONTAINER_WORKSPACE
  if (arg.startsWith(`${hostCwd}/`)) {
    return `${CONTAINER_WORKSPACE}${arg.slice(hostCwd.length)}`
  }
  return arg
}
