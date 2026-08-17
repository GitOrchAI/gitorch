/**
 * O par de GITORCH_FAKE_ENGINES (fake-engines.ts) para o ÚNICO ponto onde o
 * wizard fala de verdade com o GitHub fora da autenticação: a prova de que o
 * cliente pode ESCREVER no repositório declarado
 * (services/acesso-ao-repositorio.ts).
 *
 * O E2E do funil completo (GITORCH_FAKE_ENGINES=1, tests/e2e/
 * setup-wizard-funil-completo-fake.spec.ts) "conecta" o GitHub com um token
 * FAKE (createOwner() no spec) — de propósito, ele nunca fala com o GitHub de
 * verdade em lugar nenhum, EXCETO aqui: `podeEscreverNoRepositorio` chama
 * `https://api.github.com/repos/{...}` com esse token pra valer. O GitHub
 * responde 401 "Bad credentials", a guarda (corretamente) traduz isso em
 * `CredencialDoGithubInvalidaError`, e o passo final do wizard
 * (`POST /api/v1/setup/submit`) devolve HTTP 401 em vez de 200 — o funil que
 * o E2E prova nunca fecha.
 *
 * A guarda em si (acesso-ao-repositorio.ts) não ganha uma linha de exceção:
 * ela continua fazendo a MESMA pergunta direta ao GitHub, com a MESMA régua
 * (`permissions.push === true`), em QUALQUER ambiente — produção incluída. O
 * que muda é só o FIO que ela usa pra perguntar (`fetchImpl`, já injetável —
 * ver `DependenciasDeAcessoAoRepositorio`), e só nos pontos de wiring
 * (routes/setup.ts, routes/index.ts, plugins/telegram.ts,
 * plugins/scheduler.ts), e só quando os dois cadeados abrem:
 *
 * - `GITORCH_FAKE_GITHUB_ACCESS=1` explícito;
 * - `NODE_ENV !== 'production'`.
 *
 * Flag PRÓPRIA, separada de `GITORCH_FAKE_ENGINES` de propósito: ligar os
 * motores fake (login/liveness/modelos/quota) pra testar localmente NÃO
 * deveria, de brinde, desligar a prova de posse de repositório — são duas
 * preocupações diferentes, com dois cadeados diferentes, e ninguém deveria
 * conseguir desligar a segunda sem SABER que está desligando exatamente ela.
 * Ver .env.example para o aviso ao operador.
 */
export const FAKE_GITHUB_ACCESS_FLAG = 'GITORCH_FAKE_GITHUB_ACCESS'

export function fakeGithubAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAKE_GITHUB_ACCESS_FLAG] === '1' && env['NODE_ENV'] !== 'production'
}

/**
 * Substitui o `fetch` que `podeEscreverNoRepositorio` usa para perguntar ao
 * GitHub. Responde QUALQUER `GET /repos/{dono}/{repositorio}` como se o
 * portador do token tivesse `push` — o mesmo formato de corpo que a API real
 * devolve para quem administra o repositório (ver acesso-ao-repositorio.
 * test.ts: `COMO_DONO`), porque só `permissions.push` é lido do lado de cá.
 *
 * Nunca falha e nunca inspeciona o token: no E2E fake, o token é uma string
 * qualquer (`fake-github-token-<sufixo>`) que não corresponde a nada real, e a
 * única pergunta que interessa aqui é "o fio está mesmo desligado da rede?".
 */
export const fakeGithubAccessFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const fullName = url.split('/repos/')[1] ?? 'fake/repo'
  return new Response(
    JSON.stringify({
      full_name: fullName,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

/** `undefined` fora do modo fake — mantém `deps.fetchImpl ?? fetch` (o padrão real) intacto nos call sites. */
export function fetchImplParaProvaDeAcesso(): typeof fetch | undefined {
  return fakeGithubAccessEnabled() ? fakeGithubAccessFetch : undefined
}
