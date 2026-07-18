import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planFromSearch, resolvePlan, PLAN_STORAGE_KEY, VALID_PLANS } from './plan-persistence'

// O bug real (18/07): quem entrava no wizard com ?plan=pro (vindo da landing),
// logava com GitHub, e voltava do OAuth como 'free' — o passo de confirmação
// de plano nunca sabia que a pessoa já tinha escolhido pagar. A causa: nada no
// front nem no backend carregava o plano através do round-trip do OAuth (uma
// navegação de página inteira, não SPA — todo estado em memória morre).
//
// Este arquivo protege a função pura que decide o plano ativo: URL sempre
// manda (é o sinal mais recente — inclusive o que a API devolve no redirect
// pós-login); sessionStorage é o fallback para quando a URL de volta não
// carrega a query por algum motivo; 'free' é o piso seguro.

describe('planFromSearch — extrai e valida ?plan= de uma querystring', () => {
  it('aceita os quatro planos válidos', () => {
    for (const plan of VALID_PLANS) {
      expect(planFromSearch(`?plan=${plan}`)).toBe(plan)
    }
  })

  it('sem ?plan= -> null', () => {
    expect(planFromSearch('')).toBeNull()
    expect(planFromSearch('?other=1')).toBeNull()
  })

  it('plano inválido/lixo -> null (nunca propaga um valor não reconhecido)', () => {
    expect(planFromSearch('?plan=hackerman')).toBeNull()
    expect(planFromSearch('?plan=')).toBeNull()
    expect(planFromSearch('?plan=PRO')).toBeNull() // case-sensitive, de propósito
  })

  it('funciona com ou sem o "?" inicial', () => {
    expect(planFromSearch('plan=pro')).toBe('pro')
  })
})

describe('resolvePlan — prioridade URL > sessionStorage > free', () => {
  it('URL presente e válida sempre vence, mesmo com storage divergente', () => {
    expect(resolvePlan('?plan=pro', 'team')).toBe('pro')
  })

  it('sem URL, cai no valor persistido (o caso que fechava o bug: a volta do OAuth)', () => {
    expect(resolvePlan('', 'pro')).toBe('pro')
    expect(resolvePlan('?other=1', 'team')).toBe('team')
  })

  it('sem URL e sem storage válido -> free', () => {
    expect(resolvePlan('', null)).toBe('free')
    expect(resolvePlan('', 'lixo-invalido')).toBe('free')
  })

  it('URL inválida cai para o storage, não trava em lixo', () => {
    expect(resolvePlan('?plan=hackerman', 'solo')).toBe('solo')
  })

  it('URL inválida e storage inválido -> free', () => {
    expect(resolvePlan('?plan=hackerman', 'lixo')).toBe('free')
  })
})

describe('PLAN_STORAGE_KEY — chave estável do sessionStorage', () => {
  it('é a chave combinada com o backend/plano da landing', () => {
    expect(PLAN_STORAGE_KEY).toBe('gitorch_plan')
  })
})

// Guarda ARQUITETURAL: o app web não tem jsdom/testing-library (decisão
// registrada em engine-status.ts), então o que precisa de teste sobre o
// COMPONENTE mora aqui, lendo o source real — mesmo padrão usado em
// submit-flow.test.ts pra proteger StepPlanConfirmation/StepReady.
describe('guarda: page.tsx re-lê o plano pós-mount e persiste em sessionStorage', () => {
  const source = (path: string): string =>
    readFileSync(new URL(`../../app/${path}`, import.meta.url), 'utf8')

  it('usa resolvePlan (URL > sessionStorage > free), não mais um parse solto', () => {
    const page = source('setup/page.tsx')
    expect(page).toContain("from '../../components/setup/plan-persistence'")
    expect(page).toContain('resolvePlan(')
    expect(page).toContain('PLAN_STORAGE_KEY')
  })

  it('persiste toda mudança de plano em sessionStorage (fallback pra volta do OAuth)', () => {
    const page = source('setup/page.tsx')
    expect(page).toContain('sessionStorage.setItem(PLAN_STORAGE_KEY, plan)')
  })

  it('StepGitHubLogin recebe o plano atual — é o que o backend carrega no state do OAuth', () => {
    const page = source('setup/page.tsx')
    expect(page).toContain('<StepGitHubLogin apiBaseUrl={API_BASE_URL} plan={plan} />')
  })
})
