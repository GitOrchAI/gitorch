// Fase 5.6: conformidade — licenças de dependência, PII heurística em
// schema/migrations, documentos ausentes (CODEOWNERS/SECURITY.md,
// reaproveitados de coletarChecksDeSeguranca, Tarefa 5.1) e Actions fixadas
// por versão (idem). As duas checagens NOVAS desta tarefa são licença e PII.

/** Copyleft forte (GPL/AGPL e variantes) é o que costuma exigir avaliação
 *  jurídica antes de embarcar num produto fechado — a lista É configurável
 *  (parâmetro), nunca hardcoded como verdade universal: cada empresa tem sua
 *  própria política de licença. */
export function licencasProblematicas(
  licencas: Array<{ nome: string; licenca: string }>,
  listaNegra: string[]
): Array<{ nome: string; licenca: string }> {
  const negra = new Set(listaNegra)
  return licencas.filter((l) => negra.has(l.licenca))
}

/** Padrões HEURÍSTICOS — nunca prova de PII real, só sinal para revisão
 *  humana. Falso positivo (nome de coluna "email" numa tabela sem dado real
 *  ainda) é aceitável; falso negativo silencioso não. */
const PADROES_DE_PII: ReadonlyArray<{ nome: string; regex: RegExp }> = [
  { nome: 'cpf', regex: /\bcpf\b/i },
  { nome: 'e-mail', regex: /\bemail\b/i },
  { nome: 'telefone', regex: /\btelefone\b|\bphone\b/i },
  { nome: 'cnpj', regex: /\bcnpj\b/i },
  { nome: 'endereço', regex: /\bendereco\b|\baddress\b/i },
]

export function achadosDePii(conteudo: string): string[] {
  return PADROES_DE_PII.filter((p) => p.regex.test(conteudo)).map(
    (p) =>
      `possível campo de ${p.nome} — confirme se há dado pessoal real e se o tratamento (LGPD) está documentado`
  )
}

export interface ListarLicencas {
  (): Promise<Array<{ nome: string; licenca: string }>>
}

export interface ResultadoDeConformidade {
  licencasProblematicas: Array<{ nome: string; licenca: string }>
  achadosDePii: string[]
  codeownersAusente: boolean
  securityMdAusente: boolean
  actionsSemSha: boolean
}

export async function conferirConformidade(deps: {
  listarLicencas: ListarLicencas
  listaNegraDeLicenca: string[]
  conteudoDeSchemaEMigracoes: string
  codeownersAusente: boolean
  securityMdAusente: boolean
  actionsSemSha: boolean
}): Promise<ResultadoDeConformidade> {
  const licencas = await deps.listarLicencas()
  return {
    licencasProblematicas: licencasProblematicas(licencas, deps.listaNegraDeLicenca),
    achadosDePii: achadosDePii(deps.conteudoDeSchemaEMigracoes),
    codeownersAusente: deps.codeownersAusente,
    securityMdAusente: deps.securityMdAusente,
    actionsSemSha: deps.actionsSemSha,
  }
}

/** `listarLicencas` de produção: roda `pnpm licenses list --json` no
 *  workspace do repositório do cliente (comando nativo do pnpm — CONFIRMADO
 *  disponível, sem dependência nova) e normaliza a saída. Best-effort: uma
 *  falha do comando devolve lista vazia, nunca derruba a varredura de
 *  conformidade inteira. */
export function listarLicencasViaPnpm(cwd: string): ListarLicencas {
  return () =>
    new Promise((resolve) => {
      const { execFile } = require('node:child_process') as typeof import('node:child_process')
      execFile('pnpm', ['licenses', 'list', '--json'], { cwd }, (err, stdout) => {
        if (err) return resolve([])
        try {
          const bruto = JSON.parse(stdout) as Record<string, Array<{ name?: string }>>
          const saida: Array<{ nome: string; licenca: string }> = []
          for (const [licenca, pacotes] of Object.entries(bruto)) {
            for (const pacote of pacotes) {
              if (pacote.name) saida.push({ nome: pacote.name, licenca })
            }
          }
          resolve(saida)
        } catch {
          resolve([])
        }
      })
    })
}
