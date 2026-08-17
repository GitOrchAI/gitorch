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
 *
 * (Revisão da Task 5) NA VERDADE SÃO TRÊS CAUSAS, NÃO DUAS: além das duas
 * acima, existe FalhaTransitoriaNaTrocaComGithubError ("nem cheguei a
 * perguntar pro GitHub" — rede caiu ou resposta não era JSON). Mesma
 * postura da segunda causa (problema nosso/transitório, nunca
 * marcarPrecisaReconectar), só que contada à parte (`resumo.falhasTransitorias`)
 * por ser um motivo operacional diferente. E uma CONEXÃO LEGADA (sem
 * refresh token guardado) só é tratada como "precisa reconectar" quando o
 * access_token dela JÁ venceu — enquanto ainda funciona, cai em
 * `legado-token-valido` (decidirAcaoGithub) e NUNCA muda o status: a coluna
 * de refresh token é nova, e no primeiro tique após o deploy desta fase
 * toda conexão existente ainda não tem refresh token guardado — tratar
 * "sem refresh token" como "precisa reconectar" sem olhar o prazo cortaria
 * o acesso de toda a base no deploy.
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

/**
 * A chamada não chegou a produzir uma resposta AVALIÁVEL do GitHub — a rede
 * caiu antes de qualquer resposta chegar (fetchImpl rejeitou), ou a
 * resposta chegou mas não é o JSON esperado (ex.: uma página de erro HTML
 * de um balanceador durante uma instabilidade do GitHub). Diferente de
 * RefreshTokenGithubInvalidoError, que só é lançado depois de LER um corpo
 * JSON válido e ver, no conteúdo, que o GitHub recusou o cartão — aqui o
 * GitHub nunca chegou a "opinar" sobre o refresh token.
 *
 * Tratada como TRANSITÓRIA por quem chama (renovarTokensGithubVencendo,
 * achado Alto 3 da Task 5/F8): nunca marca a conexão como "precisa
 * reconectar" (o refresh token do cliente pode continuar perfeitamente
 * bom), só conta à parte e tenta de novo no próximo tique — a mesma
 * postura que este arquivo já toma para CredentialDecryptError (ver a nota
 * "DUAS CAUSAS DIFERENTES" no topo do arquivo; esta é uma terceira).
 */
export class FalhaTransitoriaNaTrocaComGithubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FalhaTransitoriaNaTrocaComGithubError'
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

  // Rede caiu antes de qualquer resposta chegar (achado Alto 3): a exceção
  // aqui não vem do GitHub, vem do transporte — não é "o cartão foi
  // recusado", é "nem cheguei a perguntar". Reembalada em
  // FalhaTransitoriaNaTrocaComGithubError para quem chama (
  // renovarTokensGithubVencendo) NUNCA confundir com recusa do cliente.
  let response: Response
  try {
    response = await fetchImpl(URL_TROCA_GITHUB, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: deps.refreshToken,
      }),
    })
  } catch (err) {
    throw new FalhaTransitoriaNaTrocaComGithubError(
      `não foi possível alcançar o GitHub para renovar o token: ${textoDoErro(err)}`
    )
  }

  // Resposta chegou, mas não é o JSON esperado (achado Alto 3) — ex.: uma
  // página de erro HTML de um balanceador numa instabilidade do GitHub.
  // Mesma classificação da rede caindo: não é o GitHub OPINANDO sobre o
  // refresh token, é a chamada não tendo produzido nada avaliável.
  let data: {
    access_token?: string
    error?: string
    error_description?: string
    refresh_token?: string
    expires_in?: number
    refresh_token_expires_in?: number
  }
  try {
    data = (await response.json()) as typeof data
  } catch (err) {
    throw new FalhaTransitoriaNaTrocaComGithubError(
      `resposta do GitHub não é JSON válido (provável instabilidade transitória): ${textoDoErro(err)}`
    )
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
  | { tipo: 'nada' }
  | { tipo: 'renovar' }
  | { tipo: 'avisar-legado'; motivo: string }
  | { tipo: 'legado-token-valido'; motivo: string }

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
    // CONEXÃO LEGADA (achado Crítico 1, Task 5/F8): esta coluna é NOVA — no
    // primeiro tique depois do deploy desta fase, TODA conexão existente
    // cai aqui, porque nenhuma delas guardou refresh token ainda (ele só
    // passou a ser capturado a partir desta fase). "Sem refresh token" NÃO
    // é o mesmo que "token morto": o access_token que o cliente já tem pode
    // muito bem continuar bom por horas. Só o GitHub sabendo COM CERTEZA
    // que o cartão morreu (aqui: o próprio access_token já vencido, já que
    // não há refresh token pra checar) justifica marcar a conexão como
    // "precisa reconectar" — que é DESTRUTIVO (materializeToHome e
    // getRawGithubToken, engine-connection.ts, recusam qualquer conexão que
    // não esteja 'connected'). A checagem de prazo entra AQUI, e não antes:
    // é a única informação que resta para avaliar uma conexão sem refresh
    // token — o `expiresAt` do access_token atual.
    if (conexao.expiresAt && conexao.expiresAt.getTime() <= agora.getTime()) {
      return {
        tipo: 'avisar-legado',
        motivo:
          'esta conexão foi feita antes da renovação automática existir, e o token de acesso já venceu — não há refresh token para renovar sozinho',
      }
    }
    // expiresAt no futuro, OU desconhecido (null) e nada indica falha: o
    // cliente continua 'connected' e trabalhando normalmente — o aviso
    // sobre reconectar para ganhar renovação automática é informativo, não
    // muda o status (ver o tratamento deste tipo em renovarTokensGithubVencendo).
    return {
      tipo: 'legado-token-valido',
      motivo:
        'conexão anterior à renovação automática — o token de acesso atual ainda funciona, mas ninguém vai renová-lo sozinho quando vencer; reconectar no GitHub liga a renovação automática',
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
  /** Teto de conexões processadas nesta passada (achado Médio 5, Task 5/F8)
   *  — default TETO_DE_RENOVACOES_POR_TIQUE. Existe só para o teste
   *  exercitar um teto pequeno sem montar centenas de conexões falsas. */
  tetoPorTique?: number
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
  /** A troca não chegou a produzir resposta avaliável do GitHub — rede
   *  caiu, ou o corpo não era JSON (achado Alto 3). TRANSITÓRIO: a próxima
   *  tentativa (tique seguinte) pode simplesmente funcionar, então também
   *  NUNCA entra em `precisamReconectar`. */
  falhasTransitorias: number
  /** Conexão LEGADA (sem refresh token guardado, coluna anterior a esta
   *  fase) cujo token de acesso atual ainda funciona (achado Crítico 1):
   *  nenhuma ação foi tomada, o status continua 'connected'. Só existe para
   *  o dono medir quantos clientes ainda não reconectaram para ganhar
   *  renovação automática — não é uma falha. */
  legadosSemAcao: number
}

/** Teto de conexões processadas por PASSADA (achado Médio 5, Task 5/F8): a
 *  busca de conexões não tinha limite, e a renovação é sequencial — uma
 *  chamada de rede ao GitHub por conexão —, tudo sob a trava de tique único
 *  do relógio (scheduler.ts, `tickEmAndamento`). Uma leva de expirações
 *  concentradas (ex.: todos os clientes logaram no mesmo lançamento e os
 *  tokens vencem juntos) serializaria N chamadas de rede num único tique,
 *  atrasando toda outra rotina que compartilha esse mesmo ciclo (varredura
 *  de sessões, delegação, etc.).
 *
 *  O que sobra do teto fica para o PRÓXIMO tique — mas "sem se perder, só
 *  atrasa" só é verdade DESDE a correção do achado Alto 1 (revisão da Task
 *  5/F8): `deps.conexoes()` embrulha uma consulta SQL sem `ORDER BY`, cuja
 *  ordem não é garantida estável entre chamadas. Cortar por posição
 *  (`.slice(0, teto)`) direto em cima disso faz o corte pegar sempre o MESMO
 *  prefixo posicional — com mais conexões que o teto, tudo depois da
 *  posição N nunca era avaliado, nem para renovar nem para avisar que o
 *  token morreu de vez. A garantia de que ninguém fica pra trás para sempre
 *  não vem de `ORDER BY` nenhum (a consulta continua sem um, de propósito:
 *  ordenar no banco não impediria um corte posicional fixo de repetir o
 *  mesmo prefixo a cada tique) — vem de ORDENAR AQUI, por URGÊNCIA
 *  (`expiresAt` crescente — ver `renovarTokensGithubVencendo`), ANTES de
 *  cortar. Isso rotaciona sozinho: quem é renovado ganha um `expiresAt` novo
 *  horas no futuro e cai pro fim da fila no tique seguinte, abrindo espaço
 *  pra quem ficou de fora agora; quem NÃO foi avaliado mantém o `expiresAt`
 *  antigo, então sobe na fila (fica mais urgente) a cada tique que passa,
 *  até caber dentro do teto. */
export const TETO_DE_RENOVACOES_POR_TIQUE = 25

/** Tempo (em ms) de uma conexão sem `expiresAt` — não há como saber a
 *  urgência dela, então ordena por último (não compete por vaga no teto
 *  contra quem tem prazo conhecido). Usado só pela ordenação por urgência
 *  logo abaixo, nunca por `decidirAcaoGithub` (que já trata `expiresAt` nulo
 *  do jeito certo por tipo de conexão). */
const SEM_URGENCIA_CONHECIDA = Number.POSITIVE_INFINITY

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
  const teto = deps.tetoPorTique ?? TETO_DE_RENOVACOES_POR_TIQUE
  const resumo: ResumoDaRenovacaoGithub = {
    renovados: 0,
    precisamReconectar: 0,
    falhasDeDecifragem: 0,
    falhasTransitorias: 0,
    legadosSemAcao: 0,
  }

  let conexoes: ConexaoGithubElegivel[]
  try {
    conexoes = await deps.conexoes()
  } catch (err) {
    deps.onWarn?.(`não foi possível listar conexões GitHub: ${textoDoErro(err)}`)
    return resumo
  }

  // Ordena por URGÊNCIA (expiresAt crescente; sem expiresAt vai pro fim)
  // ANTES de cortar pelo teto — achado Alto 1 (revisão da Task 5/F8). Ver o
  // comentário de TETO_DE_RENOVACOES_POR_TIQUE para o porquê: é esta
  // ordenação, e não a consulta SQL, que garante que ninguém fica de fora
  // para sempre — só atrasado até a urgência dele subir o bastante para
  // caber no teto de uma passada futura.
  const porUrgencia = [...conexoes].sort((a, b) => {
    const tempoA = a.expiresAt?.getTime() ?? SEM_URGENCIA_CONHECIDA
    const tempoB = b.expiresAt?.getTime() ?? SEM_URGENCIA_CONHECIDA
    return tempoA - tempoB
  })

  for (const conexao of porUrgencia.slice(0, teto)) {
    const acao = decidirAcaoGithub(conexao, agora)
    if (acao.tipo === 'nada') continue

    if (acao.tipo === 'legado-token-valido') {
      // Achado Crítico 1: NUNCA chama marcarPrecisaReconectar aqui — isso
      // mudaria o status para 'needs_reconnect' e derrubaria uma conexão
      // que ainda funciona (materializeToHome/getRawGithubToken recusam
      // qualquer status que não seja 'connected'). O aviso é só
      // operacional/informativo, contado à parte, sem tocar no banco.
      //
      // Achado Baixo 5 (revisão da Task 5/F8): ANTES desta correção, esta
      // linha chamava `deps.onWarn?.(...)` para CADA conexão legada, A CADA
      // TIQUE — no primeiro tique após o deploy, toda a base cai aqui, e
      // continua caindo até cada cliente reconectar (dias/semanas).
      // Isso é log por CONEXÃO, sem dedupe, indefinidamente: pura poluição.
      // `resumo.legadosSemAcao` já carrega essa contagem — quem liga isto ao
      // relógio (scheduler.ts, `renovarTokensGithubDoRelogio`) é quem
      // registra UMA linha por PASSADA a partir do resumo devolvido, não
      // esta função por conexão.
      resumo.legadosSemAcao += 1
      continue
    }

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
      // Achado Alto 3: mesma lógica de CredentialDecryptError acima — uma
      // instabilidade de rede/resposta não é o GitHub recusando o cartão do
      // CLIENTE, é a chamada não tendo completado. Marcar como
      // precisa-reconectar aqui dispararia avisos falsos em massa numa
      // instabilidade transitória do GitHub. NUNCA chama marcarPrecisaReconectar;
      // tenta de novo no próximo tique.
      if (err instanceof FalhaTransitoriaNaTrocaComGithubError) {
        resumo.falhasTransitorias += 1
        deps.onWarn?.(
          `renovação do token GitHub falhou para ${conexao.userId} por instabilidade TRANSITÓRIA ` +
            `(tenta de novo no próximo tique, não é culpa do cliente): ${textoDoErro(err)}`
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
