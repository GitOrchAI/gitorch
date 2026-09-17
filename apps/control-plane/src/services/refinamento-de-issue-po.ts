/**
 * Refinamento de Issue pelo Product Owner (PO).
 *
 * Após análise do Research Agent (RA) entender por que o desenvolvedor falhou 2x
 * numa mesma issue, o PO entra para autocura da equipe Scrum: refina a issue
 * no GitHub, atualizando a especificação no corpo da issue e registrando um
 * comentário formal explicando as alterações e o motivo raiz encontrado.
 */

export interface MontarCorpoRefinadoArgs {
  corpoAtual: string
  pedidoRevisado: string
  causaComum?: string | null | undefined
  arquivos?: string[] | null | undefined
}

export function montarCorpoRefinado(args: MontarCorpoRefinadoArgs): string {
  let corpo = args.corpoAtual ?? ''

  // 1. Monta o bloco do Refinamento do Backlog (PO)
  const linhasPo: string[] = ['## Refinamento do Backlog (PO)', '']
  if (args.causaComum && args.causaComum.trim() !== '') {
    linhasPo.push(`> **Causa Comum Identificada:** ${args.causaComum.trim()}`, '')
  }
  linhasPo.push(args.pedidoRevisado.trim())
  const blocoPo = linhasPo.join('\n')

  // Se já existe a seção "## Refinamento do Backlog (PO)", substitui
  const regexPo = /##\s*Refinamento do Backlog \(PO\)(?:[\s\S]*?)(?=\n##\s|$)/i
  if (regexPo.test(corpo)) {
    corpo = corpo.replace(regexPo, blocoPo)
  } else {
    corpo = corpo.trimEnd() + '\n\n' + blocoPo
  }

  // 2. Se houver arquivos informados, injeta ou atualiza "## Related Files"
  if (args.arquivos && args.arquivos.length > 0) {
    const listaArquivos = args.arquivos.map((a) => `- ${a.trim()}`).join('\n')
    const blocoArquivos = `## Related Files\n\n${listaArquivos}`
    const regexFiles = /##\s*Related Files(?:[\s\S]*?)(?=\n##\s|$)/i
    if (regexFiles.test(corpo)) {
      corpo = corpo.replace(regexFiles, blocoArquivos)
    } else {
      corpo = corpo.trimEnd() + '\n\n' + blocoArquivos
    }
  }

  return corpo.trim()
}

export interface MontarComentarioArgs {
  pedidoRevisado: string
  causaComum?: string | null | undefined
}

export function montarComentarioDeRefinamento(args: MontarComentarioArgs): string {
  const causa =
    args.causaComum && args.causaComum.trim() !== ''
      ? `Identificamos na análise que as tentativas anteriores falharam pelo seguinte motivo comum:\n> ${args.causaComum.trim()}\n\n`
      : ''

  return [
    '### 🎯 Refinamento do Backlog pelo Product Owner (PO)',
    '',
    'Olá time de desenvolvimento!',
    '',
    'Após análise dos impedimentos e falhas anteriores pelo Research Agent (RA) e Product Owner, esta issue foi refinada com requisitos mais claros e objetivos para direcionar a nova tentativa de implementação.',
    '',
    causa + '**Especificação e Pedido Revisado:**\n' + args.pedidoRevisado.trim(),
    '',
    'O corpo da issue já foi atualizado com estas especificações. Bom desenvolvimento!',
  ].join('\n')
}

export interface ExecutarRefinamentoDoPoArgs {
  repository: string
  issueNumber: number
  corpoAtual: string
  pedidoRevisado: string
  causaComum?: string | null | undefined
  arquivos?: string[] | null | undefined
  token?: string | undefined
  chamadorHttp?: (metodo: string, caminho: string, corpo?: unknown) => Promise<unknown>
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export async function executarRefinamentoDoPo(args: ExecutarRefinamentoDoPoArgs): Promise<void> {
  const rest =
    args.chamadorHttp ??
    (async (metodo: string, caminho: string, corpo?: unknown): Promise<unknown> => {
      const url = `https://api.github.com${caminho}`
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
      }
      if (args.token) {
        headers['authorization'] = `token ${args.token}`
      }
      if (corpo) {
        headers['content-type'] = 'application/json'
      }
      const resp = await fetch(url, {
        method: metodo,
        headers,
        ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      })
      if (!resp.ok) {
        throw new Error(`GitHub ${metodo} ${caminho} → ${resp.status}`)
      }
      return resp.json()
    })

  const novoCorpo = montarCorpoRefinado({
    corpoAtual: args.corpoAtual,
    pedidoRevisado: args.pedidoRevisado,
    causaComum: args.causaComum,
    arquivos: args.arquivos,
  })

  // 1. PATCH na issue
  await rest('PATCH', `/repos/${args.repository}/issues/${args.issueNumber}`, {
    body: novoCorpo,
  })
  args.onInfo?.(`[Refinamento-PO] Issue #${args.issueNumber} atualizada com refinamento`)

  // 2. POST no comentário
  const comentario = montarComentarioDeRefinamento({
    pedidoRevisado: args.pedidoRevisado,
    causaComum: args.causaComum,
  })
  await rest('POST', `/repos/${args.repository}/issues/${args.issueNumber}/comments`, {
    body: comentario,
  })
  args.onInfo?.(`[Refinamento-PO] Comentário de refinamento postado na issue #${args.issueNumber}`)
}
