// Fase 5.5: quando o plano do GitHub não permite a melhoria paga (Fase 5.4),
// a alternativa gratuita é o MESMO gitleaks já rodando em
// .github/workflows/ci.yml deste repositório (linha 97-114) — nunca uma
// ferramenta nova. E, sem a proteção paga, o GUARDA do próprio GitOrch passa
// a exigir revisão antes de mesclar (nunca confia cegamente no repositório
// do cliente estar limpo).

/** Cópia adaptada do bloco real de .github/workflows/ci.yml deste
 *  repositório — versão do gitleaks pinada, mesmo motivo (build
 *  reprodutível, sem depender de Action de terceiro que exige cadastro de
 *  organização). Ao propor, sempre conferir se a versão ainda é a mais
 *  recente que o próprio ci.yml usa — copiar sem atualizar duplicaria a
 *  manutenção. */
export function workflowDeAlternativaGratuita(): string {
  return `name: Secret scan (GitOrch)
on: [pull_request, push]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Secret scan
        env:
          GITLEAKS_VERSION: 8.30.1
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
