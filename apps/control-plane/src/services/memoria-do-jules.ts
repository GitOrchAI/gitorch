// A memória de "como o Jules trabalha" (D51). Quando a análise de 2 falhas
// (analise-de-falha-do-dev.ts) entende um padrão, ele fica GRAVADO aqui e passa
// a alimentar a redação das próximas issues (RA e PO leem `lerAprendizados`).
//
// Persistência: a tabela `events` (type = 'jules-learning'), escopada por
// projeto. Simples de propósito — não precisa de vetores nem de um store novo.
//
// FAIL-SOFT em tudo: um erro de leitura NUNCA pode quebrar a redação de uma
// issue. Erro → devolve [] e a issue sai sem o extra, que é o comportamento de
// antes.

export const TIPO_DO_APRENDIZADO = 'jules-learning'

/**
 * Padrões curados para escrever issues que o dev assíncrono (Jules e similares)
 * resolve DE PRIMEIRA. Destilado de https://github.com/google-labs-code/jules-awesome-list
 * (crédito aos autores). Embutido como constante — o build do control-plane é só
 * `tsc` e não copia arquivos soltos, então um `.md` em `src/data/` não chegaria
 * ao `dist/`.
 */
const GUIA_CURADO = `# Como escrever para o dev assíncrono
<!-- destilado de github.com/google-labs-code/jules-awesome-list -->

O corpo da issue é TUDO que o agente tem. Ele não vê a conversa, não vê o board,
não vê a sua cabeça. Escreva para esse leitor.

## O que o dev assíncrono resolve bem
- Refatoração dirigida: "de X para Y" com o arquivo nomeado.
- Testes de um módulo específico. Documentação de um módulo.
- Bug com pista: o sintoma E o arquivo ("undefined em src/cart.ts:42 quando o carrinho está vazio").
- Análise pontual: duplicação, dívida, um padrão repetido.

## O que faz o dev assíncrono TROPEÇAR (evitar na issue)
- Escopo largo ("melhore o checkout") — ele não sabe onde parar.
- Mais de um problema na mesma issue — ele entrega o primeiro e pula o resto
  (o passo de INTEGRAÇÃO é o mais pulado).
- Referência vaga ("o componente do menu" em vez de src/nav/Menu.tsx).
- Contexto ausente: qual framework, qual gerenciador de pacotes, qual comando roda os testes.
- Pedir reescrita completa em vez de mudança incremental.
- Caminho inventado — se você citar um arquivo que não existe, ele cria um novo
  em vez de achar o certo.

## A forma de uma boa issue
1. Título: a mudança concreta, uma linha.
2. Related Files: caminhos REAIS copiados do codegraph, verbatim. Se nenhum
   serve, nomeie o diretório a explorar e diga por quê.
3. Implementation Guide: passos numerados no nível do arquivo, cada um com o
   "de -> para" e o stack envolvido.
4. Verification Criteria: o que precisa estar verdade no diff para a entrega valer.
5. Scope: UMA mudança focada. "Não mexa em nada fora do descrito acima."
6. REUSE FIRST: nomeie o helper/módulo/padrão existente para estender.

## Quando o dev assíncrono pergunta (AWAITING_USER_FEEDBACK)
É sinal de que a issue faltou contexto. Responda na hora; e da próxima vez esse
contexto entra no corpo da issue.`

/** Quantos aprendizados carregar no contexto — teto para não estourar o prompt. */
export const TETO_DE_APRENDIZADOS = 8

export interface AprendizadoDoJules {
  /** O padrão aprendido, em uma ou duas frases. */
  padrao: string
  /** De onde veio: 'analise-2-falhas' | 'incidente-resolvido' | ... */
  origem: string
  /** A issue que originou o aprendizado, quando houver. */
  issueNumber?: number
  /** O texto revisado do pedido, quando a origem foi a análise de falhas. */
  pedidoRevisado?: string
}

export interface PrismaEventoDoJules {
  event: {
    create: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<Array<{ payload: unknown }>>
  }
}

/**
 * Grava um aprendizado sobre o Jules. Best-effort: um erro aqui vira aviso, não
 * exceção — perder um aprendizado é ruim, quebrar o fluxo que o gerou é pior.
 */
export async function registrarAprendizado(deps: {
  prisma: PrismaEventoDoJules
  projectId: string
  aprendizado: AprendizadoDoJules
  onWarn?: (m: string) => void
}): Promise<void> {
  try {
    await deps.prisma.event.create({
      data: {
        projectId: deps.projectId,
        type: TIPO_DO_APRENDIZADO,
        payload: deps.aprendizado as unknown as Record<string, unknown>,
      },
    })
  } catch (err) {
    ;(deps.onWarn ?? console.warn)(
      `[memoria-do-jules] não deu para gravar o aprendizado de ${deps.projectId}: ${(err as Error).message}`
    )
  }
}

/**
 * Lê os aprendizados recentes deste projeto. `issueNumber`, quando passado,
 * traz PRIMEIRO os aprendizados daquela issue (é o que a 3ª tentativa injeta).
 */
export async function lerAprendizados(deps: {
  prisma: PrismaEventoDoJules
  projectId: string
  issueNumber?: number
  teto?: number
  onWarn?: (m: string) => void
}): Promise<AprendizadoDoJules[]> {
  try {
    const linhas = await deps.prisma.event.findMany({
      where: { projectId: deps.projectId, type: TIPO_DO_APRENDIZADO },
      orderBy: { createdAt: 'desc' },
      take: (deps.teto ?? TETO_DE_APRENDIZADOS) * 3,
    })
    const todos = linhas
      .map((l) => l.payload as AprendizadoDoJules)
      .filter((a) => a && typeof a.padrao === 'string' && a.padrao.trim() !== '')
    // Dedup por texto do padrão (o mesmo padrão pode ter sido gravado 2x).
    const vistos = new Set<string>()
    const unicos = todos.filter((a) => {
      const chave = a.padrao.trim().toLowerCase()
      if (vistos.has(chave)) return false
      vistos.add(chave)
      return true
    })
    const daIssue = deps.issueNumber ? unicos.filter((a) => a.issueNumber === deps.issueNumber) : []
    const resto = unicos.filter((a) => !daIssue.includes(a))
    return [...daIssue, ...resto].slice(0, deps.teto ?? TETO_DE_APRENDIZADOS)
  } catch (err) {
    ;(deps.onWarn ?? console.warn)(
      `[memoria-do-jules] leitura falhou para ${deps.projectId}: ${(err as Error).message}`
    )
    return []
  }
}

/** O guia curado (jules-awesome-list destilado), para injetar no contexto. */
export function guiaCuradoDoJules(): string {
  return GUIA_CURADO
}

/** Um bloco de contexto pronto: o guia + os aprendizados deste projeto/issue. */
export async function blocoDeContextoDoJules(deps: {
  prisma: PrismaEventoDoJules
  projectId: string
  issueNumber?: number
  onWarn?: (m: string) => void
}): Promise<string> {
  const guia = guiaCuradoDoJules()
  const aprendizados = await lerAprendizados(deps)
  const partes: string[] = []
  if (guia.trim()) partes.push(guia.trim())
  if (aprendizados.length > 0) {
    partes.push(
      'What we have LEARNED about how this async dev fails on THIS project (apply it when writing the issue):\n' +
        aprendizados.map((a) => `- ${a.padrao}`).join('\n')
    )
  }
  return partes.join('\n\n')
}
