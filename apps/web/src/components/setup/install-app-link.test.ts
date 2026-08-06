import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildInstallAppUrl } from './install-app-link'
import { locales } from '../../locales'

// Achado real em produção (dono registrou um repositório de ORGANIZAÇÃO): o
// GitHub App vale para a conta DONA do repositório, e a instalação pessoal do
// dono não dá acesso a repositório de organização nenhuma. O funil nunca
// oferecia instalar o App — só o login OAuth clássico (StepGitHubLogin) — e o
// passo de seleção de repositórios (StepSelectRepos) não tinha como a pessoa
// resolver isso sozinha. `users.github_installation_id` ficava sempre vazio.
//
// A lógica de montar a URL de instalação é pura, fora do React (mesma decisão
// de telegram-link.ts/plan-persistence.ts: o app web não tem jsdom/testing-
// library). Espelha EXATAMENTE a base que StepGitHubLogin.tsx já usa
// (`href.split('/setup')[0]`) — nunca uma string fixa, porque o wizard roda
// tanto no site publicado quanto servido pela própria API (same-origin).

describe('buildInstallAppUrl — mesma base de retorno que o login já usa', () => {
  it('monta a URL de instalação com return_to = tudo antes de /setup', () => {
    const url = buildInstallAppUrl({
      apiBaseUrl: 'https://api.gitorch.test',
      currentHref: 'https://app.gitorch.test/setup',
    })
    expect(url).toBe(
      'https://api.gitorch.test/api/v1/auth/github/install?return_to=' +
        encodeURIComponent('https://app.gitorch.test')
    )
  })

  it('corta a partir de /setup mesmo com passo/querystring depois (ex.: ?step=5)', () => {
    const url = buildInstallAppUrl({
      apiBaseUrl: 'https://api.gitorch.test',
      currentHref: 'https://app.gitorch.test/setup?step=5',
    })
    expect(url).toBe(
      'https://api.gitorch.test/api/v1/auth/github/install?return_to=' +
        encodeURIComponent('https://app.gitorch.test')
    )
  })

  it('NUNCA usa string fixa — a base acompanha a origem real (API same-origin)', () => {
    const url = buildInstallAppUrl({
      apiBaseUrl: 'https://api.gitorch.test',
      currentHref: 'https://api.gitorch.test/setup',
    })
    expect(url).toBe(
      'https://api.gitorch.test/api/v1/auth/github/install?return_to=' +
        encodeURIComponent('https://api.gitorch.test')
    )
  })

  it('aponta para a rota real do backend (routes/github-app-install.ts)', () => {
    const url = buildInstallAppUrl({
      apiBaseUrl: 'https://api.gitorch.test',
      currentHref: 'https://app.gitorch.test/setup',
    })
    expect(url.startsWith('https://api.gitorch.test/api/v1/auth/github/install?')).toBe(true)
  })
})

describe('pt, en e es têm o botão e a explicação de instalar o App preenchidos', () => {
  it('reposInstallApp e reposInstallAppHint existem nas 3 traduções', () => {
    for (const lang of ['pt', 'en', 'es'] as const) {
      const setup = locales[lang].setup as Record<string, string>
      expect(setup.reposInstallApp, `${lang}.reposInstallApp`).toBeTruthy()
      expect(setup.reposInstallAppHint, `${lang}.reposInstallAppHint`).toBeTruthy()
    }
  })
})

describe('guarda: StepSelectRepos oferece o botão de instalar com a explicação em cima', () => {
  it('usa buildInstallAppUrl e mostra a explicação (hint) antes do botão de instalar', () => {
    const step = readFileSync(new URL('./StepSelectRepos.tsx', import.meta.url), 'utf8')
    expect(step).toMatch(/buildInstallAppUrl/)
    const hintIdx = step.indexOf("t('setup.reposInstallAppHint')")
    const buttonIdx = step.indexOf('onClick={handleInstallApp}')
    expect(hintIdx).toBeGreaterThan(-1)
    expect(buttonIdx).toBeGreaterThan(-1)
    expect(hintIdx).toBeLessThan(buttonIdx)
  })
})
