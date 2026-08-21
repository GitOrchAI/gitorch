import type { MissionDeliveryCheck } from './mission-outcome.js'

// Credencial de motor expirada vira aviso, não silêncio.
//
// Bug real de produção (chain=codex>antigravity, falhando todo dia): o motor
// `codex` responde "Your access token could not be refreshed. Please log out
// and sign in again." e sai com código 0 — sucesso, para quem só olha o
// exitCode. `isEngineFault` (scheduler.ts) e `RailsExecutionError`
// (rails-runner.ts) resolveram a falha de PROCESSO (exitCode != 0); esta é a
// falha que nem isso pega, porque o processo termina "bem". O motor reserva
// já assumia por outro caminho (a saída sem JSON esgotava as tentativas de
// reparo e virava RailsStepError) — mas o dono nunca ficava sabendo POR QUÊ,
// e só ele pode resolver, refazendo o login.
//
// Reconhecimento por TEXTO é inevitável aqui — não por preguiça, mas porque
// não há outro sinal: o motor devolve sucesso, então não há tipo nem exitCode
// confiável para diferenciar isto de uma resposta normal. É exatamente o caso
// que `RailsExecutionError` (rails-runner.ts) evitou resolver por regex —
// aqui não dá pra evitar. Uma vez reconhecido, o resto do sistema volta a
// tratar por TIPO (CredencialExpiradaError), não por regex de novo — ver
// isEngineFault.
//
// Achado crítico da revisão: a primeira versão casava os sinais contra a
// saída CRUA INTEIRA do motor — e este produto existe para limpar
// repositórios bagunçados, então uma missão tocando código de autenticação é
// trabalho ORDINÁRIO, não uma exceção. Medido ao vivo contra 4 saídas comuns
// (não inventadas): um trace de curl mostrando "401 Unauthorized", um
// comentário de code review sobre um middleware de auth ("retorna 401
// Unauthorized... Authentication required"), uma mensagem de commit sobre uma
// feature de logout ("log out and sign in again"), e um erro de API de
// terceiro aparecendo no stdout ("Bad credentials (401 Unauthorized)") — as
// QUATRO disparavam o aviso falsamente. Um aviso falso de "sua credencial
// expirou" ensina o dono a ignorar o alarme, o que é PIOR que o silêncio que
// esta tarefa existe para fechar.
//
// A correção: dois níveis de confiança, não uma lista plana.
//
// SINAIS_FORTES — frases praticamente exclusivas do banner real de
// expiração, nunca vistas nos 4 falsos-positivos medidos: "access token
// could not be refreshed" (o texto verbatim do banner do codex, provado em
// produção — mais específico que só "could not be refreshed", que colidiria
// com qualquer "o dashboard não pôde ser atualizado") e "invalid_grant" (o
// código de erro OAuth por extenso, RFC 6749 — não é vocabulário comum de
// texto corrido). Sozinhas bastam, mesmo dentro de uma saída grande.
//
// SINAIS_FRACOS — vocabulário genérico de HTTP/auth que aparece o tempo
// inteiro em texto ORDINÁRIO sobre autenticação (é exatamente o que os 4
// falsos-positivos têm em comum: "401 unauthorized", "authentication
// required", "log out and sign in"). Sozinhos, só contam quando a saída
// INTEIRA é curta e terse (ver LIMITE_SAIDA_TERSE_CHARS abaixo) — a forma
// real do banner: o processo morre ANTES de produzir qualquer trabalho,
// então a saída inteira É o aviso, não um parágrafo de análise com um HTTP
// 401 no meio. Uma missão de verdade (revisão de código, trace de debug,
// leitura de commit) produz saída substancialmente mais longa porque ela
// FEZ trabalho de verdade antes/depois de mencionar autenticação.
//
// O que passa batido, de propósito (documentado em detalhe no relatório da
// revisão): uma versão nova do CLI que troque a frase por outra ("your
// session has ended"), um provider diferente que fale "token expired" sem
// nenhum dos sinais fortes/fracos, a mesma frase em outro idioma, um "403
// Forbidden" sem a palavra "401"/"unauthorized", ou um sinal fraco genuíno
// que por acaso apareça isolado (raro, mas possível — o preço aceito de não
// termos banner real de todo motor/versão para calibrar melhor).
//
// Achado crítico da SEGUNDA revisão: o limiar de terseness estreitou a
// janela do achado 1, mas não a fechou — porque SINAIS_FORTES ignora
// terseness DE PROPÓSITO (é o ponto deles: bastar sozinhos). Um revisor
// mediu TRÊS falsos-positivos novos, todos usando sinal forte fora do
// limiar: uma missão de documentação citando a especificação OAuth (que
// MENCIONA `invalid_grant` por ser parte do RFC 6749, 761 caracteres), uma
// análise de stack trace com o texto literal `OAuthError: invalid_grant`
// (637 caracteres), e um `401 Unauthorized` genuinamente curto (122
// caracteres) mas LEGÍTIMO — a API do próprio cliente respondendo 401
// dentro do trabalho da missão, não o motor pedindo login. Nenhum limiar de
// tamanho fecha isso: o terceiro caso já É curto.
//
// A corroboração certa (ver `ehFalhaDeCredencialCorroborada` abaixo): uma
// credencial expirada tem uma FORMA muito específica — o motor morre ANTES
// de produzir qualquer trabalho. Se a missão ENTREGOU o entregável do seu
// papel (contrato já existente, `resolveMissionDelivery` em
// mission-outcome.ts, commit 87806ea), então o motor claramente FUNCIONOU o
// bastante para produzir o resultado — não importa o que o texto mencione
// de passagem sobre autenticação. Corroboração é NECESSÁRIA (sem ela, sinal
// nenhum dispara o aviso) mas não SUFICIENTE (ainda precisa do sinal
// textual, nos mesmos dois níveis de confiança acima) — as duas defesas se
// somam, não se substituem.
// Achado da TERCEIRA revisão, medido em produção (20/08/2026): o banner do
// antigravity/Google NÃO tinha nenhum sinal forte e caía no caminho fraco —
// onde o gate de terseness o descartava. As 13 missões que pararam a esteira
// entre 17/08 e 20/08 traziam `authentication required` (fraco) numa saída de
// 946 a 1068 caracteres. O que estoura o limite não é ruído removível: é a
// própria URL de OAuth do Google (client_id + code_challenge + scopes +
// state, sozinha acima de 350 chars) somada ao stack trace que o Node anexa
// ao RailsExecutionError. Os dois banners que calibraram LIMITE_SAIDA_TERSE_
// CHARS eram do codex (63 e 134 chars) e não carregam nem URL nem stack —
// por isso nenhum limiar de tamanho alcança este caso, e mexer no limiar
// reabriria os falsos-positivos que as revisões anteriores fecharam.
//
// `please visit the url to log in` é a frase com que um CLI manda o humano
// até uma página de autorização. Não é vocabulário de missão: análise de
// código, review de autenticação e trace de curl falam SOBRE autenticação,
// não mandam ninguém visitar uma URL para entrar. Como todo sinal forte,
// dispensa terseness — e segue coberto pela corroboração de entregável em
// `ehFalhaDeCredencialCorroborada`, que é o critério de produção.
const SINAIS_FORTES: readonly string[] = [
  'access token could not be refreshed',
  'invalid_grant',
  'please visit the url to log in',
]

const SINAIS_FRACOS: readonly string[] = [
  'log out and sign in',
  '401 unauthorized',
  'authentication required',
]

/** Mantido por compatibilidade/auditoria (quem quiser ver TODOS os textos
 *  reconhecidos num único lugar, sem se importar com o nível de confiança). */
export const SINAIS_DE_CREDENCIAL_EXPIRADA: readonly string[] = [...SINAIS_FORTES, ...SINAIS_FRACOS]

// Os dois banners REAIS provados em produção (Step 1 do brief) têm 63 e 134
// caracteres; a saída CURTA típica de um processo que morreu antes de
// trabalhar. Os 3 falsos-positivos medidos que dependem de sinal fraco (curl
// trace, review de auth, commit de logout) são narrativa de missão de
// verdade — nas amostras medidas, sempre bem acima de meia-mil caracteres.
// A margem entre as duas classes é grande; 200 fica confortavelmente acima
// dos banners reais e abaixo de qualquer saída de missão que tenha feito
// trabalho de verdade antes/depois de mencionar autenticação.
const LIMITE_SAIDA_TERSE_CHARS = 200

/**
 * Saída de UMA execução de motor (crua, antes de qualquer parsing de JSON ou
 * checagem de entregável) — o mesmo formato de `RuntimeExecutionResult`
 * (runtime-adapter.ts), só que aqui `stdout` é o nome do campo (lá é
 * `output`); quem chama faz a ponte no call site.
 */
export interface SaidaDoMotor {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Verdadeiramente ignora `exitCode` de propósito: o ponto inteiro deste
 * defeito é que o motor MENTE sucesso (sai 0) quando a credencial está
 * expirada — confiar no código de saída, mesmo como desempate, reintroduziria
 * a mesma cegueira que esta função existe para fechar.
 *
 * Sinal forte → basta ele sozinho, em qualquer tamanho de saída. Sinal fraco
 * → só conta quando a saída inteira é curta (LIMITE_SAIDA_TERSE_CHARS): é o
 * filtro de TAMANHO que reduz o vocabulário genérico de HTTP/auth disparando
 * em cima de trabalho ordinário (ver o comentário longo acima do módulo para
 * a medição real que motivou isto).
 *
 * Este filtro sozinho NÃO é suficiente — nem para sinal fraco curto, nem
 * (principalmente) para sinal forte, que ignora tamanho de propósito. Quem
 * decide se o aviso realmente dispara é `ehFalhaDeCredencialCorroborada`
 * abaixo, que soma este sinal textual à corroboração de entregável. Esta
 * função (`ehCredencialExpirada`) continua exportada sozinha só porque os
 * testes do Step 1 do brief e a suíte de falsos-positivos da primeira
 * revisão a testam diretamente — não é mais, por si só, o critério final de
 * produção.
 */
export function ehCredencialExpirada(saida: SaidaDoMotor): boolean {
  const textoOriginal = `${saida.stdout}\n${saida.stderr}`
  const texto = textoOriginal.toLowerCase()

  if (SINAIS_FORTES.some((sinal) => texto.includes(sinal))) return true

  const temSinalFraco = SINAIS_FRACOS.some((sinal) => texto.includes(sinal))
  if (!temSinalFraco) return false

  return textoOriginal.trim().length <= LIMITE_SAIDA_TERSE_CHARS
}

/**
 * Critério de produção: um sinal textual (`ehCredencialExpirada`) NUNCA
 * basta sozinho — precisa, ALÉM disso, que a missão não tenha entregado o
 * entregável do seu papel. É a corroboração que fecha os 3 falsos-positivos
 * da segunda revisão (documentação citando `invalid_grant` do RFC, análise
 * de stack trace com o mesmo texto, um 401 curto mas legítimo da API do
 * cliente): nos três casos a missão ENTREGOU de verdade, então o motor
 * funcionou — não importa o que o texto mencione de passagem.
 *
 * `entrega` é o resultado JÁ CALCULADO do contrato de entregável por papel
 * (`resolveMissionDelivery`, mission-outcome.ts, commit 87806ea) para a
 * MESMA saída que `saida` representa — este módulo não recalcula nem
 * reimplementa esse contrato (não é uma segunda noção de "não produziu
 * nada"), só compõe o resultado dele com o sinal textual. Quem chama decide
 * QUAL contrato passar (`pathKind`); este módulo não sabe nem precisa saber
 * a diferença entre caminho clássico e trilhos.
 *
 * Necessária, não suficiente: `entrega.delivered === false` sozinho não
 * dispara nada (a maioria das falhas sem entregável não tem nada a ver com
 * credencial) — ainda precisa do sinal textual, nos mesmos dois níveis de
 * confiança de `ehCredencialExpirada`.
 */
export function ehFalhaDeCredencialCorroborada(
  saida: SaidaDoMotor,
  entrega: MissionDeliveryCheck
): boolean {
  if (entrega.delivered) return false
  return ehCredencialExpirada(saida)
}

/**
 * Erro TIPADO para propagar "credencial expirada" pela MESMA cadeia de
 * classificação de falha de motor que `RailsStepError`/`RailsExecutionError`
 * já usam (ver `isEngineFault` em scheduler.ts). O reconhecimento por texto
 * acontece UMA vez, na fonte (onde a saída crua do motor ainda existe); daqui
 * pra frente o resto do sistema (failover, log, aviso ao dono) trata por
 * TIPO — na mesma linha da Lei dos trilhos, e do motivo de
 * `RailsExecutionError` existir.
 */
export class CredencialExpiradaError extends Error {
  constructor(
    message: string,
    public readonly runtime: string
  ) {
    super(message)
    this.name = 'CredencialExpiradaError'
  }
}

const UM_DIA_MS = 24 * 60 * 60 * 1000

/**
 * "Uma vez por motor por dia" — mesma disciplina de session-watch.ts
 * (`hashDaMensagem`/`registrarInvestigacao`, comentário "SPAM apaga sinal
 * tanto quanto silêncio"), adaptada a uma chave que não é uma sessão. Aqui a
 * chave é dono+motor (não há linha de banco por-sessão para prender o aviso
 * de credencial: uma credencial vale para TODOS os projetos daquele dono
 * naquele motor, e sem esta dedup por dono um cliente com 5 projetos usando
 * o mesmo `codex` expirado receberia 5 avisos idênticos no mesmo tick).
 *
 * Dedup EM MEMÓRIA do processo, não em coluna nova no banco (decisão
 * deliberada — ver relatório da tarefa para o porquê): o pior caso é um
 * aviso extra logo depois de um restart do control-plane, nunca silêncio
 * indo além de 24h dentro do mesmo processo.
 *
 * Limitação honesta (finding 3 da revisão, não resolvida de propósito): o
 * `Map` que o chamador passa aqui é POR PROCESSO. Com N processos do
 * control-plane vivos ao mesmo tempo (não é o deployment de hoje — uma VM,
 * um processo — mas passaria a ser um problema real se algum dia escalar
 * horizontalmente), cada um decide "ainda não avisei hoje" sem saber dos
 * outros, e o dono poderia receber até N avisos idênticos no mesmo dia em
 * vez de um só. Resolver isso de verdade pede estado COMPARTILHADO entre
 * processos (banco), fora do escopo desta tarefa — não é uma coluna nova
 * adicionada aqui.
 */
export function deveAvisarDeNovo(
  ultimoAviso: ReadonlyMap<string, number>,
  chave: string,
  agora: number
): boolean {
  const ultimo = ultimoAviso.get(chave)
  return ultimo === undefined || agora - ultimo >= UM_DIA_MS
}
