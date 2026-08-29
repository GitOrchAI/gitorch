// ESTEIRA-T8 (D54): entre o sensor e a delegação existe SEMPRE análise. O
// sensor (`incidente-ci.ts`) devolve um `AchadoDeInfra` tipado e com evidência;
// aqui o RA entende a CAUSA RAIZ e o PO escreve a issue padrão Shrimp (8 campos
// do DoD). Nunca "falhou → issue crua → Jules → loop".
//
// Dois passos de formulário, cada um uma execução curta do motor (o mesmo
// `StepExecutor` que os trilhos do RA/PO já usam):
//   1. runAnaliseCausaDeInfra  → RaCausaDeInfraForm
//   2. runIssuePadraoDeInfra   → DoDFields (a issue)

import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  validateDoD,
  type DoDFields,
  type RaCausaDeInfraForm,
  type InfraIssueForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import type { AchadoDeInfra } from './incidente-ci.js'

/** Bloco de contexto legível a partir de UM achado — evidência inclusa. */
export function blocoDoAchado(achado: AchadoDeInfra): string {
  return [
    `## Falha de infra detectada`,
    `- Classe: ${achado.classe}`,
    `- Identidade estável: ${achado.identidadeEstavel}`,
    `- Título: ${achado.titulo}`,
    `- Trava merge? ${achado.travaMerge ? 'sim' : 'não'}`,
    `- Arquivos: ${achado.paths.join(', ') || '(nenhum apontado)'}`,
    '',
    `### Evidência coletada pelo sensor`,
    achado.evidencia || '(sem evidência recuperada — a causa sai da leitura dos arquivos acima)',
  ].join('\n')
}

/**
 * Passo 1 — o RA entende a causa raiz da falha de infra. Um form-step; o
 * schema (`RAILS_SCHEMAS.raCausaDeInfra`) força os cinco campos.
 */
export async function runAnaliseCausaDeInfra(
  execute: StepExecutor,
  achado: AchadoDeInfra,
  contextBlocks: string[] = []
): Promise<RaCausaDeInfraForm> {
  const prompt = buildStepPrompt('ra', 'ra-causa-de-infra', RAILS_SCHEMAS.raCausaDeInfra, [
    ...contextBlocks,
    blocoDoAchado(achado),
    [
      'Entenda a CAUSA RAIZ desta falha — não repita a mensagem de erro, explique POR QUE ela acontece.',
      '- causaRaiz: a explicação técnica da raiz (config errada, comando obsoleto, credencial, dependência...).',
      '- arquivosAfetados: os caminhos REAIS a mexer (copie da evidência/lista acima, nunca invente).',
      '- criterioDeVerificacao: como um revisor confirma que sarou (comando, run verde, comportamento observável).',
      '- escopo: o que ESTÁ e o que NÃO está incluído — uma correção focada, nunca "de passagem arrumei X".',
      '- riscoDeRegressao: o que pode quebrar junto e como o PR se protege disso.',
    ].join('\n'),
  ])
  return (await runFormStep({
    schema: RAILS_SCHEMAS.raCausaDeInfra,
    prompt,
    execute,
  })) as RaCausaDeInfraForm
}

export interface EntradaDaIssueDeInfra {
  achado: AchadoDeInfra
  analise: RaCausaDeInfraForm
  /** Guia curado do dev assíncrono (memoria-do-jules.guiaCuradoDoJules). */
  guiaDoDev?: string
  /** Aprendizados do projeto sobre como o dev falha (memoria-do-jules). */
  aprendizados?: string
  /**
   * Este workflow é encanamento do GitOrch que ficou OBSOLETO — a função já é
   * feita pelo control-plane (decisão do dono 29/08: o auto-merge do Actions
   * sai, o merge agora é o veredito do QA + `gh pr merge`). A issue pede
   * REMOÇÃO, não conserto.
   */
  scaffoldingObsoleto?: boolean
}

/**
 * Passo 2 — o PO escreve a issue padrão Shrimp (8 campos do DoD) em cima do
 * brief do RA. Devolve `DoDFields` validado — o chamador cria a issue.
 */
export async function runIssuePadraoDeInfra(
  execute: StepExecutor,
  entrada: EntradaDaIssueDeInfra,
  contextBlocks: string[] = []
): Promise<DoDFields> {
  const { achado, analise } = entrada
  const objetivo = entrada.scaffoldingObsoleto
    ? 'Este workflow é encanamento do GitOrch que ficou OBSOLETO: a função já é feita pelo control-plane do GitOrch (o merge agora é o veredito do QA + `gh pr merge`; o Dependabot é orquestrado pelo pipeline RA→PO→SM→QA). A issue deve pedir a REMOÇÃO do workflow (e do que só existe para ele), NUNCA o conserto.'
    : achado.classe === 'scaffolding-do-gitorch'
      ? 'Este é um bridge de automação do GitOrch que está QUEBRADO mas ainda é necessário. A issue deve pedir o CONSERTO — reusar o bloco equivalente que já funciona em outro workflow do mesmo repo.'
      : 'Este é o CI/config do próprio cliente. A issue deve pedir o conserto focado, respeitando o escopo do RA.'

  const prompt = buildStepPrompt('po', 'po-issue-de-infra', RAILS_SCHEMAS.infraIssue, [
    ...contextBlocks,
    blocoDoAchado(achado),
    [
      '### Análise da causa (RA)',
      `- Causa raiz: ${analise.causaRaiz}`,
      `- Arquivos afetados: ${analise.arquivosAfetados}`,
      `- Critério de verificação: ${analise.criterioDeVerificacao}`,
      `- Escopo: ${analise.escopo}`,
      `- Risco de regressão: ${analise.riscoDeRegressao}`,
    ].join('\n'),
    ...(entrada.guiaDoDev ? [entrada.guiaDoDev] : []),
    ...(entrada.aprendizados ? [entrada.aprendizados] : []),
    objetivo,
    [
      'Escreva a issue padrão Shrimp em `fields` — os 8 campos do DoD, TODOS preenchidos, para um dev assíncrono que só terá o corpo da issue:',
      '- goal / taskDetails / taskDescription: o quê e por quê, em uma frase cada.',
      '- implementationGuide: passos NUMERADOS em nível de arquivo, cada um com a mudança de→para; cite o workflow equivalente a copiar quando houver.',
      '- verificationCriteria: o critério do RA, como checagem executável.',
      '- dependencies: "nenhuma" se não houver.',
      '- relatedFiles: os caminhos reais da análise, um por linha.',
      '- notes: escopo + risco de regressão do RA.',
    ].join('\n'),
  ])

  const form = (await runFormStep({
    schema: RAILS_SCHEMAS.infraIssue,
    prompt,
    execute,
  })) as InfraIssueForm

  const fields = form.fields
  const check = validateDoD(fields)
  if (!check.ok) {
    // O schema já garante presença; isto pega campo em branco. Re-perguntar
    // aqui seria repetir runFormStep — deixamos o erro subir (falha de motor,
    // o failover cuida) em vez de publicar uma issue oca.
    throw new Error(`issue de infra reprovada no DoD: ${check.errors.join('; ')}`)
  }
  return fields
}
