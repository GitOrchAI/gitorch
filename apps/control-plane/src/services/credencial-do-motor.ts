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
// aqui não dá pra evitar, então os sinais ficam POUCOS, EXPLÍCITOS e
// NOMEADOS nesta constante exportada, para o texto ficar auditável num único
// lugar. Uma vez reconhecido, o resto do sistema volta a tratar por TIPO
// (CredencialExpiradaError), não por regex de novo — ver isEngineFault.
//
// O que passa batido, de propósito (a lista é curta e o preço disso é
// aceito): qualquer mensagem de expiração que não contenha LITERALMENTE um
// destes textos — ex. uma versão nova do CLI que troque a frase por outra
// ("your session has ended"), um provider diferente que fale "token expired"
// sem "log out"/"401"/"invalid_grant"/"authentication required", ou a mesma
// frase em outro idioma. Ampliar a lista é seguro (não precisa manter
// paridade com nenhum outro código); adivinhar padrões novos sem ver o texto
// real de um motor de verdade não é.
export const SINAIS_DE_CREDENCIAL_EXPIRADA: readonly string[] = [
  'could not be refreshed',
  'log out and sign in',
  '401 unauthorized',
  'invalid_grant',
  'authentication required',
]

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
 */
export function ehCredencialExpirada(saida: SaidaDoMotor): boolean {
  const texto = `${saida.stdout}\n${saida.stderr}`.toLowerCase()
  return SINAIS_DE_CREDENCIAL_EXPIRADA.some((sinal) => texto.includes(sinal))
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
 */
export function deveAvisarDeNovo(
  ultimoAviso: ReadonlyMap<string, number>,
  chave: string,
  agora: number
): boolean {
  const ultimo = ultimoAviso.get(chave)
  return ultimo === undefined || agora - ultimo >= UM_DIA_MS
}
