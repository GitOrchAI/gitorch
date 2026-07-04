#!/usr/bin/env node
// GitOrch PreToolUse gate for file/dir reads (`view_file`, `list_dir`).
// Restricts every read to the mission workspace (the paths GitOrch mounted).
// This does two jobs at once:
//   1. Focus — the engine cannot wander into its OWN builtin guide (under
//      $HOME/.gemini/...), the parent directory, or unrelated paths, which is
//      what makes it drift off-task and write meta "sandbox reports" instead of
//      the actual deliverable.
//   2. Security — a repo can't steer the agent into reading machine files,
//      credentials, or anything outside the checkout.
//
// Contract (agy-customizations/docs/hooks.md): stdin carries toolCall.args and
// workspacePaths; stdout is {"decision":"allow"} or {"decision":"deny",...}.

const fs = require('fs')

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function targetPath(args) {
  return args.AbsolutePath || args.DirectoryPath || args.FilePath || args.Path || args.path || ''
}

function logDeny(payload, target, kind) {
  try {
    const logPath = process.env.GITORCH_HOOK_LOG || '/tmp/gitorch-denied-commands.log'
    fs.appendFileSync(
      logPath,
      JSON.stringify({ t: new Date().toISOString(), read: target, kind, conversationId: payload.conversationId }) + '\n'
    )
  } catch {
    /* ignore */
  }
}

function within(target, root) {
  const a = String(target).replace(/\/+$/, '')
  const r = String(root).replace(/\/+$/, '')
  return a === r || a.startsWith(r + '/')
}

// AI-generated "cruft" that pollutes a repo: execution/resolution/verification
// reports, issue-close lists, PR-comment dumps, and other-agent scratch dirs.
// A suggestible engine READS these and copies their format (e.g. writes its own
// "Execution Report" instead of the mission's deliverable). We block READING
// their content — the agent still SEES them in a directory listing, so it can
// note them as repository cruft to be cleaned, without being hijacked by them.
const CRUFT_DIR = /(^|\/)\.(jules|itsm|agent|gitnexus|shrimp)(\/|$)/i
const CRUFT_DOC_EXT = /\.(md|markdown|txt|json)$/i
const CRUFT_KEYWORD =
  /(EXECUTION_REPORT|RESOLUTION|VERIFICATION|CHECKOUT_|MERGE_CONFLICT|ISSUES_TO_CLOSE|PR_COMMENT|HANDOFF|_REPORT|REPORT_|_SUMMARY|SUMMARY_|^TODOS?\b)/i

function isCruft(target) {
  const t = String(target)
  if (CRUFT_DIR.test(t)) return true
  const base = t.split('/').pop() || ''
  // Only ever treat DOC files as cruft — never source code — and only when the
  // name carries a report/scratch marker.
  return CRUFT_DOC_EXT.test(base) && CRUFT_KEYWORD.test(base)
}

function main() {
  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    payload = {}
  }
  const args = (payload.toolCall && payload.toolCall.args) || {}
  const target = targetPath(args)
  const roots = (payload.workspacePaths || []).filter(Boolean)

  // Block AI-cruft report files even INSIDE the workspace (they hijack the
  // engine into copying their format), but never block a plain directory
  // listing (the agent should still SEE that the cruft exists).
  const isFileRead = Boolean(args.AbsolutePath || args.FilePath)
  if (target && isFileRead && isCruft(target)) {
    logDeny(payload, target, 'cruft')
    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason:
          'GitOrch policy: this is a stale AI-generated report/scratch file, not source. Do NOT read ' +
          'it or copy its format. Note only that such cruft EXISTS in the repo (a cleanup finding for ' +
          'your deliverable) and analyze the actual source code and config instead.',
      })
    )
    return
  }

  // Fail-open only when we genuinely can't evaluate (no target, or no known
  // workspace roots). Otherwise the target MUST be inside a workspace root.
  const allowed = !target || roots.length === 0 || roots.some((r) => within(target, r))

  if (allowed) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }))
    return
  }

  logDeny(payload, target, 'outside-workspace')

  process.stdout.write(
    JSON.stringify({
      decision: 'deny',
      reason:
        'GitOrch policy: reads are restricted to the mission workspace. Analyze only files inside ' +
        'the repository you were given; do not read the engine\'s own guide/help, the home directory, ' +
        'or any path outside the workspace. Use what is in the workspace to produce your deliverable.',
    })
  )
}

main()
