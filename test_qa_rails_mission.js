const fs = require('fs')

const filepath = 'apps/control-plane/src/services/qa-rails-mission.test.ts'
let content = fs.readFileSync(filepath, 'utf8')

// let's inject a test where it tests that if `legadoMereceExplicacao` is true,
// the comment is posted once with the explanation.

const searchBlock = `  it('reprovado do portão: NÃO rejulga se a verificação continua vermelha (não houve volta)', async () => {`

const replaceBlock = `  it('legado L4-T17: explica o culpado UMA vez num parecer antigo com CI ainda vermelho', async () => {
    let reviewPosted = false
    const deps = createDeps({
      // The PR is open
      gh: createGhMock({
        pulls: [{ number: 1, head: { sha: 'sha1' }, body: 'fixes #2' }],
        issues: { 2: { labels: [{ name: 'jules' }] } },
        pullsGet: { number: 1, head: { sha: 'sha1' }, changed_files: 1, additions: 1, deletions: 1 },
        // it was rejected before the cutoff of L4-T17.
        reviews: [
          {
            id: 88,
            commit_id: 'sha1',
            // Old date for L4-T17
            submitted_at: '2026-09-07T00:00:00Z',
            // Just a regular request changes text, without the mark
            body: 'GitOrch QA verdict: REQUEST CHANGES (see comment).\\n\\nSomething went wrong.',
          },
        ],
        // The check-runs show a real failure and a cancellation
        checkRuns: [
          { id: 101, name: 'Job1', conclusion: 'failure', status: 'completed' },
          { id: 102, name: 'Job2', conclusion: 'cancelled', status: 'completed' },
        ],
        jobs: {
          101: { steps: [{ name: 'Passo1', conclusion: 'failure', completed_at: '2026-09-07T00:05:00Z' }] },
        },
        pullFiles: [{ filename: 'a.js', status: 'modified', patch: '+a' }],
        onPostReview: (body) => {
          if (body.body.includes('dentro de \`Job1\` — e o resto foi cancelado')) {
             reviewPosted = true
          }
        },
      }),
      sessoes: [{ issueNumber: 2, sessionName: 'sessao-2', mergeFailures: 0 }],
      execute: async () => JSON.stringify({ verdict: 'request_changes', comment: { implementationGuide: '...' } }),
    })

    const r = await runQaMissionViaRails(deps)
    expect(r.exitCode).toBe(0)
    // It should have posted a review with the explanation of the cancelation
    expect(reviewPosted).toBe(true)
    // The warning message should exist
    expect(deps.warns.some(w => w.includes('reescrevendo o parecer para explicar a falha'))).toBe(true)
  })

  it('legado L4-T17: idempotente, NÃO re-explica se já tem a marca de rejulgamento', async () => {
    let reviewPosted = false
    const deps = createDeps({
      gh: createGhMock({
        pulls: [{ number: 1, head: { sha: 'sha1' }, body: 'fixes #2' }],
        issues: { 2: { labels: [{ name: 'jules' }] } },
        pullsGet: { number: 1, head: { sha: 'sha1' }, changed_files: 1, additions: 1, deletions: 1 },
        reviews: [
          {
            id: 88,
            commit_id: 'sha1',
            submitted_at: '2026-09-07T00:00:00Z',
            // the mark of legacy
            body: '<!-- GITORCH:LEGADO_REJULGADO -->\\nGitOrch QA verdict: REQUEST CHANGES (see comment).\\n\\nSomething went wrong.',
          },
        ],
        checkRuns: [
          { id: 101, name: 'Job1', conclusion: 'failure', status: 'completed' },
        ],
        jobs: {
          101: { steps: [{ name: 'Passo1', conclusion: 'failure', completed_at: '2026-09-07T00:05:00Z' }] },
        },
        onPostReview: () => {
             reviewPosted = true
        },
      }),
      sessoes: [{ issueNumber: 2, sessionName: 'sessao-2', mergeFailures: 0 }],
    })

    const r = await runQaMissionViaRails(deps)
    expect(r.exitCode).toBe(0)
    expect(r.noOp).toBe(true)
    expect(reviewPosted).toBe(false)
  })

  it('reprovado do portão: NÃO rejulga se a verificação continua vermelha (não houve volta)', async () => {`

content = content.replace(searchBlock, replaceBlock)
fs.writeFileSync(filepath, content)
