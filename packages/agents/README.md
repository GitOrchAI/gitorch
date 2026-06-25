# @gitorch/agents

`@gitorch/agents` is the F6 backend orchestration package for GitOrch.

It introduces runtime-independent internal agents for:

- PO
- RA
- SM
- QA

The same role can run on Codex CLI, Claude Code CLI, or Antigravity CLI. The MVP default mapping is:

| Role | Default runtime |
|---|---|
| PO | Codex CLI |
| RA | Claude Code CLI |
| SM | Antigravity CLI |
| QA | Antigravity CLI |

F6 keeps Jules separate. Jules is the async development executor, triggered and monitored through GitHub work items and PRs.

## Boundaries

F6 does not implement frontend configuration, interactive login, database migrations, queue workers, or a cloud sandbox. F7 owns interactive runtime login. F8 owns frontend runtime/model/reasoning/fallback configuration.

Runtime credentials are represented as credential references and provisioned into isolated execution environments. This package never stores raw secrets.

## Project onboarding

New project onboarding starts by understanding the project:

- map the repository with CodeSight/CGC;
- read or prepare repository docs;
- inspect issues, PRs, CI, Projects V2, hierarchy, and dependencies;
- classify existing issues as Epic, Feature, or Task;
- ask the owner only when code, docs, and GitHub state cannot answer the question;
- persist project understanding as GitOrch memory and repository docs.

It does not create new product work during recognition.

## QA gate

A PR is merge-ready only when:

- CI is green;
- `qa-only` passed;
- `review` passed;
- QA verified 100 percent of the requested scope.

If CI fails, GitOrch waits for Jules' CI fix loop. If CI is green but QA/review finds incomplete work, QA comments on the PR tagging `@jules` with issue-style adjustment instructions.
