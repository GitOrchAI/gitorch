import type { RespostaDeComoPublica } from './como-o-projeto-publica.js'
import { agentLabel } from './agent-label.js'
import { TASK_LABEL } from './sm-delegation.js'

/**
 * O produto ensina o CD do cliente a avisar que a versão subiu (D50).
 *
 * Ordem do dono, 26/08/2026, nas palavras dele: "o gitorch decide isso, um dos
 * agentes tem que pensar como fazer isso!". Ele recusou as três saídas que eu
 * havia oferecido — eu mesmo abrir o PR no repositório dele, só entregar
 * instruções, ou não fazer nada.
 *
 * A razão é doutrina, não preguiça: o produto já sabe que aquele projeto
 * publica fora do alcance do GitHub e já tem a rota esperando o aviso — o que
 * falta é a chamada existir no CD do cliente. Se um humano põe essa chamada na
 * mão, o produto continua incapaz e o próximo cliente cai exatamente no mesmo
 * buraco. O produto tem que ser capaz de fechar o próprio buraco: perceber,
 * abrir a tarefa, delegar ao dev assíncrono e receber o PR de volta.
 *
 * Decisão PURA de propósito, no mesmo espírito de `conserto-de-publicacao.ts`:
 * nem rede, nem banco, nem relógio. Recebe o que já se sabe e devolve se a
 * falta vira tarefa, com o corpo pronto. Quem escreve no repositório do cliente
 * continua sendo o caminho único de escrita.
 */

/**
 * A marca de deduplicação.
 *
 * Sem ela o produto abriria uma issue por tique no repositório do cliente —
 * é o mesmo defeito que a marca de conserto já existe para impedir. Não leva
 * commit nem data porque o pedido é do PROJETO, não de uma entrega: instalado
 * uma vez, vale para todas as entregas seguintes.
 */
export const CHAVE_DO_PEDIDO_DE_AVISO = 'gitorch:instalar-aviso-de-publicacao'

/**
 * Só estes dois cenários têm CD para instrumentar.
 *
 * `publica-por-workflow` fica de fora porque dali o produto já lê sozinho — a
 * publicação registra no GitHub e pedir aviso seria trabalho inútil no
 * repositório do cliente. `publica-manualmente` fica de fora porque não existe
 * CD nenhum onde pôr a chamada: pedir seria pedir ao cliente que automatize a
 * publicação, que é outra conversa e não é nossa.
 */
const DECLARACOES_COM_CD_PROPRIO: readonly RespostaDeComoPublica[] = [
  'publica-em-vm-propria',
  'publica-em-servico-externo',
]

/**
 * As etiquetas da tarefa.
 *
 * `TASK_LABEL` NAO e decoracao: e o filtro exato com que o Scrum Master procura
 * trabalho para delegar (`sm-delegation.ts`). Sem ela a issue nasce no
 * repositorio do cliente e NUNCA chega ao dev assincrono — e, como o pedido e
 * deduplicado, o produto nunca mais tenta: a issue fica orfa para sempre e o
 * projeto travado, sem ninguem perceber. Foi assim que a primeira versao desta
 * feature falhou na revisao, por ser a unica no codigo inteiro que criava
 * tarefa com a etiqueta do agente sozinha. Por isso o valor vem IMPORTADO de
 * quem faz a busca, nunca copiado a mao.
 */
export const ETIQUETAS_DO_PEDIDO_DE_AVISO = [TASK_LABEL, agentLabel('sm')]

export type DecisaoDePedirOAviso =
  | { abrir: false; motivo: string }
  | { abrir: true; chave: string; titulo: string; etiquetas: string[] }

export function decidirPedirOAviso(args: {
  repositorio: string
  projectId: string
  /** O que o dono respondeu sobre como o projeto vai ao ar. */
  declarado: RespostaDeComoPublica | null
  /**
   * O aviso já chegou pelo menos uma vez para este projeto. É a prova de que
   * a chamada existe e funciona — melhor que qualquer marca nossa, porque vem
   * do comportamento real e não de uma intenção registrada.
   */
  jaInstalado: boolean
  /** A marca do último pedido feito para este projeto, se houve. */
  marcaAnterior: string | null
}): DecisaoDePedirOAviso {
  if (args.declarado === null) {
    return {
      abrir: false,
      motivo:
        'o dono ainda não disse como este projeto vai ao ar — primeiro se pergunta, nunca se adivinha.',
    }
  }
  if (!DECLARACOES_COM_CD_PROPRIO.includes(args.declarado)) {
    return {
      abrir: false,
      motivo: `"${args.declarado}" não tem um CD nosso para instrumentar.`,
    }
  }
  if (args.jaInstalado) {
    return {
      abrir: false,
      motivo: 'o aviso já chegou pelo menos uma vez — a chamada existe e está funcionando.',
    }
  }
  if (args.marcaAnterior === CHAVE_DO_PEDIDO_DE_AVISO) {
    return {
      abrir: false,
      motivo: 'a tarefa de instalar o aviso já foi aberta neste projeto.',
    }
  }
  return {
    abrir: true,
    chave: CHAVE_DO_PEDIDO_DE_AVISO,
    titulo: 'Avisar o GitOrch quando o deploy sobe ao ar',
    etiquetas: ETIQUETAS_DO_PEDIDO_DE_AVISO,
  }
}

/**
 * O que o dev assíncrono recebe.
 *
 * Escrito para ser executável por quem nunca ouviu falar do GitOrch: onde a
 * chamada entra, o que ela manda, e — o ponto que não pode falhar — que a
 * chave vai como SEGREDO do repositório, jamais escrita no arquivo. Um
 * workflow com credencial em texto puro é público para qualquer pessoa com
 * acesso de leitura, e para o mundo inteiro num repositório aberto.
 *
 * Este corpo NUNCA carrega o valor de chave nenhuma: ele ensina a referenciar
 * o segredo, e quem cria o segredo é o dono.
 */
export function corpoDoPedidoDeAviso(args: {
  repositorio: string
  projectId: string
  /** O endereço do GitOrch que este cliente usa. */
  endereco: string
}): string {
  return [
    `<!-- ${CHAVE_DO_PEDIDO_DE_AVISO} -->`,
    '',
    '## O que precisa acontecer',
    '',
    `Este projeto publica fora do GitHub, então o GitOrch não tem como ver sozinho que uma`,
    `versão subiu — e sem essa confirmação toda entrega mesclada fica esperando até desistir.`,
    '',
    'A correção é uma chamada só, no **fim** do processo de deploy: avisar qual commit subiu.',
    '',
    '## A chamada',
    '',
    '```bash',
    `curl -fsS -X POST "${args.endereco}/api/projects/${args.projectId}/publicado" \\`,
    '  -H "Authorization: Bearer $GITORCH_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "{\\"commit\\": \\"$(git rev-parse HEAD)\\"}"',
    '```',
    '',
    '## Regras que não podem ser quebradas',
    '',
    '1. **A chave nunca entra no arquivo.** Ela é lida de uma variável de ambiente',
    '   chamada `GITORCH_API_KEY`. Onde essa variável é definida depende de onde o seu',
    '   deploy roda, e o jeito certo é diferente em cada caso:',
    '',
    '   - **Deploy por GitHub Actions**: guarde como *secret* do repositório e exponha no',
    '     passo com `env: GITORCH_API_KEY: ${{ secrets.GITORCH_API_KEY }}`.',
    '   - **Script numa VM sua (systemd, cron, script de deploy)**: ponha num arquivo de',
    '     ambiente fora da árvore do repositório — por exemplo `/etc/gitorch.env` com',
    '     permissão `600` — e carregue no serviço (`EnvironmentFile=`) ou no script',
    '     (`set -a; . /etc/gitorch.env; set +a`). **Nunca** num arquivo versionado.',
    '   - **Serviço externo (Render, Vercel e afins)**: cadastre como variável de ambiente',
    '     no painel do serviço.',
    '',
    '   Em qualquer um deles: credencial escrita dentro de arquivo versionado fica visível',
    '   para quem tem leitura do repositório — e para o mundo inteiro se ele for público.',
    '   Se você não tem onde guardar um segredo, **peça a variável ao dono do projeto em',
    '   vez de colar o valor no código**.',
    '',
    '2. **Quando o deploy falhar, avise a falha** — não pule a chamada. Deploy que falha',
    '   em silêncio é pior que deploy que falha. Em bash:',
    '',
    '   ```bash',
    '   avisar() {',
    '     curl -fsS -X POST "$GITORCH_URL/api/projects/$PROJECT_ID/publicado" \\',
    '       -H "Authorization: Bearer $GITORCH_API_KEY" \\',
    '       -H "Content-Type: application/json" \\',
    '       -d "{\\"commit\\": \\"$1\\", \\"sucesso\\": $2}"',
    '   }',
    '   COMMIT=$(git rev-parse HEAD)',
    '   if fazer_o_deploy; then avisar "$COMMIT" true; else avisar "$COMMIT" false; exit 1; fi',
    '   ```',
    '',
    '   Repare no `exit 1`: avisar a falha **não** apaga a falha.',
    '',
    '3. **O commit vai inteiro**, como o `git rev-parse HEAD` devolve. Prefixo curto casaria',
    '   com a versão errada, e confirmar a versão errada é pior que não confirmar nada.',
    '',
    '4. A chamada fica **no fim** do deploy, depois de tudo ter subido de verdade — não no',
    '   começo, nem em paralelo.',
    '',
    '## Como conferir que funcionou',
    '',
    'Rode um deploy. A resposta da chamada deve ser `{"registrado": true, "estado": "no-ar"}`.',
    'Se vier `{"registrado": false}`, a chamada está certa mas não havia entrega esperando',
    'confirmação naquele momento — o que também é uma resposta válida.',
  ].join('\n')
}

/**
 * Já existe uma tarefa dessas aberta no repositório do cliente?
 *
 * A marca no banco é o dedup principal, mas ela tem uma janela real: a issue é
 * criada primeiro e a marca gravada depois (essa ordem é de propósito — o
 * contrário deixaria o projeto marcado como "já pedido" sem tarefa nenhuma).
 * Se a gravação falhar no meio, a varredura seguinte pediria de novo e o
 * cliente ganharia uma issue duplicada no quadro dele.
 *
 * Por isso o corpo da issue carrega a chave como marcador: dá para reconhecer
 * a tarefa pelo que ela É, e não só pelo que anotamos sobre ela.
 */
export function jaExisteOPedido(
  issuesAbertas: Array<{ body?: string | null; title?: string | null }>
): boolean {
  return issuesAbertas.some((issue) => (issue.body ?? '').includes(CHAVE_DO_PEDIDO_DE_AVISO))
}
