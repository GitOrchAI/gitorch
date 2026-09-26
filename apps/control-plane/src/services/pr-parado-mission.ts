import { runFormStep } from './rails-runner.js'
import type { MiniSchema } from '@gitorch/cadence'
import type { StepExecutor } from './role-rails.js'

export interface ContextoPrParado {
  titulo: string
  idadeDias: number
  estadoCi: string
  conflitos: boolean
  arquivosAlterados?: string
  issueLigada?: { numero: number; titulo: string }
  historicoGitorch?: string[]
}

const prParadoSchema: MiniSchema = {
  type: 'object',
  properties: {
    resumo_do_pr: { type: 'string' },
    motivo_da_espera: { type: 'string' },
    recomendacao_do_agente: { type: 'string' },
    opcoes_sob_medida: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['label', 'action'],
      },
    },
  },
  required: ['resumo_do_pr', 'motivo_da_espera', 'recomendacao_do_agente', 'opcoes_sob_medida'],
} as const

export async function gerarPerguntaSobrePrParado(args: {
  contextoPr: ContextoPrParado
  execute: StepExecutor
}) {
  const prompt = `Analise este pull request parado e formule uma pergunta estruturada ao dono.

Fatos:
- Título: ${args.contextoPr.titulo}
- Idade: ${args.contextoPr.idadeDias} dias
- CI: ${args.contextoPr.estadoCi}
- Conflitos: ${args.contextoPr.conflitos ? 'Sim' : 'Não'}
- Arquivos: ${args.contextoPr.arquivosAlterados || 'Não informado'}
- Issue: ${args.contextoPr.issueLigada ? `#${args.contextoPr.issueLigada.numero} - ${args.contextoPr.issueLigada.titulo}` : 'Nenhuma'}
- Histórico GitOrch: ${args.contextoPr.historicoGitorch?.join(' | ') || 'Nenhum'}

Gere uma avaliação conforme o schema.`

  const result = await runFormStep({
    execute: args.execute,

    schema: prParadoSchema,
    prompt,
  })

  if (!result || typeof result !== 'object') {
    throw new Error('Falha ao gerar pergunta: schema inválido')
  }

  return result as {
    resumo_do_pr: string
    motivo_da_espera: string
    recomendacao_do_agente: string
    opcoes_sob_medida: Array<{ label: string; action: string }>
  }
}
