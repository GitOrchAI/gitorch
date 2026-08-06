// Link de instalação do GitHub App — lógica pura, fora do React (mesma decisão
// de telegram-link.ts/plan-persistence.ts: o app web não tem jsdom/testing-
// library, então o que precisa de teste mora aqui).
//
// Achado real em produção: o dono registrou um repositório de ORGANIZAÇÃO e o
// produto não conseguiu criar quadro nem issues, porque o GitHub App nunca
// tinha sido instalado NA organização — só existia o login OAuth clássico
// (StepGitHubLogin), que autoriza a CONTA PESSOAL de quem loga. A instalação
// do App vale para a conta DONA do repositório: instalar na conta pessoal não
// dá acesso a repositório de organização nenhuma. `users.github_installation_id`
// ficava sempre vazio, e o passo de seleção de repositórios não oferecia
// nenhum jeito de resolver isso.

export interface InstallAppUrlInput {
  apiBaseUrl: string
  /** `window.location.href` no momento do clique. */
  currentHref: string
}

/**
 * Monta a URL de `GET /api/v1/auth/github/install` (routes/github-app-install.ts)
 * a partir da location atual. `return_to` é tudo antes de "/setup" na URL
 * atual — a MESMA lógica que StepGitHubLogin.tsx já usa para o login (nunca
 * uma string fixa: o wizard roda tanto no site publicado quanto servido pela
 * própria API, same-origin). O backend valida esse valor contra uma
 * allowlist antes de redirecionar de volta (defesa contra open redirect).
 */
export function buildInstallAppUrl({ apiBaseUrl, currentHref }: InstallAppUrlInput): string {
  const base = currentHref.split('/setup')[0]
  const returnTo = encodeURIComponent(base)
  return `${apiBaseUrl}/api/v1/auth/github/install?return_to=${returnTo}`
}
