// O vocabulário e a pele dos controles de conexão de motor.
//
// Os controles são os MESMOS no assistente e no painel (ControlesDeConexao);
// o que muda entre as duas telas é só o texto e o nome das classes. Separar
// isso aqui é o que permite haver UM fluxo e UM conjunto de controles sem que
// o painel fale inglês nem o assistente vista a roupa do painel.
import { connectErrorHintKey, type ConnectErrorKind } from './engine-status'

/** As frases dos controles. Quem chama decide de onde elas vêm. */
export interface TextosDeConexao {
  /** O botão que COMEÇA o login. Promete o que entrega. */
  conectar: string
  /** O mesmo login, para um motor que já esteve conectado e venceu. */
  religar: string
  precisaReligarTitulo: string
  precisaReligarDesc: string
  conectando: string
  verificando: string
  abrirLink: string
  placeholderCodigo: string
  enviarCodigo: string
  aguardandoAprovacao: string
  /** A dica ACIONÁVEL por tipo de falha — nunca só "tente de novo". */
  dicaDeErro: (tipo: ConnectErrorKind) => string
  /** O que foi colado no campo de token tem cara do código da página. */
  pareceCodigo: string
  dicaManualEnv: string
  dicaManualArquivo: string
  placeholderToken: string
  enviarToken: string
  abrirManual: string
}

/** As classes de cada elemento. Cada tela veste a sua. */
export interface EstiloDeConexao {
  botao: string
  campo: string
  texto: string
  erro: string
  codigo: string
  linkDiscreto: string
}

export const ESTILO_DO_ASSISTENTE: EstiloDeConexao = {
  botao: 'wz-btn wz-btn-primary',
  campo: 'wz-field',
  texto: 'wz-opt-desc',
  erro: 'wz-err',
  codigo: 'wz-cmd',
  linkDiscreto: 'wz-diag-details-toggle',
}

/**
 * As frases do assistente, tiradas do dicionário de idiomas — as MESMAS de
 * antes desta extração, chave por chave. O assistente continua traduzido; é o
 * painel que fala PT-BR fixo, como toda tela dele.
 */
export function textosDoAssistente(t: (chave: string) => string): TextosDeConexao {
  return {
    conectar: t('setup.connectBtn'),
    religar: t('setup.connectRelinkBtn'),
    precisaReligarTitulo: t('setup.connectNeedsReloginLabel'),
    precisaReligarDesc: t('setup.connectNeedsReloginDesc'),
    conectando: t('setup.connecting'),
    verificando: t('setup.connectVerifying'),
    abrirLink: t('setup.connectOpenLink'),
    placeholderCodigo: t('setup.connectPasteCodePlaceholder'),
    enviarCodigo: t('setup.connectSubmitCode'),
    aguardandoAprovacao: t('setup.connectWaitingApproval'),
    dicaDeErro: (tipo) => t(connectErrorHintKey(tipo)),
    pareceCodigo: t('setup.connectManualLooksLikeCode'),
    dicaManualEnv: t('setup.connectManualHintEnv'),
    dicaManualArquivo: t('setup.connectManualHintFile'),
    placeholderToken: t('setup.connectPaste'),
    enviarToken: t('setup.connectManualSubmit'),
    abrirManual: t('setup.connectManualToggle'),
  }
}
