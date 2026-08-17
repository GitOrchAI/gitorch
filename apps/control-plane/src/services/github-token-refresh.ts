import { CredentialDecryptError } from '../lib/credential-crypto.js'

/**
 * Renovação automática do token do GitHub (F8).
 *
 * O login por GitHub App (com "User-to-server token expiration" ligado)
 * expira o access_token a cada poucas horas e devolve, junto, um
 * refresh_token — a "chave reserva" que troca por um par novo sem o cliente
 * fazer nada. Sem esta rotina a credencial materializada em cada missão
 * (EngineConnectionService.materializeToHome, runtime 'github') morre
 * sozinha algumas horas depois do último login, e todo robô do produto para
 * de conseguir trabalhar no repositório do cliente até ele logar de novo.
 *
 * Tudo aqui é decidido por função PURA (decidirAcaoGithub), testada caso a
 * caso, sem banco nem rede — e só depois ligada ao relógio (scheduler). O
 * desenho é deliberadamente simétrico ao de reconferencia-de-acesso.ts:
 * decisão pura + orquestração injetada por dependência, nunca `Date.now()`
 * ou `fetch` global soltos no meio da lógica.
 *
 * Decifrar o refresh token guardado NÃO acontece neste arquivo. A leitura
 * cifrada (EngineConnection.encryptedRefreshToken) chega até aqui como um
 * valor opaco e segue, sem ser tocada, para dentro da dependência `trocar` —
 * é essa dependência (montada por quem liga isto ao relógio) que decifra
 * (credential-crypto.ts) e chama trocarRefreshTokenNoGithub. Decifrar é um
 * efeito com segredo próprio (a chave de cifragem), do mesmo jeito que
 * `provarEscrita` é quem sabe montar a credencial em reconferencia-de-acesso.ts
 * — a orquestração daqui não precisa, e não deve, saber como. O import de
 * `CredentialDecryptError` abaixo não quebra essa regra: é só o tipo do erro
 * que `trocar` pode lançar, usado para DISTINGUIR causas (ver o catch em
 * `renovarTokensGithubVencendo`), do mesmo jeito que reconferencia-de-acesso.ts
 * importa `CredencialDoGithubInvalidaError`/`AcessoNaoVerificavelError` de
 * acesso-ao-repositorio.ts sem fazer a chamada de rede ela mesma.
 *
 * A ARMADILHA DESTA FASE — por que a ordem trocar → salvarSucesso importa:
 * o GitHub invalida o par antigo (access_token E refresh_token) NO INSTANTE
 * em que aceita a troca — não há como pedir para ele esperar, nem como
 * desfazer. Isso significa que, entre o instante em que `trocar` retorna com
 * sucesso e o instante em que `salvarSucesso` termina de gravar, existe uma
 * janela real onde: o par antigo já morreu no GitHub, e o par novo só existe
 * na memória deste processo. Se o processo cair, ou a gravação falhar, nessa
 * janela, o cliente fica sem nenhum par válido.
 *
 * Não existe ordem que elimine essa janela (ela nasce do lado do GitHub, não
 * do nosso código): gravar ANTES de trocar gravaria um par que ainda nem
 * existe. O que dá para fazer, e é o que este arquivo faz:
 *   1. Encolher a janela ao mínimo possível — `salvarSucesso` é chamado
 *      IMEDIATAMENTE depois de `trocar` resolver, sem nenhum passo a mais
 *      (nenhuma validação extra, nenhuma outra chamada de rede) entre os
 *      dois.
 *   2. Se a gravação falhar mesmo assim, falhar de forma HONESTA: a conexão
 *      é marcada como "precisa reconectar" (mesmo catch que trata a troca
 *      recusada pelo GitHub) em vez de ficar silenciosamente com
 *      status='connected' apontando para uma credencial que o GitHub já
 *      invalidou. O par novo, nesse caso, se perde de verdade — não há como
 *      reobtê-lo sem um login novo —, mas o ESTADO gravado nunca mente sobre
 *      isso.
 *
 * DUAS CAUSAS DIFERENTES ATRÁS DE `trocar`, TRATADAS DIFERENTE: "o GitHub
 * recusou o cartão" (RefreshTokenGithubInvalidoError — o refresh token
 * morreu/foi revogado) e "não consegui LER o que está cifrado no banco"
 * (CredentialDecryptError — a chave de cifra do servidor mudou, ou o dado
 * corrompeu) são operacionalmente opostas: a primeira é problema do
 * CLIENTE (só resolve reconectando no GitHub); a segunda é problema NOSSO
 * (reconectar não resolve nada — o refresh token do cliente continua bom).
 * Confundir as duas faz o produto culpar o cliente por uma falha de
 * infraestrutura nossa. Por isso `renovarTokensGithubVencendo` só chama
 * `marcarPrecisaReconectar` (o "precisa reconectar" citado acima) para a
 * primeira causa; a segunda vira `resumo.falhasDeDecifragem`, sem tocar no
 * status da conexão. Quando a Task 5 compuser `trocar` = decrypt +
 * trocarRefreshTokenNoGithub, ela PRECISA deixar `CredentialDecryptError`
 * atravessar sem reembalar (nunca capturar e relançar como
 * RefreshTokenGithubInvalidoError ou Error genérico) — senão ela cai aqui
 * como se o GitHub tivesse recusado, por engano.
 */

/** Renova com folga: 15 min antes do access_token vencer, nunca em cima da hora. */
export const MARGEM_DE_RENOVACAO_MS = 15 * 60 * 1000

/**
 * O GitHub recusou a troca (refresh_token revogado, vencido, ou resposta
 * incompleta). A mensagem chega EXATAMENTE como o GitHub descreveu o motivo —
 * quem usa esta classe (renovarTokensGithubVencendo) repassa `.message` como
 * o texto que vira "precisa reconectar" para o dono, então nada aqui deve
 * prefixar ou reformular o texto.
 */
export class RefreshTokenGithubInvalidoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenGithubInvalidoError'
  }
}

export interface ResultadoDaTrocaComGithub {
  accessToken: string
  expiresAt: Date
  refreshToken: string
  refreshTokenExpiresAt: Date | null
}

// A única rota desta troca — nunca api.github.com, é o domínio de login que
// emite/renova token, não a API de dados.
const URL_TROCA_GITHUB = 'https://github.com/login/oauth/access_token'
const HOST_TROCA_GITHUB = new URL(URL_TROCA_GITHUB).host

/**
 * A porta única de saída de rede desta troca — mesmo padrão de
 * `pedirUrlSegura` (security-debt-collector.ts): HOST comparado por
 * igualdade EXATA, nunca prefixo/substring ("github.com.alheio" não é
 * "github.com"). O endereço aqui nasce como uma constante deste arquivo, não
 * como input externo — mas a checagem fica na porta de qualquer forma, e não
 * confiando em quem chama: é a mesma garantia estrutural usada em qualquer
 * chamada deste produto que carregue credencial (aqui, client_secret e
 * refresh_token vão no CORPO da chamada), e sobrevive a um refactor futuro
 * que troque essa constante por um valor configurável (ex.: um GitHub
 * Enterprise com domínio próprio) sem esquecer de levar a checagem junto.
 */
function ehHostDeTrocaDoGithub(url: string): boolean {
  try {
    return new URL(url).host === HOST_TROCA_GITHUB
  } catch {
    return false
  }
}

/**
 * Troca um refresh_token por um novo par (access_token, refresh_token) na
 * API do GitHub. `fetchImpl`/`agora` injetados — sem chamada global nem
 * relógio próprio, para o teste rodar sem rede.
 *
 * O GitHub responde erro de troca com HTTP 200 e um campo `error` no corpo
 * (ex.: `bad_refresh_token`) — olhar só o status HTTP deixaria passar essa
 * falha em silêncio. Por isso a validação abaixo é toda pelo CONTEÚDO da
 * resposta, nunca pelo `response.status`.
 */
export async function trocarRefreshTokenNoGithub(deps: {
  refreshToken: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  agora?: Date
}): Promise<ResultadoDaTrocaComGithub> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const agora = deps.agora ?? new Date()

  if (!ehHostDeTrocaDoGithub(URL_TROCA_GITHUB)) {
    // Inalcançável em produção (a URL é a constante acima) — a guarda existe
    // pela mesma razão que existe em endereco-seguro.ts/security-debt-collector.ts:
    // a checagem mora na porta, não em quem chama, então nunca depende de
    // alguém lembrar de repeti-la se este código mudar amanhã.
    throw new RefreshTokenGithubInvalidoError(
      'endereço de troca de token não confere com o host esperado do GitHub'
    )
  }

  const response = await fetchImpl(URL_TROCA_GITHUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: deps.refreshToken,
    }),
  })

  const data = (await response.json()) as {
    access_token?: string
    error?: string
    error_description?: string
    refresh_token?: string
    expires_in?: number
    refresh_token_expires_in?: number
  }

  if (
    data.error ||
    !data.access_token ||
    !data.refresh_token ||
    typeof data.expires_in !== 'number'
  ) {
    throw new RefreshTokenGithubInvalidoError(
      data.error_description || data.error || 'GitHub recusou a renovação do token'
    )
  }

  return {
    accessToken: data.access_token,
    expiresAt: new Date(agora.getTime() + data.expires_in * 1000),
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt:
      typeof data.refresh_token_expires_in === 'number'
        ? new Date(agora.getTime() + data.refresh_token_expires_in * 1000)
        : null,
  }
}

export type AcaoDeRenovacaoGithub =
  { tipo: 'nada' } | { tipo: 'renovar' } | { tipo: 'avisar-legado'; motivo: string }

/** Uma conexão GitHub, do jeito que a renovação precisa dela. */
export interface ConexaoGithubElegivel {
  userId: string
  /** O valor CIFRADO como está guardado (EngineConnection.encryptedRefreshToken).
   *  `null` = conexão anterior a esta fase, nunca guardou refresh token. */
  refreshTokenEncrypted: string | null
  /** Vencimento do access_token atual. */
  expiresAt: Date | null
  /** Vencimento do refresh_token — o GitHub também expira a chave reserva. */
  refreshTokenExpiresAt: Date | null
}

/**
 * O QUE FAZER com uma conexão GitHub, dado o que o banco guarda dela. Pura:
 * mesma entrada, mesma saída, sem banco, sem rede, sem relógio próprio (o
 * `agora` entra por parâmetro).
 */
export function decidirAcaoGithub(
  conexao: Pick<
    ConexaoGithubElegivel,
    'refreshTokenEncrypted' | 'expiresAt' | 'refreshTokenExpiresAt'
  >,
  agora: Date
): AcaoDeRenovacaoGithub {
  if (!conexao.refreshTokenEncrypted) {
    return {
      tipo: 'avisar-legado',
      motivo:
        'esta conexão foi feita antes da renovação automática existir — não guarda refresh token',
    }
  }
  if (conexao.refreshTokenExpiresAt && conexao.refreshTokenExpiresAt.getTime() <= agora.getTime()) {
    return { tipo: 'avisar-legado', motivo: 'o refresh token do GitHub venceu' }
  }
  if (!conexao.expiresAt) return { tipo: 'nada' }
  if (conexao.expiresAt.getTime() - agora.getTime() <= MARGEM_DE_RENOVACAO_MS) {
    return { tipo: 'renovar' }
  }
  return { tipo: 'nada' }
}

export interface DependenciasDaRenovacaoGithub {
  /** As conexões GitHub candidatas (status 'connected'). */
  conexoes: () => Promise<ConexaoGithubElegivel[]>
  /**
   * A troca com o GitHub. Recebe o valor CIFRADO exatamente como
   * `conexoes()` devolveu em `refreshTokenEncrypted` — decifrar (ver
   * decryptCredential, credential-crypto.ts) é responsabilidade de quem
   * implementa esta função, não desta orquestração. Quem liga isto ao
   * relógio compõe: decifrar → trocarRefreshTokenNoGithub.
   *
   * IMPORTANTE PARA QUEM MONTA ISTO (Task 5): se `decryptCredential` lançar
   * `CredentialDecryptError`, deixe o erro atravessar sem capturar/reembalar.
   * `renovarTokensGithubVencendo` trata esse erro DIFERENTE de
   * `RefreshTokenGithubInvalidoError` (ver DUAS CAUSAS DIFERENTES no topo do
   * arquivo) — reembalar os dois no mesmo tipo de erro apaga a distinção e
   * faz um problema nosso (chave/dado) virar um "reconecte sua conta" para
   * o cliente, que não resolve nada.
   */
  trocar: (refreshTokenArmazenado: string) => Promise<ResultadoDaTrocaComGithub>
  /** Persiste o novo par — o chamador reusa connectGitHubToken. Chamado
   *  IMEDIATAMENTE após `trocar` resolver (ver a nota no topo do arquivo
   *  sobre a janela entre os dois). */
  salvarSucesso: (userId: string, resultado: ResultadoDaTrocaComGithub) => Promise<void>
  /** Marca a conexão como precisando de login novo e avisa o dono. */
  marcarPrecisaReconectar: (userId: string, motivo: string) => Promise<void>
  agora?: Date
  onWarn?: (mensagem: string) => void
}

export interface ResumoDaRenovacaoGithub {
  renovados: number
  /** GitHub recusou a troca (ou a gravação falhou depois de aceita) —
   *  problema do CLIENTE, só resolve reconectando. */
  precisamReconectar: number
  /** Não foi possível DECIFRAR o refresh token guardado (chave do servidor
   *  trocada ou dado corrompido) — problema NOSSO; reconectar no GitHub não
   *  resolve, então essas conexões NUNCA entram em `precisamReconectar`. */
  falhasDeDecifragem: number
}

/**
 * Roda a renovação de todas as conexões GitHub que precisam, sequencial
 * (poucas por tique; uma rajada contra o GitHub voltaria como limite
 * secundário, que puniria o cliente por um excesso nosso). Nunca lança: uma
 * falha numa conexão não pode impedir as demais nem derrubar o relógio
 * (setInterval — promessa rejeitada ali derruba o processo).
 */
export async function renovarTokensGithubVencendo(
  deps: DependenciasDaRenovacaoGithub
): Promise<ResumoDaRenovacaoGithub> {
  const agora = deps.agora ?? new Date()
  const resumo: ResumoDaRenovacaoGithub = {
    renovados: 0,
    precisamReconectar: 0,
    falhasDeDecifragem: 0,
  }

  let conexoes: ConexaoGithubElegivel[]
  try {
    conexoes = await deps.conexoes()
  } catch (err) {
    deps.onWarn?.(`não foi possível listar conexões GitHub: ${textoDoErro(err)}`)
    return resumo
  }

  for (const conexao of conexoes) {
    const acao = decidirAcaoGithub(conexao, agora)
    if (acao.tipo === 'nada') continue

    if (acao.tipo === 'avisar-legado') {
      resumo.precisamReconectar += 1
      await marcarComAviso(deps, conexao.userId, acao.motivo)
      continue
    }

    // acao.tipo === 'renovar'. decidirAcaoGithub já garante refreshTokenEncrypted
    // não-nulo para chegar aqui (o caso nulo cai em 'avisar-legado' acima) — o
    // guard abaixo é defensivo: se um dia as duas funções divergirem, cai no
    // mesmo caminho de reconexão, nunca num throw não tratado.
    if (!conexao.refreshTokenEncrypted) {
      resumo.precisamReconectar += 1
      await marcarComAviso(deps, conexao.userId, 'refresh token ausente no momento da renovação')
      continue
    }

    // O par ANTIGO morre no GitHub no instante em que `trocar` aceita a
    // troca — não há como desfazer isso. `salvarSucesso` roda logo em
    // seguida, sem nenhum passo entre os dois, para a janela em que o par
    // novo existe só em memória ser a menor possível (ver nota no topo do
    // arquivo). Se QUALQUER um dos dois falhar — GitHub recusou, ou a
    // gravação falhou depois de um GitHub aceitar — o resultado observável
    // para o cliente é o mesmo: não há mais garantia de uma credencial boa
    // persistida, e a conexão precisa ser marcada como tal, honestamente, em
    // vez de continuar 'connected' apontando para o que já morreu.
    try {
      const resultado = await deps.trocar(conexao.refreshTokenEncrypted)
      await deps.salvarSucesso(conexao.userId, resultado)
      resumo.renovados += 1
    } catch (err) {
      // CredentialDecryptError é a exceção à regra "qualquer falha aqui vira
      // precisa-reconectar": significa que não conseguimos LER o refresh
      // token cifrado (chave do servidor mudou ou o dado corrompeu) — o
      // refresh token do cliente no GitHub continua bom, só não conseguimos
      // decifrar o que está guardado. Reconectar não resolve nada nesse
      // caso, então NUNCA chama marcarPrecisaReconectar aqui (ver DUAS
      // CAUSAS DIFERENTES no topo do arquivo); fica só como alerta
      // operacional, contado à parte.
      if (err instanceof CredentialDecryptError) {
        resumo.falhasDeDecifragem += 1
        deps.onWarn?.(
          `renovação do token GitHub falhou para ${conexao.userId} por falha de DECIFRAGEM ` +
            `(problema nosso, reconectar não ajuda): ${textoDoErro(err)}`
        )
        continue
      }
      resumo.precisamReconectar += 1
      deps.onWarn?.(`renovação do token GitHub falhou para ${conexao.userId}: ${textoDoErro(err)}`)
      await marcarComAviso(deps, conexao.userId, textoDoErro(err))
    }
  }

  return resumo
}

/** `marcarPrecisaReconectar` nunca pode, ao falhar, derrubar o ciclo inteiro —
 *  vira só um aviso a mais, do mesmo jeito que qualquer outra falha aqui. */
async function marcarComAviso(
  deps: DependenciasDaRenovacaoGithub,
  userId: string,
  motivo: string
): Promise<void> {
  await deps.marcarPrecisaReconectar(userId, motivo).catch((err: unknown) => {
    deps.onWarn?.(`falha ao marcar reconexão de ${userId}: ${textoDoErro(err)}`)
  })
}

function textoDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
