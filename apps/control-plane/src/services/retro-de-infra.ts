// ESTEIRA-T10 (decisão do dono 29/08): quando um incidente de infra resiste a
// 3 PRs, o GitOrch PARA de insistir e roda um RETRO entre os papéis — não para
// culpar, para CONSERTAR o processo. A pergunta: a issue do PO faltou algo? a
// análise do RA foi rasa? o critério do QA foi vago? a tarefa era grande
// demais? A conclusão vira aprendizado (memoria-do-jules) E uma regra de
// coding que o Jules passa a receber no topo do pedido.
//
// Um passo de formulário só — o motor entende, o sistema aplica.

import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import type { MiniSchema } from '@gitorch/cadence'

/** As raízes possíveis do retrabalho — quem/o quê ajustar. */
export type RaizDoRetrabalho =
  | 'po-issue-incompleta'
  | 'ra-analise-rasa'
  | 'qa-criterio-vago'
  | 'tarefa-grande-demais'
  | 'limite-do-dev-assincrono'

export interface PrFracassado {
  numero: number
  /** Por que fracassou: 'ci-vermelho' | 'fechado-sem-merge' | 'qa-reprovou'. */
  motivo: string
  /** Trecho do log de CI ou do comentário de reprovação do QA. */
  evidencia: string
}

export interface EntradaDoRetro {
  issueNumber: number
  tituloDaIssue: string
  corpoDaIssue: string
  /** O brief do RA sobre a causa de infra (raCausaDeInfra), se houver. */
  briefDoRa: string
  prsFracassados: PrFracassado[]
}

export interface ResultadoDoRetro {
  raizDoRetrabalho: RaizDoRetrabalho
  /** O que mudar no processo (issue mais completa, análise mais funda...). */
  ajusteRecomendado: string
  /** Uma regra de coding para colar no topo do próximo pedido ao dev. */
  regraDeCodingParaODev: string
  /** Uma frase curta de padrão para a memória dos agentes. */
  padraoParaMemoria: string
}

export const SCHEMA_RETRO_DE_INFRA: MiniSchema = {
  type: 'object',
  required: ['raizDoRetrabalho', 'ajusteRecomendado', 'regraDeCodingParaODev', 'padraoParaMemoria'],
  properties: {
    raizDoRetrabalho: {
      type: 'string',
      enum: [
        'po-issue-incompleta',
        'ra-analise-rasa',
        'qa-criterio-vago',
        'tarefa-grande-demais',
        'limite-do-dev-assincrono',
      ],
    },
    ajusteRecomendado: { type: 'string' },
    regraDeCodingParaODev: { type: 'string' },
    padraoParaMemoria: { type: 'string' },
  },
}

/** Monta o prompt do passo de retro. Pura — sem rede. */
export function montarPromptDoRetro(e: EntradaDoRetro): string[] {
  return [
    `## Retro do incidente #${e.issueNumber}: ${e.tituloDaIssue}`,
    'Três PRs seguidos fracassaram em resolver a MESMA causa. Não é entrega ruim — é o processo que não preparou bem o trabalho. Encontre a raiz.',
    '',
    `### O corpo da issue (o que o PO escreveu)\n${e.corpoDaIssue.slice(0, 2000)}`,
    '',
    e.briefDoRa
      ? `### A análise do RA\n${e.briefDoRa.slice(0, 1500)}`
      : '### A análise do RA\n(não houve)',
    '',
    `### Os 3 PRs que fracassaram`,
    ...e.prsFracassados.map((p) => `- PR #${p.numero} (${p.motivo}): ${p.evidencia.slice(0, 500)}`),
    '',
    [
      'Decida:',
      '- raizDoRetrabalho: onde o processo falhou (po-issue-incompleta | ra-analise-rasa | qa-criterio-vago | tarefa-grande-demais | limite-do-dev-assincrono).',
      '- ajusteRecomendado: o que o PO/RA/QA passam a fazer diferente para esta CLASSE de problema.',
      '- regraDeCodingParaODev: UMA frase objetiva para colar no topo do próximo pedido ao dev assíncrono (estilo jules-awesome-list — ex.: "sempre rode o lint do repo antes de abrir o PR"; "não misture migração com lógica no mesmo PR").',
      '- padraoParaMemoria: uma frase curta para a memória dos agentes.',
    ].join('\n'),
  ]
}

export async function runRetroDeInfra(
  execute: StepExecutor,
  entrada: EntradaDoRetro,
  contextBlocks: string[] = []
): Promise<ResultadoDoRetro> {
  const prompt = [
    'You are the GitOrch agents running a blameless retro on a repeatedly-failed infra fix.',
    'Reply ONLY with a single JSON object matching this schema (no prose, no fences):',
    JSON.stringify(SCHEMA_RETRO_DE_INFRA, null, 2),
    '',
    ...contextBlocks.map((b) => `---\n${b}`),
    '---',
    ...montarPromptDoRetro(entrada),
  ].join('\n')
  return (await runFormStep({ schema: SCHEMA_RETRO_DE_INFRA, prompt, execute })) as ResultadoDoRetro
}
