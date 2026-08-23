// Ler uma seção do corpo de uma issue escrita no padrão do produto.
//
// O corpo que o PO gera tem cabeçalhos fixos (`DOD_FIELD_MAP`, em
// packages/cadence/src/rails.ts): Goal, Task Details, Verification Criteria,
// Dependencies, Related Files, Notes.
//
// Existia UMA leitura dessas no projeto, solta dentro do julgamento
// (qa-rails-mission.ts) como uma expressão regular no meio da função, colada
// em "Verification Criteria". Precisar da mesma leitura para outro cabeçalho
// produziria uma segunda cópia — e duas cópias de uma regra de parsing
// divergem na primeira vez que o formato muda. Por isso a regra mora aqui.

/**
 * Devolve o texto de uma seção `## <cabeçalho>`, ou string vazia.
 *
 * String vazia para cabeçalho ausente é deliberado: devolver o corpo inteiro
 * por engano faria a leitura de arquivos encontrar "arquivo" em qualquer texto
 * que tivesse uma barra.
 */
export function lerSecaoDaIssue(corpo: string | undefined | null, cabecalho: string): string {
  if (!corpo) return ''
  const escapado = cabecalho.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const achado = corpo.match(new RegExp(`##\\s*${escapado}\\s*\\n+([\\s\\S]*?)(?:\\n##\\s|$)`, 'i'))
  return achado?.[1]?.trim() ?? ''
}

/** O que o PO escreve quando não há arquivo a declarar. */
const SEM_ARQUIVO = new Set(['none', 'n/a', 'na', 'nenhum', 'nenhuma', '-', ''])

/**
 * Arquivos de verdade que não têm extensão nenhuma. A lista é curta de
 * propósito: só nomes canônicos, sem adivinhação.
 *
 * Sem eles, uma colisão em `Dockerfile` entre duas tarefas passava batida — o
 * nome sumia silenciosamente da leitura por não ter ponto.
 */
const SEM_EXTENSAO = new Set([
  'dockerfile',
  'makefile',
  'license',
  'procfile',
  'jenkinsfile',
  'codeowners',
])

/**
 * Parece caminho de arquivo?
 *
 * O PO escreve texto livre quando não tem certeza, e "todo o backend" não é um
 * arquivo. Tratar frase como caminho faria duas tarefas quaisquer colidirem e
 * a fila travaria sozinha — o oposto exato do que esta leitura existe para
 * fazer.
 *
 * Três formas contam como caminho, e espaço nunca conta: ter uma barra
 * (`src/a.ts`), ser um nome canônico sem extensão (`Dockerfile`), ou começar
 * com ponto (`.env`, `.gitignore`).
 *
 * A extensão precisa ser ALFABÉTICA. Aceitar dígito fazia `v1.2.3` — um número
 * de versão citado no texto — virar um arquivo, e dois textos que citassem a
 * mesma versão colidiriam sem ter nada em comum.
 */
function pareceCaminho(texto: string): boolean {
  if (!texto || /\s/.test(texto)) return false
  if (!/^[\w./-]+$/.test(texto)) return false
  if (SEM_EXTENSAO.has(texto.toLowerCase())) return true
  if (texto.startsWith('.')) return true
  if (texto.includes('/')) return true
  return /\.[a-z]{1,6}$/i.test(texto)
}

/**
 * Os caminhos declarados na seção "Related Files".
 *
 * Lista vazia significa "não sei", NÃO "nenhum arquivo" — e a diferença
 * importa rio abaixo: quem não declara arquivo nunca pode ser bloqueado por
 * conflito de arquivo, senão a fila para de andar por falta de informação, que
 * é o pior desfecho possível desta leitura.
 *
 * A normalização (barra inicial, `./`, barras repetidas, espaços) existe para
 * a comparação: sem ela, `/src/a.ts` e `src/a.ts` seriam arquivos diferentes e
 * o conflito passaria batido.
 *
 * O que NÃO se normaliza é a caixa: o sistema de arquivos aqui distingue
 * maiúscula de minúscula, então `src/A.ts` e `src/a.ts` são dois arquivos
 * mesmo, e juntá-los inventaria uma colisão que não existe.
 */
export function arquivosDeclarados(corpo: string | undefined | null): string[] {
  const secao = lerSecaoDaIssue(corpo, 'Related Files')
  if (!secao) return []

  const vistos = new Set<string>()
  for (const bruto of secao.split(/[,\n]/)) {
    const limpo = bruto
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^`|`$/g, '')
      .replace(/^\.\//, '')
      .replace(/^\//, '')
      // Barras repetidas são o mesmo arquivo: `src//a.ts` e `src/a.ts`. Sem
      // colapsar, os dois viram entradas distintas e a colisão passa batida.
      .replace(/\/{2,}/g, '/')
      .trim()
    if (SEM_ARQUIVO.has(limpo.toLowerCase())) continue
    if (!pareceCaminho(limpo)) continue
    vistos.add(limpo)
  }
  return [...vistos]
}
