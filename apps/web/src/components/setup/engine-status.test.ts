import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  normalizeModelNames,
  hasClaudeUsageData,
  formatClaudeUsage,
  parseTokenResponse,
  normalizeLoginState,
  classifyConnectError,
  connectErrorHintKey,
  parseSetupStatus,
  formatEngineVersions,
  isProvisionTerminal,
  isManualAccordionVisible,
  looksLikeAuthCode,
} from './engine-status'

const CLAUDE_USAGE_LABELS = { session: 'Session', week: 'Week', used: 'used', resets: 'resets' }

// 20/07: substitui o antigo `modelCount`, que reduzia a lista de modelos a um
// NÚMERO — o dono reclamou direto ("mostra os modelos? mostra as quotas?"):
// o backend já manda os nomes reais (engine-connection.ts), só o front jogava
// fora. Agora o valor normalizado é a lista de nomes, não a contagem.
describe('normalizeModelNames', () => {
  it('lista de strings passa direto (é a lista real que o backend manda)', () => {
    expect(normalizeModelNames(['gpt-5', 'gpt-5-mini', 'o4'])).toEqual([
      'gpt-5',
      'gpt-5-mini',
      'o4',
    ])
  })

  it('lista vazia continua vazia (motor conectou mas não expôs catálogo ainda)', () => {
    expect(normalizeModelNames([])).toEqual([])
  })

  it('filtra entradas que não são string (payload malformado não quebra a UI)', () => {
    expect(normalizeModelNames(['gpt-5', 42, null, 'o4'])).toEqual(['gpt-5', 'o4'])
  })

  it('undefined/null/número/string -> undefined (não é uma lista, não renderiza a linha)', () => {
    expect(normalizeModelNames(undefined)).toBeUndefined()
    expect(normalizeModelNames(null)).toBeUndefined()
    expect(normalizeModelNames(7)).toBeUndefined()
    expect(normalizeModelNames('gpt-5')).toBeUndefined()
  })
})

describe('parseTokenResponse', () => {
  const fallback = 'Não deu para conectar.'

  it('connected:true + status connected -> connected com os NOMES dos modelos e quota', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: ['a', 'b'], quotaRemaining: 42 } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: ['a', 'b'], quota: 42 })
  })

  it('quota ausente vira null (provider sem quota) sem quebrar', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: [] } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: [], quota: null })
  })

  // 21/07: a quota REAL do Claude (claude -p "/usage", ver quota-reader.ts no
  // control-plane) chega como % usado de sessão/semana, não remaining/total.
  it('Claude: traz sessionPercentUsed/sessionResetsAt/weekPercentUsed/weekResetsAt quando o backend os manda', () => {
    const state = parseTokenResponse(
      {
        connected: true,
        status: {
          status: 'connected',
          models: ['claude-sonnet-5'],
          sessionPercentUsed: 100,
          sessionResetsAt: 'Jul 21, 3:09am (UTC)',
          weekPercentUsed: 41,
          weekResetsAt: 'Jul 26, 5:59pm (UTC)',
        },
      },
      fallback
    )
    expect(state).toEqual({
      phase: 'connected',
      models: ['claude-sonnet-5'],
      quota: null,
      sessionPercentUsed: 100,
      sessionResetsAt: 'Jul 21, 3:09am (UTC)',
      weekPercentUsed: 41,
      weekResetsAt: 'Jul 26, 5:59pm (UTC)',
    })
  })

  it('Codex/Antigravity: sem os campos de sessão/semana, o shape continua {phase,models,quota} (sem regressão)', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: ['gpt-5'], quotaRemaining: 900 } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: ['gpt-5'], quota: 900 })
  })

  it('anti-fachada: liveness reprovou (status error) -> error com a causa real, nunca connected', () => {
    const state = parseTokenResponse(
      {
        connected: false,
        status: { status: 'error', lastError: 'motor não respondeu à validação' },
      },
      fallback
    )
    expect(state).toEqual({ phase: 'error', message: 'motor não respondeu à validação' })
  })

  it('erro 400 da rota (error de topo) -> error com essa mensagem', () => {
    const state = parseTokenResponse({ error: 'token de claude inválido: vazio' }, fallback)
    expect(state).toEqual({ phase: 'error', message: 'token de claude inválido: vazio' })
  })

  it('sem causa nenhuma -> cai no fallback localizado', () => {
    expect(parseTokenResponse(null, fallback)).toEqual({ phase: 'error', message: fallback })
    expect(parseTokenResponse({ connected: false, status: { status: 'error' } }, fallback)).toEqual(
      {
        phase: 'error',
        message: fallback,
      }
    )
  })
})

describe('normalizeLoginState', () => {
  const fallback = 'Não deu para conectar.'

  it('AO VIVO: connected traz models como LISTA -> preserva os nomes (casa com o refetch)', () => {
    const state = normalizeLoginState(
      { phase: 'connected', models: ['gpt-5', 'o4', 'haiku'], quota: 88 },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: ['gpt-5', 'o4', 'haiku'], quota: 88 })
  })

  it('connected sem quota -> quota null, sem quebrar a linha de prova de vida', () => {
    expect(normalizeLoginState({ phase: 'connected', models: [] }, fallback)).toEqual({
      phase: 'connected',
      models: [],
      quota: null,
    })
  })

  it('AO VIVO (Claude): preserva sessionPercentUsed/sessionResetsAt/weekPercentUsed/weekResetsAt quando vêm no evento', () => {
    const state = normalizeLoginState(
      {
        phase: 'connected',
        models: ['claude-sonnet-5'],
        sessionPercentUsed: 100,
        sessionResetsAt: 'Jul 21, 3:09am (UTC)',
        weekPercentUsed: 41,
        weekResetsAt: 'Jul 26, 5:59pm (UTC)',
      },
      fallback
    )
    expect(state).toEqual({
      phase: 'connected',
      models: ['claude-sonnet-5'],
      quota: null,
      sessionPercentUsed: 100,
      sessionResetsAt: 'Jul 21, 3:09am (UTC)',
      weekPercentUsed: 41,
      weekResetsAt: 'Jul 26, 5:59pm (UTC)',
    })
  })

  it('preserva url_ready (url + code) sem tocar', () => {
    expect(
      normalizeLoginState({ phase: 'url_ready', url: 'https://x/y', code: 'AB-CD' }, fallback)
    ).toEqual({ phase: 'url_ready', url: 'https://x/y', code: 'AB-CD' })
  })

  it('url_ready sem url é payload quebrado -> erro honesto', () => {
    expect(normalizeLoginState({ phase: 'url_ready' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
  })

  it('preserva error com a mensagem do backend; sem mensagem cai no fallback', () => {
    expect(normalizeLoginState({ phase: 'error', message: 'tempo esgotado' }, fallback)).toEqual({
      phase: 'error',
      message: 'tempo esgotado',
    })
    expect(normalizeLoginState({ phase: 'error' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
  })

  it('starting passa direto; fase desconhecida/malformada -> erro honesto', () => {
    expect(normalizeLoginState({ phase: 'starting' }, fallback)).toEqual({ phase: 'starting' })
    expect(normalizeLoginState({ phase: 'wat' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
    expect(normalizeLoginState(null, fallback)).toEqual({ phase: 'error', message: fallback })
  })
})

// 21/07: substitui isClaudeQuotaManagedByPlan (removida) — correção de um
// erro real. O dono rejeitou a legenda genérica "cota gerenciada pela sua
// assinatura" ("sobre quota nao aceito isso... tem que coletar!"): existe uma
// forma real de coletar (`claude -p "/usage"`, ver quota-reader.ts no
// control-plane) — % usado de sessão/semana + reset de cada uma.
describe('hasClaudeUsageData — dado REAL no lugar da legenda genérica', () => {
  it('claude conectado com sessionPercentUsed -> true', () => {
    expect(
      hasClaudeUsageData('claude', {
        phase: 'connected',
        models: ['claude-sonnet-5'],
        sessionPercentUsed: 100,
      })
    ).toBe(true)
  })

  it('claude conectado com weekPercentUsed (mas não sessão) -> true', () => {
    expect(
      hasClaudeUsageData('claude', { phase: 'connected', models: [], weekPercentUsed: 41 })
    ).toBe(true)
  })

  it('claude conectado sem nenhuma das duas janelas -> false (nunca inventa um número)', () => {
    expect(
      hasClaudeUsageData('claude', { phase: 'connected', models: ['claude-sonnet-5'], quota: null })
    ).toBe(false)
  })

  it('outro motor (codex/antigravity) -> false, mesmo com os campos presentes (só o Claude usa essa janela)', () => {
    expect(
      hasClaudeUsageData('codex', { phase: 'connected', models: ['gpt-5'], sessionPercentUsed: 10 })
    ).toBe(false)
  })

  it('fase diferente de connected -> false', () => {
    expect(hasClaudeUsageData('claude', { phase: 'idle' })).toBe(false)
  })
})

describe('formatClaudeUsage — monta a linha de exibição a partir do dado real', () => {
  it('as duas janelas presentes -> junta sessão e semana com " · "', () => {
    expect(
      formatClaudeUsage(
        {
          phase: 'connected',
          models: ['claude-sonnet-5'],
          sessionPercentUsed: 100,
          sessionResetsAt: 'Jul 21, 3:09am (UTC)',
          weekPercentUsed: 41,
          weekResetsAt: 'Jul 26, 5:59pm (UTC)',
        },
        CLAUDE_USAGE_LABELS
      )
    ).toBe(
      'Session: 100% used (resets Jul 21, 3:09am (UTC)) · Week: 41% used (resets Jul 26, 5:59pm (UTC))'
    )
  })

  it('só uma janela presente -> mostra só ela (nunca inventa a outra)', () => {
    expect(
      formatClaudeUsage(
        { phase: 'connected', models: [], weekPercentUsed: 41, weekResetsAt: '26/07' },
        CLAUDE_USAGE_LABELS
      )
    ).toBe('Week: 41% used (resets 26/07)')
  })

  it('percentual sem reset capturado -> mostra o percentual sem o parêntese (não inventa o horário)', () => {
    expect(
      formatClaudeUsage(
        { phase: 'connected', models: [], sessionPercentUsed: 57 },
        CLAUDE_USAGE_LABELS
      )
    ).toBe('Session: 57% used')
  })

  it('nenhuma janela -> null', () => {
    expect(
      formatClaudeUsage({ phase: 'connected', models: [], quota: null }, CLAUDE_USAGE_LABELS)
    ).toBe(null)
  })

  it('fase diferente de connected -> null', () => {
    expect(formatClaudeUsage({ phase: 'idle' }, CLAUDE_USAGE_LABELS)).toBe(null)
  })
})

describe('classifyConnectError', () => {
  it('Termos do Antigravity -> terms', () => {
    expect(classifyConnectError('Você precisa aceitar os Termos para continuar')).toBe('terms')
  })

  it('falha de captura / liveness reprovada -> capture', () => {
    expect(classifyConnectError('login encerrado sem token (código de saída 1)')).toBe('capture')
    expect(classifyConnectError('motor não respondeu à validação viva')).toBe('capture')
    expect(classifyConnectError('tempo esgotado (captura travada); tente novamente')).toBe(
      'capture'
    )
  })

  it('erro genérico de rede -> generic', () => {
    expect(classifyConnectError('Não deu para conectar. Confira e tente de novo.')).toBe('generic')
    expect(classifyConnectError(undefined)).toBe('generic')
    expect(classifyConnectError('')).toBe('generic')
  })
})

describe('connectErrorHintKey', () => {
  it('mapeia cada tipo para a chave de dica que aponta o paste manual', () => {
    expect(connectErrorHintKey('terms')).toBe('setup.connectErrorHintTerms')
    expect(connectErrorHintKey('capture')).toBe('setup.connectErrorHintCapture')
    expect(connectErrorHintKey('generic')).toBe('setup.connectErrorHintGeneric')
  })
})

// A verdade do provisionamento vem de GET /api/v1/setup/status (o estado REAL
// da missão `clone_and_start_engines` no banco). O sinal antigo — a lista de
// motores — era uma TAUTOLOGIA: o submit só passa com um motor conectado e a
// linha 'github' nasce conectada no OAuth, então o primeiro poll SEMPRE achava
// um motor "connected" e pintava ✓ verde enquanto a missão ainda estava pending.
describe('parseSetupStatus', () => {
  it('pendente -> pending (o wizard diz "provisionando", nunca "pronto")', () => {
    expect(parseSetupStatus({ status: 'pending', error: null })).toEqual({
      status: 'pending',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('em andamento -> running (o scheduler pegou a missão)', () => {
    expect(parseSetupStatus({ status: 'running', error: null })).toEqual({
      status: 'running',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('concluída -> completed (só AQUI o ✓ verde é verdade)', () => {
    expect(parseSetupStatus({ status: 'completed', error: null })).toEqual({
      status: 'completed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('falhou -> failed COM a causa real do backend (o cliente sabe o que aconteceu)', () => {
    expect(
      parseSetupStatus({ status: 'failed', error: 'git clone falhou: repositório não encontrado' })
    ).toEqual({
      status: 'failed',
      error: 'git clone falhou: repositório não encontrado',
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('falhou sem causa -> error null (a UI cai num texto localizado, não numa mentira)', () => {
    expect(parseSetupStatus({ status: 'failed', error: null })).toEqual({
      status: 'failed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(parseSetupStatus({ status: 'failed', error: '   ' })).toEqual({
      status: 'failed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('causa pendurada num estado bom é ruído -> ignorada', () => {
    expect(parseSetupStatus({ status: 'completed', error: 'falha antiga' })).toEqual({
      status: 'completed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('payload nulo/malformado/estado desconhecido -> unknown (segue no polling, nunca chuta ✓)', () => {
    expect(parseSetupStatus(null)).toEqual({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(parseSetupStatus(undefined)).toEqual({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(parseSetupStatus({})).toEqual({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(parseSetupStatus({ status: 'ready' })).toEqual({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(parseSetupStatus({ status: 42 })).toEqual({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('pending com queuePosition nas missões -> expõe a MENOR posição (a que o cliente vê progredir primeiro)', () => {
    expect(
      parseSetupStatus({
        status: 'pending',
        error: null,
        missions: [
          { projectId: 'proj_2', status: 'pending', queuePosition: 3 },
          { projectId: 'proj_1', status: 'pending', queuePosition: 1 },
        ],
      })
    ).toEqual({ status: 'pending', error: null, queuePosition: 1, environmentResources: null })
  })

  it('fora de pending, queuePosition é sempre null mesmo se vier no payload (já não está esperando)', () => {
    expect(
      parseSetupStatus({
        status: 'running',
        error: null,
        missions: [{ projectId: 'proj_1', status: 'running', queuePosition: null }],
      })
    ).toEqual({ status: 'running', error: null, queuePosition: null, environmentResources: null })
  })

  it('pending sem nenhuma missão com queuePosition numérico -> null (não inventa posição)', () => {
    expect(
      parseSetupStatus({
        status: 'pending',
        error: null,
        missions: [{ projectId: 'proj_1', status: 'pending', queuePosition: null }],
      })
    ).toEqual({ status: 'pending', error: null, queuePosition: null, environmentResources: null })
  })

  // W1: environment.resources vem de GET /setup/status (via
  // summarizeResourcesLock no backend) — o dono precisa VER as versões REAIS
  // instaladas no ambiente isolado dele, não uma suposição. null enquanto o
  // bootstrap não terminou (ou o backend não devolveu `environment` nenhum).
  it('environment.resources presente -> repassado como environmentResources', () => {
    expect(
      parseSetupStatus({
        status: 'completed',
        error: null,
        environment: {
          id: 'env_1',
          status: 'ready',
          resources: {
            engines: [
              { name: 'claude', version: '2.1.200' },
              { name: 'codex', version: '0.142.5' },
              { name: 'antigravity', version: '1.1.4' },
            ],
            commit: 'abc123d',
          },
        },
      })
    ).toEqual({
      status: 'completed',
      error: null,
      queuePosition: null,
      environmentResources: {
        engines: [
          { name: 'claude', version: '2.1.200' },
          { name: 'codex', version: '0.142.5' },
          { name: 'antigravity', version: '1.1.4' },
        ],
        commit: 'abc123d',
      },
    })
  })

  it('environment presente mas resources null (bootstrap ainda rodando) -> environmentResources null', () => {
    expect(
      parseSetupStatus({
        status: 'running',
        error: null,
        environment: { id: 'env_1', status: 'provisioning', resources: null },
      })
    ).toEqual({
      status: 'running',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('environment ausente -> environmentResources null (sem inventar)', () => {
    expect(parseSetupStatus({ status: 'pending', error: null, environment: null })).toEqual({
      status: 'pending',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })

  it('environment.resources malformado (engines não é array, motor sem version) é descartado por inteiro -> null', () => {
    expect(
      parseSetupStatus({
        status: 'completed',
        error: null,
        environment: { id: 'env_1', status: 'ready', resources: { engines: 'nope', commit: 'x' } },
      })
    ).toEqual({
      status: 'completed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
    expect(
      parseSetupStatus({
        status: 'completed',
        error: null,
        environment: {
          id: 'env_1',
          status: 'ready',
          resources: { engines: [{ name: 'claude' }], commit: 'x' },
        },
      })
    ).toEqual({
      status: 'completed',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
  })
})

// Texto honesto para o StepReady: nome de exibição conhecido (mesmo dos
// cards de StepConnectEngine) + a versão REAL — nunca uma suposição.
describe('formatEngineVersions', () => {
  it('formata os 3 motores conhecidos com nome de exibição, separados por · ', () => {
    expect(
      formatEngineVersions([
        { name: 'claude', version: '2.1.200' },
        { name: 'codex', version: '0.142.5' },
        { name: 'antigravity', version: '1.1.4' },
      ])
    ).toBe('Claude Code 2.1.200 · Codex 0.142.5 · Antigravity 1.1.4')
  })

  it('lista vazia -> string vazia (quem chama decide o que mostrar)', () => {
    expect(formatEngineVersions([])).toBe('')
  })

  it('motor sem nome de exibição conhecido cai no nome cru (nunca esconde um motor real)', () => {
    expect(formatEngineVersions([{ name: 'exotic', version: '9.9.9' }])).toBe('exotic 9.9.9')
  })
})

describe('isProvisionTerminal', () => {
  it('completed e failed são terminais (o polling para)', () => {
    expect(isProvisionTerminal('completed')).toBe(true)
    expect(isProvisionTerminal('failed')).toBe(true)
  })

  it('pending, running e unknown NÃO são terminais (o polling continua)', () => {
    expect(isProvisionTerminal('pending')).toBe(false)
    expect(isProvisionTerminal('running')).toBe(false)
    expect(isProvisionTerminal('unknown')).toBe(false)
  })
})

// A dupla-colagem (bug real visto pelo dono 18/07): a pessoa colou o CÓDIGO da
// página de autorização no campo de TOKEN manual e recebeu "esperado
// sk-ant-oat" — um erro tecnicamente correto, mas inútil, porque o campo
// errado nem deveria estar visível ali. Duas defesas: (1) o accordion manual
// só aparece quando pedido de verdade (fase 'error' o abre sozinho; fora
// disso só um link discreto), nunca "de graça" ao lado do campo de código
// durante url_ready; (2) se o que foi colado no campo de token TEM CARA de
// código de autorização, o hint aponta o campo certo em vez de repetir o erro
// cru do backend.
describe('isManualAccordionVisible — o accordion não pode mais estar "de graça" ao lado do código', () => {
  it('url_ready sem pedido explícito -> ESCONDIDO (era aqui que a colagem errada acontecia)', () => {
    expect(isManualAccordionVisible('url_ready', false)).toBe(false)
  })

  it('idle/starting/verifying sem pedido explícito -> escondido também', () => {
    expect(isManualAccordionVisible('idle', false)).toBe(false)
    expect(isManualAccordionVisible('starting', false)).toBe(false)
    expect(isManualAccordionVisible('verifying', false)).toBe(false)
  })

  it('error SEMPRE abre, mesmo sem clique — é a rede de segurança de verdade', () => {
    expect(isManualAccordionVisible('error', false)).toBe(true)
    expect(isManualAccordionVisible('error', true)).toBe(true)
  })

  it('clicou no link discreto "Problemas? Colar manualmente" -> abre em qualquer fase', () => {
    expect(isManualAccordionVisible('url_ready', true)).toBe(true)
    expect(isManualAccordionVisible('idle', true)).toBe(true)
  })
})

describe('looksLikeAuthCode — detecta quando o campo de token recebeu o código, não o token', () => {
  it('formato de device code XXXX-XXXX -> parece código, em qualquer runtime', () => {
    expect(looksLikeAuthCode('ABCD-1234', 'claude')).toBe(true)
    expect(looksLikeAuthCode('wdjq-mzbg', 'codex')).toBe(true) // minúsculo também
    expect(looksLikeAuthCode('AB12-CD34', 'antigravity')).toBe(true)
  })

  it('vazio (nada colado ainda) -> nunca parece código', () => {
    expect(looksLikeAuthCode('', 'claude')).toBe(false)
    expect(looksLikeAuthCode('   ', 'claude')).toBe(false)
  })

  it('token de claude de verdade (prefixo sk-ant-oat) -> não parece código', () => {
    expect(looksLikeAuthCode('sk-ant-oat01-abcxyz1234567890', 'claude')).toBe(false)
  })

  it('claude: string curta sem o prefixo esperado -> parece código (o bug real)', () => {
    expect(looksLikeAuthCode('a1b2c3', 'claude')).toBe(true)
  })

  it('claude: string longa sem o prefixo -> não é classificada como código (é só inválida)', () => {
    expect(looksLikeAuthCode('x'.repeat(40), 'claude')).toBe(false)
  })

  it('runtimes que não são claude: string curta genérica não vira "parece código" pelo prefixo', () => {
    // Sem device-code pattern, o heurístico de prefixo só se aplica ao claude
    // (é o único runtime com prefixo conhecido e documentado, sk-ant-oat).
    expect(looksLikeAuthCode('a1b2c3', 'codex')).toBe(false)
  })
})

// Guarda ARQUITETURAL: o app web não tem jsdom/testing-library (decisão
// registrada acima), então o que precisa de teste sobre o COMPONENTE mora
// aqui, lendo o source real — mesmo padrão usado em submit-flow.test.ts pra
// proteger StepPlanConfirmation/StepReady.
describe('guarda: StepConnectEngine usa as funções puras pra decidir o accordion manual', () => {
  const source = (): string =>
    readFileSync(new URL('./StepConnectEngine.tsx', import.meta.url), 'utf8')

  it('o accordion manual é gated por isManualAccordionVisible, não mais sempre-renderizado', () => {
    const step = source()
    expect(step).toContain('isManualAccordionVisible(state.phase, !!manualRequested[id])')
    // Regressão: o padrão antigo (`<details open={state.phase === 'error'}>`)
    // sempre RENDERIZAVA o accordion (só recolhido) ao lado do campo de
    // código — era exatamente isso que causava a dupla-colagem (18/07).
    expect(step).not.toContain("open={state.phase === 'error'}")
  })

  it('o hint de erro verifica looksLikeAuthCode antes de cair no genérico', () => {
    const step = source()
    expect(step).toContain("looksLikeAuthCode(pastedToken[id] ?? '', runtime)")
    expect(step).toContain("t('setup.connectManualLooksLikeCode')")
  })

  it('existe o link discreto que abre o accordion fora da fase de erro', () => {
    const step = source()
    expect(step).toContain('setManualRequested((m) => ({ ...m, [id]: true }))')
  })
})

// Guarda ARQUITETURAL (mesma razão do bloco acima): a reclamação real do dono
// (20/07 — "mostra os modelos? mostra as quotas?") é sobre RENDER, então o que
// dá pra travar sem jsdom é ler o source e garantir que o padrão certo está
// lá e o padrão errado (a contagem) não voltou.
describe('guarda: StepConnectEngine mostra os NOMES dos modelos e a quota REAL do Claude', () => {
  const source = (): string =>
    readFileSync(new URL('./StepConnectEngine.tsx', import.meta.url), 'utf8')

  it('junta os nomes dos modelos (join), não mais uma contagem', () => {
    const step = source()
    expect(step).toContain("state.models.join(', ')")
    // Regressão: o padrão antigo só mostrava um número ao lado do rótulo
    // (`${state.models} ${t('setup.connectModelsLabel')}`) — o dono via "4
    // modelos" e nunca os nomes de verdade.
    expect(step).not.toContain('${state.models} ${')
  })

  // 21/07: substitui a legenda genérica antiga ("cota gerenciada pela sua
  // assinatura", que o dono rejeitou) pelo dado real coletado de verdade.
  it('usa hasClaudeUsageData/formatClaudeUsage pra mostrar a quota REAL do Claude, não mais uma legenda genérica', () => {
    const step = source()
    expect(step).toContain('hasClaudeUsageData(runtime, state)')
    expect(step).toContain('formatClaudeUsage(state,')
    // Regressão: a legenda genérica antiga não pode voltar.
    expect(step).not.toContain('isClaudeQuotaManagedByPlan')
    expect(step).not.toContain('connectQuotaManagedByPlan')
  })

  it('o refetch de /engines repassa a LISTA de modelos, não mais só o tamanho', () => {
    const step = source()
    expect(step).toContain('models: Array.isArray(eng.models) ? eng.models : undefined')
    expect(step).not.toContain('eng.models.length')
  })
})
