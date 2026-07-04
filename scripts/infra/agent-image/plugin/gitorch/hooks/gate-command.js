#!/usr/bin/env node
// GitOrch PreToolUse gate for `run_command`.
// Policy: the engine may run ONLY `gh`/`git` (its GitHub work) and read-only
// inspection commands. Everything else — package managers, builds, tests,
// linters, servers, arbitrary binaries, non-GitHub network — is DENIED at the
// engine layer (Deny is immediate; it never hangs headless). This kills both
// the background-task hang AND the sandbox-escape / data-exfiltration risk that
// a malicious repo AGENTS.md could try to trigger. Denials are logged for audit.
//
// Contract (see agy-customizations/docs/hooks.md): stdin is a JSON payload with
// toolCall.args.CommandLine; stdout must be {"decision":"allow"} or
// {"decision":"deny","reason":"..."}.

const fs = require('fs')

// Read-only inspection + the two GitHub tools. First token of every shell
// segment must be in this set, otherwise the whole command is denied.
const ALLOW = new Set([
  'gh', 'git',
  'ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'head', 'tail', 'wc',
  'sed', 'awk', 'cut', 'sort', 'uniq', 'tr', 'echo', 'printf', 'pwd', 'tree',
  'jq', 'dirname', 'basename', 'realpath', 'stat', 'file', 'which', 'env',
  'xargs', 'diff', 'true', 'test',
])

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function commandLineFrom(payload) {
  const args = (payload && payload.toolCall && payload.toolCall.args) || {}
  return args.CommandLine || args.commandLine || args.command || ''
}

// Split a shell command on the operators that chain separate commands, so a
// compound like `gh pr list | grep foo` is judged by BOTH `gh` and `grep`, and
// `gh x && npm y` is denied because of `npm`.
function segments(cmd) {
  return cmd
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function firstToken(segment) {
  // Drop leading env-assignments like FOO=bar cmd, and a leading sudo.
  const tokens = segment.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  if (tokens[i] === 'sudo' || tokens[i] === 'command') i++
  const tok = tokens[i] || ''
  return tok.split('/').pop() // strip any path prefix
}

function main() {
  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    payload = {}
  }
  const cmd = commandLineFrom(payload)
  const segs = segments(cmd)
  const allowed = segs.length > 0 && segs.every((s) => ALLOW.has(firstToken(s)))

  if (allowed) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }))
    return
  }

  // Audit the denial (best-effort; never fail the hook because of logging).
  try {
    const logPath = process.env.GITORCH_HOOK_LOG || '/tmp/gitorch-denied-commands.log'
    fs.appendFileSync(
      logPath,
      JSON.stringify({ t: new Date().toISOString(), conversationId: payload.conversationId, cmd }) + '\n'
    )
  } catch {
    /* ignore */
  }

  process.stdout.write(
    JSON.stringify({
      decision: 'deny',
      reason:
        'GitOrch policy: only `gh`, `git`, and read-only inspection commands are allowed. ' +
        'Do GitHub work via gh / the GitHub MCP and read files directly. Do NOT run builds, ' +
        'installers, tests, linters, servers, background tasks, or non-GitHub network calls.',
    })
  )
}

main()
