// Os interruptores da aplicação das melhorias de segurança: um geral, um por
// peça e a lista de projetos que podem receber.
//
// Tudo vem LIGADO por padrão (decisão do dono); as variáveis existem para
// desligar uma peça, ou restringir a poucos projetos, sem deploy. Só um valor
// explícito de "desligado" desliga: texto vazio ou desconhecido não desliga
// nada por engano. A exceção é a lista de projetos: definida e vazia não libera
// ninguém, porque a falha segura de uma lista que restringe é não escrever.

/** As peças que escrevem no repositório do cliente. */
export const MELHORIAS_DE_SEGURANCA = [
  'alertas-de-dependencias',
  'atualizacoes-de-seguranca',
  'varredura-de-senhas',
  'varredura-de-codigo',
  'alternativa-de-varredura-de-senhas',
  'permissoes-minimas-dos-workflows',
  'permissao-padrao-do-workflow',
] as const

export type MelhoriaDeSeguranca = (typeof MELHORIAS_DE_SEGURANCA)[number]

export const INTERRUPTOR_GERAL_DA_SEGURANCA = 'GITORCH_APLICAR_SEGURANCA'
export const INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA = 'GITORCH_APLICAR_SEGURANCA_EM'

export const INTERRUPTOR_POR_MELHORIA: Record<MelhoriaDeSeguranca, string> = {
  'alertas-de-dependencias': 'GITORCH_APLICAR_SEGURANCA_ALERTAS',
  'atualizacoes-de-seguranca': 'GITORCH_APLICAR_SEGURANCA_ATUALIZACOES',
  'varredura-de-senhas': 'GITORCH_APLICAR_SEGURANCA_SENHAS',
  'varredura-de-codigo': 'GITORCH_APLICAR_SEGURANCA_CODIGO',
  'alternativa-de-varredura-de-senhas': 'GITORCH_APLICAR_SEGURANCA_ALTERNATIVA',
  'permissoes-minimas-dos-workflows': 'GITORCH_APLICAR_SEGURANCA_PERMISSOES',
  'permissao-padrao-do-workflow': 'GITORCH_APLICAR_SEGURANCA_PERMISSAO_PADRAO',
}

export type Ambiente = Readonly<Record<string, string | undefined>>

const VALORES_QUE_DESLIGAM: ReadonlySet<string> = new Set([
  '0',
  'false',
  'off',
  'nao',
  'não',
  'desligado',
])

function desligadoPor(env: Ambiente, nome: string): boolean {
  const bruto = env[nome]?.trim().toLowerCase()
  return bruto !== undefined && VALORES_QUE_DESLIGAM.has(bruto)
}

/** A peça-mãe de um identificador: `peça` ou `peça:caminho`. `null` se não for de nenhuma. */
export function idBaseDaMelhoria(id: string): MelhoriaDeSeguranca | null {
  const base = id.split(':', 1)[0] ?? ''
  return (MELHORIAS_DE_SEGURANCA as readonly string[]).includes(base)
    ? (base as MelhoriaDeSeguranca)
    : null
}

/** O interruptor geral está ligado? */
export function aplicacaoDeSegurancaLigada(env: Ambiente = process.env): boolean {
  return !desligadoPor(env, INTERRUPTOR_GERAL_DA_SEGURANCA)
}

/** O interruptor geral e o da peça estão ligados? */
export function melhoriaDeSegurancaLigada(
  melhoria: MelhoriaDeSeguranca,
  env: Ambiente = process.env
): boolean {
  return (
    !desligadoPor(env, INTERRUPTOR_GERAL_DA_SEGURANCA) &&
    !desligadoPor(env, INTERRUPTOR_POR_MELHORIA[melhoria])
  )
}

/**
 * O projeto pode receber? Sem a variável vale `todos`. Com ela, a lista de ids
 * de projeto ou de `dono/repo` (sem diferenciar caixa); `todos` libera todos; a
 * comparação é exata.
 */
export function projetoNaAllowlistDaSeguranca(
  projeto: { id: string; wingId: string },
  env: Ambiente = process.env
): boolean {
  const bruto = env[INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]
  if (bruto === undefined) return true
  const itens = bruto
    .split(',')
    .map((i) => i.trim().toLowerCase())
    .filter((i) => i !== '')
  if (itens.includes('todos')) return true
  return itens.includes(projeto.id.toLowerCase()) || itens.includes(projeto.wingId.toLowerCase())
}
