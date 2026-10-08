// Quando o recurso pago de varredura de senhas não existe no repositório
// (privado, sem Advanced Security), a alternativa gratuita é o MESMO gitleaks já
// rodando em .github/workflows/ci.yml deste repositório — nunca uma ferramenta
// nova. E, sem a proteção paga, o GUARDA do próprio GitOrch passa a exigir
// revisão antes de mesclar (nunca confia cegamente no repositório do cliente
// estar limpo).

/** Onde o workflow é gravado no repositório do cliente (sempre por pull request). */
export const CAMINHO_DO_WORKFLOW_DE_SENHAS = '.github/workflows/gitorch-varredura-de-senhas.yml'

/**
 * A versão do gitleaks é a MESMA de `GITLEAKS_VERSION` em
 * .github/workflows/ci.yml deste repositório: um teste compara os dois. Versão
 * pinada: build reproduzível, sem depender de Action de terceiro que exige
 * cadastro de organização.
 */
export const GITLEAKS_VERSION = '8.30.1'

/**
 * O commit de `actions/checkout` que o ci.yml deste repositório já usa. Toda
 * Action do arquivo gerado fica fixada por SHA completo: uma tag no arquivo
 * piora o próprio check "Actions fixadas por SHA" da nota de segurança.
 */
export const ACTION_CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'

/** Cópia adaptada do bloco real de ci.yml, com permissão mínima e Actions por SHA. */
export function workflowDeAlternativaGratuita(): string {
  return `name: Secret scan (GitOrch)
on: [pull_request, push]
permissions:
  contents: read
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${ACTION_CHECKOUT_SHA}
      - name: Secret scan
        env:
          GITLEAKS_VERSION: ${GITLEAKS_VERSION}
        run: |
          set -euo pipefail
          curl --retry 3 --retry-delay 5 -fsSL -o /tmp/gitleaks.tar.gz \\
            "https://github.com/gitleaks/gitleaks/releases/download/v\${{ env.GITLEAKS_VERSION }}/gitleaks_\${{ env.GITLEAKS_VERSION }}_linux_x64.tar.gz"
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          sudo install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks
          gitleaks version
          gitleaks detect --source . --redact --exit-code 1 \\
            --report-format sarif --report-path results.sarif
`
}

/** Sem a melhoria paga E sem a alternativa gratuita instalada: o guarda do
 *  GitOrch passa a EXIGIR revisão humana antes de mesclar neste repositório
 *  — nunca confia às cegas que o repositório do cliente está limpo. */
export function exigeRevisaoSemAlternativa(deps: {
  planoPermite: boolean
  alternativaInstalada: boolean
}): boolean {
  return !deps.planoPermite && !deps.alternativaInstalada
}
