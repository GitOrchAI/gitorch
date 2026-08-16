import { describe, expect, it } from 'vitest'
import {
  CredencialExpiradaError,
  deveAvisarDeNovo,
  ehCredencialExpirada,
} from './credencial-do-motor.js'

describe('ehCredencialExpirada', () => {
  it('reconhece o recado do motor mesmo com código de saída 0', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr:
          'ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.',
      })
    ).toBe(true)
  })

  it('reconhece pela recusa de autorização', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr: 'failed to connect to websocket: HTTP error: 401 Unauthorized',
      })
    ).toBe(true)
  })

  it('não confunde com falta de cota', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 1,
        stdout: '',
        stderr: 'rate limit exceeded, try again later',
      })
    ).toBe(false)
  })

  it('não confunde com erro comum', () => {
    expect(ehCredencialExpirada({ exitCode: 1, stdout: '', stderr: 'file not found' })).toBe(false)
  })

  it('olha também a saída normal, não só a de erro', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: 'Please log out and sign in again',
        stderr: '',
      })
    ).toBe(true)
  })

  it('reconhece invalid_grant (recusa clássica de OAuth)', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr: 'Error: invalid_grant — token expired',
      })
    ).toBe(true)
  })

  it('reconhece "authentication required" sem depender de maiúsculas', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: 'AUTHENTICATION REQUIRED — please sign in.',
        stderr: '',
      })
    ).toBe(true)
  })

  // Achado crítico da revisão: sinal FORTE ("access token could not be
  // refreshed") tem que continuar valendo mesmo quando o banner real vem
  // cercado de mais linhas de log do CLI (timestamps, nível de log, contexto
  // de retry) — o gate de tamanho (LIMITE_SAIDA_TERSE_CHARS) só se aplica aos
  // sinais FRACOS. Sem este teste, alguém "simplificando" a função para
  // aplicar o limite de tamanho a TODOS os sinais quebraria o reconhecimento
  // de um banner real só porque o CLI decidiu logar mais contexto ao redor.
  it('sinal FORTE ("access token could not be refreshed") é reconhecido mesmo numa saída bem mais longa que o limite de terseness', () => {
    const saidaLonga =
      '2026-08-15T03:14:07Z INFO codex: iniciando sessão, workspace=/tmp/mission-882\n' +
      '2026-08-15T03:14:07Z DEBUG codex: resolvendo credencial armazenada em ~/.codex/auth.json\n' +
      '2026-08-15T03:14:08Z DEBUG codex: token expira em -3600s, tentando refresh\n' +
      '2026-08-15T03:14:09Z ERROR codex_login::auth::manager: Failed to refresh token: ' +
      'Your access token could not be refreshed. Please log out and sign in again.\n' +
      '2026-08-15T03:14:09Z INFO codex: encerrando sessão (exit 0)\n'
    expect(saidaLonga.length).toBeGreaterThan(200)
    expect(ehCredencialExpirada({ exitCode: 0, stdout: saidaLonga, stderr: '' })).toBe(true)
  })
})

// Achado CRÍTICO da revisão (finding 1): a versão anterior casava os sinais
// contra a saída CRUA INTEIRA — e este produto existe para limpar
// repositórios bagunçados, então uma missão tocando código/texto de
// autenticação é trabalho ORDINÁRIO. Um reviewer rodou a regra contra 4
// saídas de missão comuns (não inventadas) e as QUATRO dispararam o aviso
// falsamente. Estes 4 testes são a prova de regressão: têm que continuar
// `false` para sempre — se a regra "alargar" (voltar a casar sinal fraco em
// qualquer tamanho de saída, ou adicionar de volta um sinal genérico sem
// corroboração), estes testes quebram.
//
// As 4 saídas abaixo são reconstruções REALISTAS do que a revisão descreveu
// (trace de curl, comentário de code review, log de commits, erro de API de
// terceiro) — deliberadamente com o TAMANHO real de uma saída de missão que
// fez trabalho de verdade (parágrafos de análise, não uma frase solta),
// porque é exatamente esse tamanho que distingue "missão normal mencionando
// autenticação" de "processo que morreu antes de produzir qualquer coisa"
// (a forma real do bug desta tarefa).
describe('ehCredencialExpirada — falsos-positivos medidos na revisão (têm que ficar false)', () => {
  it('trace de curl mostrando 401 Unauthorized dentro de uma investigação de bug NÃO é credencial expirada do motor', () => {
    const saida =
      'Investigando a falha de autenticação relatada na issue #482.\n\n' +
      '$ curl -v https://api.example.com/v1/users/me\n' +
      '* Connected to api.example.com (203.0.113.10) port 443\n' +
      '> GET /v1/users/me HTTP/1.1\n' +
      '> Host: api.example.com\n' +
      '> Authorization: Bearer ***\n' +
      '>\n' +
      '< HTTP/1.1 401 Unauthorized\n' +
      '< content-type: application/json\n' +
      '< {"error":"invalid or expired token"}\n\n' +
      'O serviço upstream está rejeitando o token armazenado. Recomendo criar um ' +
      'job de renovação de token para evitar essa classe de falha no futuro.'
    expect(saida.length).toBeGreaterThan(200)
    expect(ehCredencialExpirada({ exitCode: 0, stdout: saida, stderr: '' })).toBe(false)
  })

  it('comentário de code review sobre um AuthMiddleware ("401 Unauthorized... Authentication required") NÃO é credencial expirada do motor', () => {
    const saida =
      'Revisão do PR #217: adiciona um AuthMiddleware que intercepta toda ' +
      'requisição. Quando o cabeçalho Authorization está ausente ou o token ' +
      'expirou, o middleware retorna 401 Unauthorized com a mensagem ' +
      '"Authentication required". Confirmei que os testes de caminho negativo ' +
      'cobrem tanto o cabeçalho ausente quanto o token expirado, e que a resposta ' +
      'nunca revela se o recurso existe para quem não está autenticado. Aprovado, ' +
      'só falta o changelog.'
    expect(saida.length).toBeGreaterThan(200)
    expect(ehCredencialExpirada({ exitCode: 0, stdout: saida, stderr: '' })).toBe(false)
  })

  it('log de commits sobre uma feature de logout ("log out and sign in again") NÃO é credencial expirada do motor', () => {
    const saida =
      'Resumo das últimas mudanças no repositório (git log --oneline -5):\n\n' +
      'a1b2c3d feat: allow users to log out and sign in again with a different account (closes #128)\n' +
      'e4f5061 fix: session cookie not cleared on logout\n' +
      '9988aa2 chore: bump auth SDK to 4.2.0\n' +
      '001122b test: cover the re-login flow after logout\n' +
      '334455c docs: document the multi-account switch\n\n' +
      'Nenhuma dessas mudanças toca a lógica de emissão de token do próprio ' +
      'GitOrch; a próxima tarefa deve focar em testes de integração para o fluxo ' +
      'de troca de conta.'
    expect(saida.length).toBeGreaterThan(200)
    expect(ehCredencialExpirada({ exitCode: 0, stdout: saida, stderr: '' })).toBe(false)
  })

  it('erro de API de terceiro no stdout ("Bad credentials (401 Unauthorized)") NÃO é credencial expirada do motor', () => {
    const saida =
      'Tentando sincronizar labels do repositório upstream via GitHub API.\n\n' +
      'GET https://api.github.com/repos/acme/legacy-service/labels\n' +
      '-> 401 Bad credentials (401 Unauthorized)\n\n' +
      'O token configurado para este passo não tem permissão de leitura no ' +
      'repositório upstream (provavelmente revogado do lado do terceiro). Seguindo ' +
      'sem sincronizar labels — isso não bloqueia o restante da missão.'
    expect(saida.length).toBeGreaterThan(200)
    expect(ehCredencialExpirada({ exitCode: 0, stdout: saida, stderr: '' })).toBe(false)
  })
})

describe('CredencialExpiradaError', () => {
  it('carrega o motor para quem captura, sem depender de casar texto de novo', () => {
    const err = new CredencialExpiradaError('motor codex pediu novo login', 'codex')
    expect(err).toBeInstanceOf(Error)
    expect(err.runtime).toBe('codex')
    expect(err.name).toBe('CredencialExpiradaError')
  })
})

describe('deveAvisarDeNovo — dedup em memória, uma vez por motor por dia', () => {
  const UM_DIA_MS = 24 * 60 * 60 * 1000

  it('primeiro aviso (chave nunca vista): deve avisar', () => {
    const registro = new Map<string, number>()
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000)).toBe(true)
  })

  it('mesmo dia, mesma chave: NÃO deve avisar de novo (SPAM apaga sinal tanto quanto silêncio)', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000 + 60_000)).toBe(false)
  })

  it('passado um dia inteiro: deve avisar de novo (ainda quebrado, lembrete diário)', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000 + UM_DIA_MS)).toBe(true)
  })

  it('chave diferente (outro motor/dono): não é afetada pelo aviso anterior', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:antigravity', 1000 + 60_000)).toBe(true)
  })
})
