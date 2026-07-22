import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { locales } from '../../locales'
import {
  isPaidPlan,
  parseCreatedProjects,
  startCheckout,
  submitSetup,
  type CreatedProject,
  type HttpResponse,
} from './submit-flow'

// A PROMESSA QUE ESTE ARQUIVO PROTEGE: quem paga NUNCA perde a chave de API.
//
// A chave em texto puro existe UMA ÚNICA vez no universo — no corpo da resposta
// de POST /api/v1/setup/submit. No banco só fica o bcrypt hash dela
// (apps/control-plane/src/routes/setup.ts). Se o cliente for jogado pro Stripe
// antes de ver a tela que renderiza a chave, ela morre ali: não existe rota,
// consulta ou suporte que a traga de volta.
//
// Era exatamente isso que acontecia: o passo de confirmação redirecionava pro
// Stripe (`window.location.href = ...; return`) logo depois do submit, pulando o
// StepReady — o único lugar que mostra a chave. Só quem escolhia o plano GRÁTIS
// via a credencial. Quem PAGAVA, não.

const RAW_KEY = 'gk_live_chave_secreta_do_cliente_1234567890'

const PROJECTS: CreatedProject[] = [
  { id: 'proj_1', name: 'app', wingId: 'wing-1', apiKey: RAW_KEY },
]

interface RecordedRequest {
  url: string
  body: string
}

// Fetcher de mentira que GRAVA tudo o que passou por ele. É o que permite provar
// (e não só afirmar) que a chave nunca vaza numa URL/query string nem num corpo
// de requisição para terceiros.
function recorder(routes: Record<string, () => HttpResponse | Promise<HttpResponse>>) {
  const seen: RecordedRequest[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<HttpResponse> => {
    seen.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    const route = Object.keys(routes).find((r) => url.includes(r))
    if (!route) throw new Error(`rota inesperada: ${url}`)
    return routes[route]!()
  }
  return { seen, fetchImpl }
}

function jsonResponse(status: number, payload: unknown): HttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

const SUBMIT_INPUT = {
  apiBaseUrl: 'https://api.example',
  repos: ['dono/app'],
  engines: ['claude-code'],
}

describe('submitSetup — a chave chega a quem pediu, pago ou grátis', () => {
  it('plano PAGO: devolve a chave e não navega pra lugar nenhum', async () => {
    const { seen, fetchImpl } = recorder({
      '/api/v1/setup/submit': () => jsonResponse(200, { projects: PROJECTS }),
    })

    const projects = await submitSetup(
      { ...SUBMIT_INPUT, plan: 'pro' },
      { fetchImpl, fallbackError: 'falhou' }
    )

    // A chave voltou pra quem vai renderizá-la (memória do React), intacta.
    expect(projects).toEqual(PROJECTS)
    expect(projects[0]?.apiKey).toBe(RAW_KEY)
    // E o submit NÃO chamou o checkout: pagar é um passo posterior, DEPOIS da
    // chave na tela. Esta asserção é a regressão que quebrou o cliente pagante.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain('/api/v1/setup/submit')
    expect(seen.some((r) => r.url.includes('checkout'))).toBe(false)
  })

  it('plano GRÁTIS: continua devolvendo a chave (sem regressão)', async () => {
    const { seen, fetchImpl } = recorder({
      '/api/v1/setup/submit': () => jsonResponse(200, { projects: PROJECTS }),
    })

    const projects = await submitSetup(
      { ...SUBMIT_INPUT, plan: 'free' },
      { fetchImpl, fallbackError: 'falhou' }
    )

    expect(projects[0]?.apiKey).toBe(RAW_KEY)
    expect(seen).toHaveLength(1)
  })

  it('erro do backend vira a causa REAL, não um sucesso de fachada', async () => {
    const { fetchImpl } = recorder({
      '/api/v1/setup/submit': () => jsonResponse(422, { error: 'repositório já vinculado' }),
    })

    await expect(
      submitSetup({ ...SUBMIT_INPUT, plan: 'pro' }, { fetchImpl, fallbackError: 'falhou' })
    ).rejects.toThrow('repositório já vinculado')
  })

  it('sucesso sem projeto nenhum é falha, não festa: não existe "pronto" sem chave', async () => {
    const { fetchImpl } = recorder({
      '/api/v1/setup/submit': () => jsonResponse(200, { projects: [] }),
    })

    await expect(
      submitSetup({ ...SUBMIT_INPUT, plan: 'pro' }, { fetchImpl, fallbackError: 'falhou' })
    ).rejects.toThrow('falhou')
  })
})

describe('startCheckout — o pagamento vem DEPOIS, e nunca carrega a chave', () => {
  it('devolve a URL do Stripe sem jamais tocar na credencial do cliente', async () => {
    const { seen, fetchImpl } = recorder({
      '/api/billing/checkout': () =>
        jsonResponse(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_123', tier: 'A' }),
    })

    const outcome = await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: 'BR' },
      { fetchImpl }
    )

    expect(outcome).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_123' })
    expect(seen[0]?.url).toContain('country=BR')
    // A assinatura de startCheckout nem recebe a chave — mas o contrato tem que
    // ficar provado, não subentendido.
    expect(seen.every((r) => !r.url.includes(RAW_KEY) && !r.body.includes(RAW_KEY))).toBe(true)
  })

  it('sem país detectado, nada de query string pendurada', async () => {
    const { seen, fetchImpl } = recorder({
      '/api/billing/checkout': () => jsonResponse(200, { url: 'https://checkout.stripe.com/x' }),
    })

    await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: undefined },
      { fetchImpl }
    )

    expect(seen[0]?.url).toBe('https://api.example/api/billing/checkout')
  })

  it('infra no teto (402) é dito na cara, não engolido', async () => {
    const { fetchImpl } = recorder({
      '/api/billing/checkout': () =>
        jsonResponse(402, { error: 'at_capacity', action: 'waitlist' }),
    })

    const outcome = await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: 'BR' },
      { fetchImpl }
    )

    expect(outcome).toEqual({ ok: false, reason: 'at_capacity' })
  })

  it('checkout fora do ar vira falha honesta (e o cliente segue com a chave e o projeto)', async () => {
    const { fetchImpl } = recorder({
      '/api/billing/checkout': () => {
        throw new Error('rede caiu')
      },
    })

    const outcome = await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: 'BR' },
      { fetchImpl }
    )

    expect(outcome).toEqual({ ok: false, reason: 'failed' })
  })

  it('resposta 200 sem URL não vira redirect pra lugar nenhum', async () => {
    const { fetchImpl } = recorder({
      '/api/billing/checkout': () => jsonResponse(200, { tier: 'A' }),
    })

    const outcome = await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: 'BR' },
      { fetchImpl }
    )

    expect(outcome).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('a chave é segredo: não vaza em URL, query string nem corpo de requisição', () => {
  it('o funil inteiro (submit + checkout) nunca escreve a chave numa requisição', async () => {
    const { seen, fetchImpl } = recorder({
      '/api/v1/setup/submit': () => jsonResponse(200, { projects: PROJECTS }),
      '/api/billing/checkout': () => jsonResponse(200, { url: 'https://checkout.stripe.com/x' }),
    })

    const projects = await submitSetup(
      { ...SUBMIT_INPUT, plan: 'pro' },
      { fetchImpl, fallbackError: 'falhou' }
    )
    const outcome = await startCheckout(
      { apiBaseUrl: 'https://api.example', plan: 'pro', country: 'BR' },
      { fetchImpl }
    )

    expect(projects[0]?.apiKey).toBe(RAW_KEY)
    expect(outcome.ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    for (const req of seen) {
      // Histórico do navegador, logs de servidor e header Referer enviado ao
      // Stripe: tudo que entra numa URL vaza. A chave não entra em nenhuma.
      expect(req.url).not.toContain(RAW_KEY)
      expect(req.url).not.toContain('apiKey')
      expect(req.body).not.toContain(RAW_KEY)
    }
    // E o destino do redirect é exatamente o que o backend mandou — sem nada
    // nosso pendurado atrás.
    expect(outcome.ok && outcome.url).toBe('https://checkout.stripe.com/x')
  })
})

describe('isPaidPlan — a bifurcação que derrubou o cliente pagante', () => {
  it('free (e vazio) não paga; solo/pro/team pagam', () => {
    expect(isPaidPlan('free')).toBe(false)
    expect(isPaidPlan('')).toBe(false)
    expect(isPaidPlan('FREE')).toBe(false)
    expect(isPaidPlan('solo')).toBe(true)
    expect(isPaidPlan('pro')).toBe(true)
    expect(isPaidPlan('team')).toBe(true)
  })
})

describe('parseCreatedProjects — payload torto não vira tela quebrada', () => {
  it('descarta o que não é projeto com chave', () => {
    expect(parseCreatedProjects({ projects: PROJECTS })).toEqual(PROJECTS)
    expect(parseCreatedProjects({ projects: [{ id: 'x' }] })).toEqual([])
    expect(parseCreatedProjects({ projects: 'nada' })).toEqual([])
    expect(parseCreatedProjects(null)).toEqual([])
    expect(parseCreatedProjects(undefined)).toEqual([])
  })
})

// ── Guardas ARQUITETURAIS ────────────────────────────────────────────────────
// O app web não tem jsdom/testing-library (decisão registrada em engine-status.ts),
// então a lógica testável vive fora do React. Estas duas guardas fecham o buraco
// que sobra: garantem que o COMPONENTE não reintroduza o redirect prematuro que
// custava a chave do cliente. É a regressão real — barata de checar, cara de
// descobrir em produção.
describe('guarda: o passo de confirmação não pode levar ninguém embora', () => {
  const source = (file: string): string =>
    readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

  it('StepPlanConfirmation nunca navega o navegador (era aí que a chave morria)', () => {
    const step = source('StepPlanConfirmation.tsx')
    expect(step).not.toContain('window.location')
    expect(step).not.toContain('billing/checkout')
  })

  it('StepReady mostra a chave e avisa que é a ÚNICA vez', () => {
    const ready = source('StepReady.tsx')
    expect(ready).toContain('setup.readyKeyOnce')
    expect(ready).toContain('apiKey')
  })
})

describe('guarda: o aviso de "única exibição" existe nos três idiomas', () => {
  // Um cliente que lê em espanhol tem o mesmo direito de saber que a chave não
  // volta. Aviso sem tradução é aviso que não existe pra metade do mundo.
  const NEW_KEYS = [
    'readyKeyOnce',
    'readyKeySaved',
    'readyKeyCopy',
    'readyLockedHint',
    'readyGoPay',
    'readyPaying',
    'readyPayFailed',
    'readyPayCapacity',
    'confirmPayNext',
  ]

  it('pt, en e es têm todas as chaves novas do fechamento', () => {
    for (const lang of ['pt', 'en', 'es'] as const) {
      const setup = locales[lang].setup as Record<string, string>
      for (const key of NEW_KEYS) {
        expect(setup[key], `${lang}.setup.${key}`).toBeTruthy()
      }
    }
  })
})
