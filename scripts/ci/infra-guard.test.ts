import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

// Roda o guard de verdade (bash), alimentando um unified diff pronto via
// '--diff-file=-' (stdin) — é o modo pensado justamente para teste, sem
// depender de um repo git de verdade nem de origin/main existir.
function runGuard(diffText: string) {
  return spawnSync('bash', ['scripts/ci/infra-guard.sh', '--diff-file=-'], {
    input: diffText,
    encoding: 'utf8',
  })
}

function runGuardAll() {
  return spawnSync('bash', ['scripts/ci/infra-guard.sh', '--all'], {
    encoding: 'utf8',
  })
}

test('diff limpo (só código inócuo) passa', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+export const x = 1
`
  const result = runGuard(diff)
  expect(result.status).toBe(0)
})

test('linha adicionada com token fake sk-ant-oat01 é barrada', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const token = 'sk-ant-oat01-ABCDEFGHIJ'
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('padrão de infra proibido')
})

test('linha adicionada com token fake ghp_ (GitHub) é barrada', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
})

test('linha adicionada com token fake AKIA (AWS) é barrada', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const key = 'AKIAIOSFODNN7EXAMPLE'
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
})

test('linha adicionada com token fake xoxb (Slack) é barrada', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const key = 'xoxb-1234567890-abcdefghij'
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
})

test('arquivo .claude/foo.json sendo adicionado é barrado pelo check de path', () => {
  const diff = `diff --git a/.claude/foo.json b/.claude/foo.json
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/.claude/foo.json
@@ -0,0 +1,1 @@
+{}
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('artefato local de VM/agente')
})

test('arquivo .sqlite sendo adicionado é barrado pelo check de path', () => {
  const diff = `diff --git a/apps/control-plane/x.sqlite b/apps/control-plane/x.sqlite
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/apps/control-plane/x.sqlite
@@ -0,0 +1,1 @@
+conteudo-binario-fake
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('artefato local de VM/agente')
})

test('regressão: IP de LAN (10.0.0.5) continua barrado', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const ip = '10.0.0.5'
`
  const result = runGuard(diff)
  expect(result.status).not.toBe(0)
})

test('escape inline infra-guard-allow ainda funciona para o check de conteúdo', () => {
  const diff = `diff --git a/scripts/foo.ts b/scripts/foo.ts
index 111..222 100644
--- a/scripts/foo.ts
+++ b/scripts/foo.ts
@@ -1,0 +2,1 @@
+const token = 'sk-ant-oat01-ABCDEFGHIJ' // infra-guard-allow: token fake de exemplo, nao e credencial real
`
  const result = runGuard(diff)
  expect(result.status).toBe(0)
})

test('auditoria completa (--all) no repo atual não acusa débito novo', () => {
  const result = runGuardAll()
  expect(result.status).toBe(0)
})
