// RELIGAR O MOTOR NO PAINEL — quem ganha botão, e o que o botão promete.
//
// POR QUE ESTE ARQUIVO EXISTE (01/09/2026). O painel mostrava o motor caído e
// oferecia um link para `/setup`, com o rótulo honesto "Religar no assistente".
// Honesto e insuficiente: o dono clicou para religar o Codex e foi parar em
// outra tela. Palavras dele: "Serviço mal pensado."
//
// O botão agora aciona o MESMO fluxo do passo 7 do assistente
// (components/setup/conexao-de-motor.ts), ali mesmo, sem sair do painel. Este
// módulo é a parte que dá para decidir sem React: para quem o botão aparece,
// o que ele diz, e o que fazer quando o produto NÃO sabe religar aquele motor.
import type { MotorCota } from './painel-tipos'
import type { ConnectErrorKind } from '../setup/engine-status'
import type { EstiloDeConexao, TextosDeConexao } from '../setup/conexao-textos'

/**
 * Os motores que o produto sabe religar sozinho — os mesmos que o backend
 * aceita em `POST /engines/:runtime/login/start` (`isDeviceRuntime`, em
 * packages/agents/src/device-prompt-parser.ts). Qualquer outro cai no motivo
 * escrito em vez de num botão que devolveria erro.
 */
export const MOTORES_QUE_RELIGAM_AQUI = ['claude', 'codex', 'antigravity'] as const

/** O motor está fora: ou a credencial venceu, ou nunca foi conectado. */
export function estaFora(m: MotorCota): boolean {
  return m.precisaReligar || m.estado === 'nao_conectado'
}

export function ofereceReligar(m: MotorCota): boolean {
  return estaFora(m) && (MOTORES_QUE_RELIGAM_AQUI as readonly string[]).includes(m.id)
}

/**
 * Por que este motor caído não tem botão. `null` quando não há o que explicar
 * (o motor está bom, ou o botão está ali). Um controle ausente sem explicação
 * parece defeito nosso, e o dono fica procurando o que ele fez de errado.
 */
export function motivoDeNaoReligar(m: MotorCota): string | null {
  if (!estaFora(m) || ofereceReligar(m)) return null
  return `Não sei religar o ${m.nome} por aqui: o login assistido cobre Claude Code, Codex e Antigravity.`
}

/**
 * O rótulo do botão. "Religar" só quando havia uma conexão que venceu;
 * "Conectar" quando nunca houve — dizer religar ali seria inventar um passado.
 * Nos dois casos a frase promete a AÇÃO, e não uma viagem para outra tela.
 */
export function rotuloDeReligar(m: MotorCota): string {
  return `${m.precisaReligar ? 'Religar' : 'Conectar'} o ${m.nome} agora`
}

/**
 * A LINHA DE MOTOR que merece um botão de religar, casando as duas listas que
 * a tela da cascata cruza: o CATÁLOGO (todos os motores que existem) e a COTA
 * (`engine_connections`, só os que já foram tocados). `null` = não desenhe
 * botão.
 *
 * A regra que dói: com a cota NÃO lida, nada aqui vira botão. "Não consegui
 * ler" e "está caído" são fatos diferentes, e oferecer religar por cima de uma
 * leitura que falhou seria afirmar uma pane que ninguém mediu.
 *
 * Motor do catálogo SEM linha de cota é um motor que nunca conectou — e esse
 * merece o caminho, não o silêncio. A linha sintética nasce com todos os
 * números em `null`: nenhum zero inventado entra por esta porta.
 */
export function motorParaReligar(args: {
  runtime: string
  nome: string
  motor: MotorCota | undefined
  cotaLida: boolean
}): MotorCota | null {
  if (!args.cotaLida) return null
  const m: MotorCota = args.motor ?? {
    id: args.runtime,
    nome: args.nome,
    estado: 'nao_conectado',
    sessao: null,
    semana: null,
    lidoEm: null,
    precisaReligar: false,
  }
  return ofereceReligar(m) ? m : null
}

/**
 * A pele dos controles no painel. Só classes que EXISTEM no globals.css — a
 * lição do `.pn-sw`, que nasceu 0x0 porque ninguém escreveu a regra e deixou o
 * controle invisível com todo teste verde (religar-motor.test.ts guarda isto).
 *
 * `wz-err`, `wz-cmd` e `wz-diag-details-toggle` não são do assistente por
 * acidente: são regras globais, sem escopo de tela, construídas sobre os
 * mesmos tokens `--gl-*` que o painel usa. Reusar uma regra provada é mais
 * seguro do que inventar uma nova para dizer a mesma coisa.
 */
export const ESTILO_DO_PAINEL: EstiloDeConexao = {
  botao: 'pn-btn a sm',
  campo: 'pn-field',
  texto: 'pn-casc-nota',
  erro: 'wz-err',
  codigo: 'wz-cmd',
  linkDiscreto: 'wz-diag-details-toggle',
}

/**
 * As frases do painel, em PT-BR fixo como toda tela dele (o assistente é que
 * é traduzido). Cada uma nomeia O MOTOR daquele card: o dono tem três, e uma
 * frase genérica o obrigaria a adivinhar qual está falando.
 */
export function textosDoPainel(m: MotorCota): TextosDeConexao {
  const rotulo = rotuloDeReligar(m)
  return {
    conectar: rotulo,
    religar: rotulo,
    precisaReligarTitulo: `A credencial do ${m.nome} venceu`,
    precisaReligarDesc:
      'A renovação automática não deu conta. É o mesmo caminho do primeiro login — você autoriza na página do provedor e pronto.',
    conectando: `Falando com o ${m.nome}…`,
    verificando: 'Conferindo a conexão…',
    abrirLink: 'Abrir a página de autorização',
    placeholderCodigo: 'Código da página de autorização',
    enviarCodigo: 'Enviar o código',
    aguardandoAprovacao: 'Esperando você autorizar na página que abriu.',
    dicaDeErro: (tipo: ConnectErrorKind) => {
      if (tipo === 'terms')
        return 'Se a tela de Termos do Antigravity travou, cole a credencial manualmente abaixo.'
      if (tipo === 'capture')
        return 'Não consegui pegar a credencial sozinho. Cole abaixo o que o CLI gerou.'
      return 'Você também pode colar a credencial manualmente abaixo.'
    },
    pareceCodigo:
      'Isso parece o código da página — ele vai no campo "Código da página de autorização", acima.',
    dicaManualEnv:
      'Cole o token do `claude setup-token` (começa com sk-ant-oat…) — não é o código da página de autorização.',
    dicaManualArquivo:
      'Cole o conteúdo do arquivo de credencial que o CLI gerou (ex.: auth.json) — não é o código da página de autorização.',
    placeholderToken: 'Cole aqui',
    enviarToken: 'Conectar com o que colei',
    abrirManual: 'Problemas? Colar a credencial manualmente',
  }
}
