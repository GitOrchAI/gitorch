import { describe, expect, it } from 'vitest'
import {
  classifyCloneError,
  classifyDiagnosisError,
  classifyGithubApiError,
  setupErrorHttpStatus,
  type SetupErrorCode,
} from './setup-errors.js'

// Mensagens REAIS, confirmadas ao vivo contra o git/GitHub de verdade (não
// inventadas) — ver packages/workspace-engine/src/local-provider.ts e o
// experimento que gerou estas duas primeiro:
//
//   git clone de um repo que não existe:
//     "Command failed: git clone --depth 1 -- https://github.com/x/y.git /tmp/z
//      Cloning into '/tmp/z'...
//      remote: Repository not found.
//      fatal: repository 'https://github.com/x/y.git/' not found"
//
//   git clone com token inválido/expirado:
//     "Command failed: git -c http.extraHeader=Authorization: Basic ... clone ...
//      Cloning into '/tmp/z'...
//      remote: Invalid username or token. Password authentication is not supported for Git operations.
//      fatal: Authentication failed for 'https://github.com/x/y.git/'"
const REPO_NOT_FOUND_MESSAGE =
  'Command failed: git clone --depth 1 -- https://github.com/x/y.git /tmp/z\n' +
  "Cloning into '/tmp/z'...\n" +
  'remote: Repository not found.\n' +
  "fatal: repository 'https://github.com/x/y.git/' not found\n"

const AUTH_FAILED_MESSAGE =
  'Command failed: git -c http.extraHeader=Authorization: [REDACTED] clone --depth 1 -- https://github.com/x/y.git /tmp/z\n' +
  "Cloning into '/tmp/z'...\n" +
  'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
  "fatal: Authentication failed for 'https://github.com/x/y.git/'\n"

describe('classifyCloneError', () => {
  it('repositório inexistente ou privado sem acesso -> REPO_NOT_FOUND (mensagem real do GitHub)', () => {
    expect(classifyCloneError(new Error(REPO_NOT_FOUND_MESSAGE))).toBe('REPO_NOT_FOUND')
  })

  it('token inválido/expirado -> REPO_ACCESS_DENIED (mensagem real do git)', () => {
    expect(classifyCloneError(new Error(AUTH_FAILED_MESSAGE))).toBe('REPO_ACCESS_DENIED')
  })

  it('403 explícito na camada HTTP do git (SSO/enforcement) -> REPO_ACCESS_DENIED', () => {
    expect(
      classifyCloneError(
        new Error(
          "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403"
        )
      )
    ).toBe('REPO_ACCESS_DENIED')
  })

  it('404 explícito na camada HTTP do git -> REPO_NOT_FOUND', () => {
    expect(
      classifyCloneError(
        new Error(
          "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 404"
        )
      )
    ).toBe('REPO_NOT_FOUND')
  })

  it('rate limit (secundário do GitHub) -> RATE_LIMITED', () => {
    expect(classifyCloneError(new Error('remote: You have exceeded a secondary rate limit.'))).toBe(
      'RATE_LIMITED'
    )
  })

  it('ENOSPC do fs.mkdir (código nativo do erro) -> DISK_FULL', () => {
    const err = Object.assign(new Error('ENOSPC: no space left on device, mkdir'), {
      code: 'ENOSPC',
    })
    expect(classifyCloneError(err)).toBe('DISK_FULL')
  })

  it('"No space left on device" no stderr do git (clone real) -> DISK_FULL', () => {
    expect(classifyCloneError(new Error('fatal: write error: No space left on device'))).toBe(
      'DISK_FULL'
    )
  })

  it('timeout do execFile (killed+signal, preservado por sanitizeGitError) -> CLONE_TIMEOUT', () => {
    // Node NÃO escreve "timeout" na mensagem quando mata por estouro de prazo
    // (Command failed: git clone ...\n, sem mais nada) — só killed/signal
    // denunciam. Confirmado experimentalmente com execFile+timeout curto.
    const err = Object.assign(new Error('Command failed: git clone --depth 1 -- ... \n'), {
      killed: true,
      signal: 'SIGTERM',
    })
    expect(classifyCloneError(err)).toBe('CLONE_TIMEOUT')
  })

  it('falha desconhecida/genérica -> INTERNAL (nunca vaza sem classificar)', () => {
    expect(classifyCloneError(new Error('something exploded'))).toBe('INTERNAL')
  })

  it('valor não-Error (string crua lançada) não quebra a classificação', () => {
    expect(classifyCloneError('boom')).toBe('INTERNAL')
  })
})

describe('classifyDiagnosisError', () => {
  it('delega erros de clone REPO_* para o mesmo code (não é um clone "diferente")', () => {
    expect(classifyDiagnosisError(new Error(REPO_NOT_FOUND_MESSAGE))).toBe('REPO_NOT_FOUND')
    expect(classifyDiagnosisError(new Error(AUTH_FAILED_MESSAGE))).toBe('REPO_ACCESS_DENIED')
  })

  it('timeout durante o diagnóstico vira DIAG_TIMEOUT (não CLONE_TIMEOUT — é a leitura que estourou)', () => {
    const err = Object.assign(new Error('Command failed: git clone ...\n'), {
      killed: true,
      signal: 'SIGTERM',
    })
    expect(classifyDiagnosisError(err)).toBe('DIAG_TIMEOUT')
  })

  it('repositório vazio (mensagem real do GitHub: 409 "Git Repository is empty") -> DIAG_EMPTY_REPO', () => {
    expect(classifyDiagnosisError(new Error('Git Repository is empty.'))).toBe('DIAG_EMPTY_REPO')
  })

  it('aviso real do git ao clonar repo sem commits -> DIAG_EMPTY_REPO', () => {
    expect(
      classifyDiagnosisError(new Error('warning: You appear to have cloned an empty repository.'))
    ).toBe('DIAG_EMPTY_REPO')
  })

  it('falha desconhecida -> INTERNAL', () => {
    expect(classifyDiagnosisError(new Error('kaboom'))).toBe('INTERNAL')
  })
})

describe('classifyGithubApiError', () => {
  // Corpo REAL da API REST do GitHub numa credencial ruim (documentado):
  // {"message": "Bad credentials", "documentation_url": "..."}
  it('401 (token expirado/revogado) -> GITHUB_TOKEN_EXPIRED, achado real do QA (19/07)', () => {
    expect(
      classifyGithubApiError(401, {
        message: 'Bad credentials',
        documentation_url: 'https://docs.github.com/rest',
      })
    ).toBe('GITHUB_TOKEN_EXPIRED')
  })

  it('401 sem corpo decodificável ainda vira GITHUB_TOKEN_EXPIRED (o status já basta)', () => {
    expect(classifyGithubApiError(401, null)).toBe('GITHUB_TOKEN_EXPIRED')
  })

  it('403 com mensagem de rate limit primário -> RATE_LIMITED', () => {
    expect(
      classifyGithubApiError(403, {
        message: 'API rate limit exceeded for x.x.x.x.',
      })
    ).toBe('RATE_LIMITED')
  })

  it('403 com mensagem de rate limit secundário -> RATE_LIMITED', () => {
    expect(
      classifyGithubApiError(403, {
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
      })
    ).toBe('RATE_LIMITED')
  })

  it('403 sem indício de rate limit (ex.: SSO/permissão) -> INTERNAL, não inventa REPO_ACCESS_DENIED', () => {
    expect(classifyGithubApiError(403, { message: 'Resource not accessible by integration' })).toBe(
      'INTERNAL'
    )
  })

  it('outro status (ex.: 500 do próprio GitHub) -> INTERNAL', () => {
    expect(classifyGithubApiError(500, { message: 'Internal Server Error' })).toBe('INTERNAL')
  })

  it('corpo não-objeto (array/string crua) não quebra a classificação', () => {
    expect(classifyGithubApiError(403, [])).toBe('INTERNAL')
    expect(classifyGithubApiError(403, 'boom')).toBe('INTERNAL')
  })
})

describe('setupErrorHttpStatus', () => {
  const cases: Array<[SetupErrorCode, number]> = [
    ['REPO_ACCESS_DENIED', 403],
    ['REPO_NOT_FOUND', 404],
    ['RATE_LIMITED', 429],
    ['GITHUB_TOKEN_EXPIRED', 401],
    ['DISK_FULL', 507],
    ['CLONE_TIMEOUT', 504],
    ['DIAG_TIMEOUT', 504],
    ['DIAG_EMPTY_REPO', 422],
    ['INTERNAL', 500],
  ]
  it.each(cases)('%s -> %i', (code, status) => {
    expect(setupErrorHttpStatus(code)).toBe(status)
  })

  it('nunca devolve 5xx cru sem code para os casos do cliente (4xx nos casos de causa do cliente)', () => {
    expect(setupErrorHttpStatus('REPO_ACCESS_DENIED')).toBeLessThan(500)
    expect(setupErrorHttpStatus('REPO_NOT_FOUND')).toBeLessThan(500)
    expect(setupErrorHttpStatus('RATE_LIMITED')).toBeLessThan(500)
    expect(setupErrorHttpStatus('GITHUB_TOKEN_EXPIRED')).toBeLessThan(500)
  })
})
