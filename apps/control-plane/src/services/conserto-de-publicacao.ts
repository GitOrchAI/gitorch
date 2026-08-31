// A publicação que falha VOLTA ATRÁS: vira tarefa de conserto no repositório
// do cliente.
//
// O buraco que este módulo fecha: a vigília pós-merge (`varrerPublicacoes`,
// scheduler.ts) já sabia distinguir 'no-ar' de 'falhou', e já sabia FECHAR a
// entrega quando a publicação era confirmada — mas no estado 'falhou'
// ninguém agia. Nenhuma issue, nenhum conserto, nenhum trabalho novo. O
// ciclo enxergava e não fazia nada: a entrega ficava pendurada e o cliente
// ficava sem a mudança no ar, em silêncio. O mesmo valia para o ensaio do
// ambiente publicado: o produto abria o endereço, via a tela não responder,
// avisava no chat, e a coisa morria ali.
//
// Decisão PURA de propósito: nem rede, nem banco, nem relógio. Recebe a
// evidência já colhida e devolve se a falha vira tarefa, com o corpo pronto.
// Quem escreve no repositório do cliente continua sendo o caminho ÚNICO de
// escrita (`criarIssueDeDesejo`, desejo-no-github.ts) — duas portas de
// escrita divergiriam em silêncio.

import { type DoDFields } from '@gitorch/cadence'
import { agentLabel } from './agent-label.js'
import { renderIssueBody } from './backlog-executor.js'

/**
 * De onde veio a prova da falha. Duas origens, um só serviço: o que muda é
 * a evidência (as etapas do fluxo de publicação, ou a tela que não
 * respondeu), nunca a decisão de COMO a tarefa nasce.
 */
export type OrigemDoConserto = 'publicacao' | 'ambiente'

export type EvidenciaDeConserto =
  | {
      origem: 'publicacao'
      /** O veredito de `acompanharPublicacao` (publicacao.ts). */
      estado: string
      motivo: string
      etapas: Array<{ nome: string; resultado: string }>
    }
  | {
      origem: 'ambiente'
      /** O veredito de `testarAmbiente` (qa-de-ambiente.ts). */
      veredito: string
      motivo: string
      enderecos: string[]
      /**
       * `true` quando a guarda de rede recusou todos os endereços antes de
       * qualquer tentativa (`RelatorioDeAmbiente`). Um ambiente que não é
       * alcançável a partir daqui — uma rede interna do cliente, por
       * exemplo — é limitação de alcance, não defeito de código: nunca vira
       * tarefa, e nunca adia o fecho da entrega esperando uma repetição que
       * seria idêntica para sempre.
       */
      recusadoPelaGuarda: boolean
      testes: Array<{ caminho: string; status: number | null; ok: boolean }>
      /**
       * Quantas leituras SEGUIDAS deram este mesmo veredito. Existe por um
       * motivo só: 'inalcancavel' significa que nenhuma resposta chegou —
       * indistinguível, numa leitura só, de uma queda de rede de trinta
       * segundos do lado de cá. Abrir tarefa no repositório do CLIENTE por
       * causa disso é fabricar ruído no quadro dele. Duas leituras seguidas
       * (separadas pela cadência da vigília) já não são acidente.
       */
      observacoesSeguidas: number
    }

export interface EntradaDeConserto {
  repositorio: string
  shaDaMescla: string
  /** Número do PR que trouxe a mudança; nulo quando a linha não o guardou. */
  numeroDoPr: number | null
  /** A tarefa de origem, que continua aberta — o conserto é filho dela. */
  issueDaEntrega: number | null
  /**
   * A marca já gravada na linha da sessão. É o dedup: uma publicação que
   * falha é reexaminada a CADA varredura, e sem esta marca o produto abriria
   * uma issue por tique no repositório do cliente.
   */
  marcaAnterior: string | null
  evidencia: EvidenciaDeConserto
}

export type DecisaoDeConserto =
  | { abrir: false; motivo: string }
  | {
      abrir: true
      /** Vai para a linha da sessão E para o marcador dentro do corpo. */
      chave: string
      titulo: string
      campos: Omit<DoDFields, 'titulo'>
      corpo: string
      etiquetas: string[]
    }

/** Chave de dedup por (origem + commit) — nunca por título, que muda. */
export function chaveDeConserto(origem: OrigemDoConserto, sha: string): string {
  return `gitorch:conserto:${origem}:${sha}`
}

/** Prefixo do commit, do jeito que gente lê. */
function commitCurto(sha: string): string {
  return sha.slice(0, 7)
}

function referenciaDoPr(numero: number | null): string {
  return numero === null ? 'o PR desta entrega' : `#${numero}`
}

function referenciaDaEntrega(numero: number | null): string {
  return numero === null ? 'a tarefa de origem desta entrega' : `#${numero}`
}

/**
 * Só estes dois vereditos são falha DESTA vigília, e a razão de cada um
 * ficar de fora importa:
 *
 * - 'publicando' ainda está acontecendo; 'commit-errado' tem teto próprio
 *   (`TETO_DE_COMMIT_ERRADO_MS`) e na maioria das vezes se resolve na
 *   execução seguinte — abrir tarefa neles seria alarme falso.
 * - 'no-ar' é sucesso; 'sem-publicacao' já tem tratamento próprio (a
 *   entrega é resolvida no quadro e o dono é avisado uma vez).
 */
function decidirPelaPublicacao(estado: string): { abrir: boolean; motivo: string } {
  if (estado === 'falhou') return { abrir: true, motivo: 'a publicação falhou' }
  return {
    abrir: false,
    motivo: `estado "${estado}" não é uma falha de publicação confirmada — nada a consertar ainda.`,
  }
}

/**
 * O ambiente inalcançável na PRIMEIRA leitura não vira tarefa — pode ser uma
 * queda de rede de trinta segundos do lado de cá — e também não pode ser
 * esquecido. Quem chama precisa ler de novo na janela seguinte ANTES de dar a
 * entrega por terminada; é o único caso em que a vigília adia o fecho.
 *
 * Predicado exportado para que a regra viva num lugar só: repetida no
 * chamador, ela divergiria em silêncio da decisão que ele mesmo consulta.
 */
export function aguardaSegundaLeituraDoAmbiente(args: {
  veredito: string
  observacoesSeguidas: number
  recusadoPelaGuarda: boolean
}): boolean {
  if (args.recusadoPelaGuarda) return false
  return args.veredito === 'inalcancavel' && args.observacoesSeguidas < 2
}

/** A frase que conta ao dono que o conserto já virou trabalho no quadro. */
export function notaDeConserto(numeroDaIssue: number): string {
  return ` O conserto já virou tarefa no repositório (#${numeroDaIssue}).`
}

function decidirPeloAmbiente(args: {
  veredito: string
  observacoesSeguidas: number
  recusadoPelaGuarda: boolean
}): { abrir: boolean; motivo: string } {
  const { veredito, observacoesSeguidas } = args
  if (veredito === 'sem-endereco') {
    return {
      abrir: false,
      motivo:
        'este projeto não tem endereço de ambiente configurado — não há defeito de código a consertar.',
    }
  }
  // Endereço que a guarda de rede recusa nunca é alcançado a partir daqui,
  // hoje nem daqui a dez minutos: repetir a leitura daria o mesmo resultado
  // para sempre, e abrir tarefa acusaria o cliente de um defeito que não
  // existe no código dele.
  if (args.recusadoPelaGuarda) {
    return {
      abrir: false,
      motivo:
        'o endereço publicado está fora do alcance da rede a partir daqui — limitação de alcance, não defeito de código.',
    }
  }
  if (veredito === 'falhou') {
    // A tela RESPONDEU, e respondeu mal. Isso é o ambiente publicado
    // dizendo que está quebrado — não há nada de transitório a esperar.
    return { abrir: true, motivo: 'o ambiente publicado respondeu com erro' }
  }
  if (veredito === 'inalcancavel') {
    if (!aguardaSegundaLeituraDoAmbiente({ ...args, veredito, observacoesSeguidas })) {
      return { abrir: true, motivo: 'o ambiente publicado seguiu inalcançável' }
    }
    return {
      abrir: false,
      motivo:
        'nenhuma resposta chegou nesta leitura, mas uma leitura só não separa ambiente fora do ar de queda de rede momentânea — esperando a confirmação da próxima.',
    }
  }
  return { abrir: false, motivo: `veredito "${veredito}" não é reprovação do ambiente.` }
}

function camposDaPublicacao(
  entrada: EntradaDeConserto,
  evidencia: Extract<EvidenciaDeConserto, { origem: 'publicacao' }>
): { titulo: string; campos: Omit<DoDFields, 'titulo'> } {
  const curto = commitCurto(entrada.shaDaMescla)
  const pr = referenciaDoPr(entrada.numeroDoPr)
  const entregaDeOrigem = referenciaDaEntrega(entrada.issueDaEntrega)
  const etapas =
    evidencia.etapas.length > 0
      ? evidencia.etapas.map((e) => `- \`${e.nome}\`: ${e.resultado}`).join('\n')
      : '- (o fluxo de publicação não expôs etapas nomeadas nesta execução)'

  return {
    titulo: `Conserto: a publicação do commit ${curto} não chegou ao ar`,
    campos: {
      goal:
        `Fazer a entrega já mesclada (${pr}, commit ${entrada.shaDaMescla}) chegar de fato ao ar. ` +
        `O código está na branch principal; o que quebrou foi a publicação.`,
      taskDetails: [
        `- Repositório: ${entrada.repositorio}`,
        `- Commit mesclado: ${entrada.shaDaMescla}`,
        `- Pull request de origem: ${pr}`,
        `- Entrega de origem: ${entregaDeOrigem} (segue ABERTA — a mudança não está no ar)`,
        `- Veredito da vigília de publicação: ${evidencia.estado}`,
        `- O que a vigília viu: ${evidencia.motivo}`,
        '',
        'Etapas observadas no fluxo de publicação:',
        etapas,
      ].join('\n'),
      taskDescription:
        `Depois da mescla, o produto acompanhou a publicação deste commit e ela terminou em ` +
        `FALHA — o ambiente do cliente continua com a versão anterior. Esta tarefa é o retorno ` +
        `dessa entrega: descobrir por que a publicação quebrou e corrigir a CAUSA, não contornar ` +
        `o sintoma. Reverter a mudança só é aceitável se a causa for a própria mudança e o ` +
        `conserto direto não couber nesta tarefa — e, nesse caso, diga isso em Notes.`,
      implementationGuide: [
        `1. Abra a execução do fluxo de publicação para o commit ${curto} no GitHub Actions e leia o log da PRIMEIRA etapa que falhou (listada em Task Details) — a primeira falha é a causa; as seguintes costumam ser efeito.`,
        `2. Reproduza a falha localmente ou no ambiente de ensaio antes de mudar qualquer coisa. Se a etapa depende de segredo, credencial ou variável de ambiente, confirme que ela existe no repositório em vez de supor.`,
        `3. Corrija a causa no arquivo do fluxo de publicação (\`.github/workflows/\`) ou no código/configuração que a etapa usa. É PROIBIDO mascarar: nada de \`continue-on-error\`, \`|| true\`, pular etapa ou suprimir erro para o fluxo ficar verde.`,
        `4. Empurre a correção num pull request que referencie ${entregaDeOrigem} e deixe o fluxo de publicação rodar até o fim.`,
      ].join('\n'),
      verificationCriteria: [
        `- O fluxo de publicação roda até o fim, VERDE, para o commit desta correção — sem etapa pulada, sem erro tolerado.`,
        `- O endereço público do ambiente responde com a mudança da entrega de origem (${entregaDeOrigem}) — abra a tela e veja, não deduza pelo log.`,
        `- A etapa que aparece falhando em Task Details volta a concluir com sucesso.`,
      ].join('\n'),
      dependencies: `Nenhuma tarefa bloqueia esta: o código de ${pr} já está mesclado na branch principal. O que falta é a publicação.`,
      relatedFiles: [
        `- \`.github/workflows/\` — é onde vive o fluxo de publicação deste repositório; a etapa que falhou está definida em um dos arquivos daqui. Nenhum caminho mais específico é citado de propósito: a vigília lê a API do GitHub, não a árvore do repositório, e inventar um caminho seria pior que nomear o diretório certo.`,
      ].join('\n'),
      notes: [
        `Esta tarefa foi aberta pelo próprio produto ao acompanhar a publicação — uma única vez para este commit (a marca de controle é \`${chaveDeConserto('publicacao', entrada.shaDaMescla)}\`).`,
        `A entrega de origem (${entregaDeOrigem}) continua ABERTA de propósito: fechá-la seria dizer ao quadro que a mudança está no ar quando ela não está.`,
      ].join('\n'),
    },
  }
}

function camposDoAmbiente(
  entrada: EntradaDeConserto,
  evidencia: Extract<EvidenciaDeConserto, { origem: 'ambiente' }>
): { titulo: string; campos: Omit<DoDFields, 'titulo'> } {
  const curto = commitCurto(entrada.shaDaMescla)
  const pr = referenciaDoPr(entrada.numeroDoPr)
  const entregaDeOrigem = referenciaDaEntrega(entrada.issueDaEntrega)
  const reprovados = evidencia.testes.filter((t) => !t.ok)
  const linhasDeTeste =
    reprovados.length > 0
      ? reprovados
          .map(
            (t) =>
              `- \`${t.caminho}\` → ${t.status === null ? 'nenhuma resposta chegou (erro de conexão ou tempo esgotado)' : `HTTP ${t.status}`}`
          )
          .join('\n')
      : '- (nenhuma resposta chegou de nenhuma tela testada)'
  const enderecos =
    evidencia.enderecos.length > 0
      ? evidencia.enderecos.map((e) => `- ${e}`).join('\n')
      : '- (endereço não informado pela vigília)'

  return {
    titulo: `Conserto: o ambiente publicado não respondeu depois da entrega ${curto}`,
    campos: {
      goal:
        `Fazer o ambiente publicado de ${entrada.repositorio} voltar a responder. A publicação do ` +
        `commit ${entrada.shaDaMescla} foi confirmada, mas o teste feito no endereço real reprovou.`,
      taskDetails: [
        `- Repositório: ${entrada.repositorio}`,
        `- Commit publicado: ${entrada.shaDaMescla}`,
        `- Pull request de origem: ${pr}`,
        `- Entrega de origem: ${entregaDeOrigem}`,
        `- Veredito do teste de ambiente: ${evidencia.veredito}`,
        `- O que o teste viu: ${evidencia.motivo}`,
        '',
        'Endereços testados:',
        enderecos,
        '',
        'Telas que não responderam bem:',
        linhasDeTeste,
      ].join('\n'),
      taskDescription:
        `O produto publicou a entrega, abriu o endereço real do ambiente e as telas acima não ` +
        `responderam como deviam. Publicação verde com site fora do ar é exatamente o caso em que ` +
        `o log mente e a tela conta a verdade. Esta tarefa é achar a CAUSA de o ambiente não ` +
        `responder — não silenciar o teste, não relaxar o critério.`,
      implementationGuide: [
        `1. Abra você mesmo cada tela listada em Task Details e confirme o código de resposta. Se ela responde bem agora, a falha é intermitente: investigue o que a torna intermitente em vez de fechar a tarefa.`,
        `2. Olhe o log do serviço publicado no momento da entrega do commit ${curto} — erro de inicialização, migração de banco que não rodou e variável de ambiente ausente são as causas mais comuns de uma publicação verde com o serviço fora do ar.`,
        `3. Corrija a causa (código, migração ou configuração do ambiente) e publique de novo. É PROIBIDO mascarar: nada de afrouxar o critério do teste, remover a tela da lista testada ou tolerar erro para o ensaio passar.`,
        `4. Se a causa for a mudança de ${pr}, reverta-a num pull request próprio e explique em Notes por que a correção direta não cabia.`,
      ].join('\n'),
      verificationCriteria: [
        `- Cada tela listada em Task Details responde entre 200 e 399 ao ser aberta no endereço público do ambiente.`,
        `- A causa está nomeada no pull request de conserto (o que quebrou e por quê), não apenas "voltou a funcionar".`,
        `- Uma nova publicação roda até o fim e o ambiente segue respondendo depois dela.`,
      ].join('\n'),
      dependencies: `Nenhuma tarefa bloqueia esta: o código de ${pr} já está publicado. O que falta é o ambiente responder.`,
      relatedFiles: [
        `- \`.github/workflows/\` — o fluxo que publicou este commit; é por ele que a próxima publicação vai passar.`,
        `- A configuração de ambiente do serviço publicado (variáveis, segredos, migrações executadas na subida). Nenhum caminho mais específico é citado de propósito: a evidência veio da rede, não da árvore do repositório, e inventar um caminho seria pior que nomear onde procurar.`,
      ].join('\n'),
      notes: [
        `Esta tarefa foi aberta pelo próprio produto ao testar o ambiente publicado — uma única vez para este commit (a marca de controle é \`${chaveDeConserto('ambiente', entrada.shaDaMescla)}\`).`,
        `Um ambiente inalcançável só vira tarefa depois de DUAS leituras seguidas com o mesmo resultado; uma leitura só não separa serviço fora do ar de queda de rede momentânea.`,
      ].join('\n'),
    },
  }
}

/**
 * Decide se a falha observada vira tarefa de conserto — e, quando vira, monta
 * o corpo já no padrão Shrimp (os oito campos do DoD, na ordem canônica).
 *
 * O padrão não é enfeite: o Scrum Master só delega issue que o passa, então
 * uma tarefa de conserto fora do padrão nasceria morta — visível no quadro e
 * nunca executada.
 */
export function decidirConsertoDePublicacao(entrada: EntradaDeConserto): DecisaoDeConserto {
  const { evidencia } = entrada

  const veredito =
    evidencia.origem === 'publicacao'
      ? decidirPelaPublicacao(evidencia.estado)
      : decidirPeloAmbiente({
          veredito: evidencia.veredito,
          observacoesSeguidas: evidencia.observacoesSeguidas,
          recusadoPelaGuarda: evidencia.recusadoPelaGuarda,
        })

  if (!veredito.abrir) return { abrir: false, motivo: veredito.motivo }

  const chave = chaveDeConserto(evidencia.origem, entrada.shaDaMescla)
  if (entrada.marcaAnterior === chave) {
    return {
      abrir: false,
      motivo: `já existe tarefa de conserto aberta para este commit (${chave}).`,
    }
  }

  const montado =
    evidencia.origem === 'publicacao'
      ? camposDaPublicacao(entrada, evidencia)
      : camposDoAmbiente(entrada, evidencia)

  return {
    abrir: true,
    chave,
    titulo: montado.titulo,
    campos: montado.campos,
    // `null` de peso, e não um número: esta tarefa nasce de uma publicação que
    // falhou, não do roteiro do PO — ninguém a estimou. Inventar um tamanho
    // aqui seria publicar estimativa que não existe.
    corpo: renderIssueBody({ titulo: montado.titulo, ...montado.campos }, chave, null),
    // `gitorch:task` é o que o Scrum Master procura para delegar — sem ele a
    // tarefa fica visível no quadro e ninguém a executa. O label de agente
    // diz quem está com a bola agora: quem detectou foi a verificação.
    etiquetas: ['gitorch:task', agentLabel('qa')],
  }
}
