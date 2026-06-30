# Dependabot + Jules Automation System

A complete GitHub Actions automation pipeline for handling Dependabot security alerts using Google's Jules AI agent, with full lifecycle management: alert → issue → Jules PR → conflict resolution → CI auto-fix + fallback → auto-merge.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Dependabot     │────▶│  GitHub Issue   │────▶│  Jules Agent    │
│  Alert Created  │     │  (with prompt)  │     │  Creates PR     │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                              ┌──────────────────────────┼──────────────────────────┐
                              ▼                          ▼                          ▼
                    ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
                    │ Merge Conflict? │          │ CI Passes?      │          │ SLA Tracking    │
                    │ ──Yes──▶ @jules │          │ ──No──▶ Jules   │          │ 1 business day  │
                    │   resolution    │          │   auto-fix +    │          │ breach alerts   │
                    └─────────────────┘          │   1-day fallback│          └─────────────────┘
                                                 └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ Auto-Merge      │
                                                │ (Dependabot +   │
                                                │  Jules PRs)     │
                                                └─────────────────┘
```

## Components

### 1. Dependabot Alert → Jules Issue (`dependabot-alert-to-issue.yml`)
- **Triggers**: `dependabot_alert` webhook (created) + hourly schedule fallback
- **Process**: Fetches complete alert data (CVSS, CWE, EPSS, vulnerable versions, patched versions, references)
- **LLM Enhancement**: Uses OpenRouter free model to generate comprehensive Jules prompt
- **Output**: Creates GitHub issue with complete prompt, waits 10s, adds `jules` label
- **Rate Limiting**: 5-minute delay between multiple alerts to avoid Jules "failed to create task" errors

### 2. Merge Conflict Resolver (`jules-pr-conflict-resolver.yml`)
- **Triggers**: `pull_request_target` on Jules PRs (labeled, opened, synchronize)
- **Process**: Detects conflicts via `git merge --no-commit --no-ff`, extracts actual diff per file
- **Classification**: Categorizes conflicts (imports, logic, config, lockfile, types)
- **LLM Analysis**: Generates per-file resolution strategy with exact commands
- **Output**: Posts `@jules` comment with specific resolution instructions

### 3. CI Failure Fallback (`jules-pr-ci-failure-fallback.yml`)
- **Triggers**: `check_suite` completed with failure on Jules PRs
- **Condition**: Only runs if PR is open >1 business day
- **Process**: Fetches failed job logs, analyzes with issue + PR context
- **LLM Analysis**: Generates root cause and fix instructions for `@jules`
- **Built-in**: Jules has auto-fix (since Feb 2026), this is a safety net

### 4. Auto-Merge (`auto-merge.yml`)
- **Triggers**: `pull_request_target` on qualifying PRs + `check_suite` completion
- **Qualifying PRs**: Dependabot PRs OR Jules PRs (resolving 'jules' issues)
- **Process**: Waits for CI to pass, approves PR, enables auto-merge (squash)
- **Requirements**: Repo setting `allow_auto_merge=true`, SECURITY_PAT

### 5. SLA Tracker (`sla-tracker.yml`)
- **Schedule**: Every 4 hours
- **Process**: Calculates business days from alert creation to resolution
- **Breach**: Creates `sla-breach` issue with P0 priority when >1 business day
- **Tracking**: Links alerts → issues → PRs → merge status

## Required Secrets

| Secret | Description | Required For |
|--------|-------------|--------------|
| `SECURITY_PAT` | GitHub PAT with `contents:write`, `issues:write`, `pull-requests:write`, `security-events:read`, `actions:read` | All workflows |
| `OPENROUTER_API_KEY` | OpenRouter API key for free models | Prompt generation, conflict analysis, CI failure analysis |
| `JULES_API_KEY` | Jules API key (from https://jules.google.com/settings) | Optional - Currently used by existing `dependabot-pr-failure.yml` | Direct Jules API calls |

## Environment Variables (Configure in workflows or repo vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_FREE_MODEL` | `openrouter/free` | SEMPRE a rota free (zero hardcode). Aceita `openrouter/free` ou um modelo `:free`. |
| `SLA_BUSINESS_DAYS` | `1` | SLA threshold in business days |
| `ISSUE_CREATION_DELAY_MS` | `300000` (5 min) | Delay between multiple alert issues |
| `LABEL_DELAY_MS` | `10000` (10s) | Delay before adding `jules` label |
| `REPO_OWNER` | Auto-detected | Repository owner |
| `REPO_NAME` | Auto-detected | Repository name |

## Modelo de IA — SEMPRE a rota free

Usamos a **rota free do OpenRouter** (`openrouter/free`), que sorteia um modelo grátis por
chamada. **Nunca** hardcodamos um modelo: modelos free entram e saem, e a rota se adapta sozinha.

Risco conhecido: a rota pode sortear um modelo de **moderação/safety** (ex.:
`nvidia/nemotron-3.5-content-safety`) cuja única saída é um veredito tipo `User Safety: safe`.
O `openrouter-client.ts` detecta isso pelo campo `model` da resposta (`safety|guard|moderation`)
e por validação de conteúdo, e **re-chama a rota free** (re-sorteio) até obter resposta útil.
Sem isso, issues nasciam com corpo `User Safety: safe` (bug histórico — ex.: issue #153).

## Setup Instructions

1. **Add Secrets** to repository (Settings → Secrets and variables → Actions):
   ```
   SECURITY_PAT=<your-github-pat>
   OPENROUTER_API_KEY=<your-openrouter-key>
   JULES_API_KEY=<your-jules-api-key>  # Optional, for direct API
   ```

2. **Enable Repository Settings**:
   - Settings → General → Pull Requests → **Allow auto-merge** ✓
   - Settings → Actions → General → Workflow permissions → **Read and write permissions** ✓

3. **Install Jules GitHub App**:
   - Go to https://jules.google.com
   - Connect GitHub account
   - Grant access to this repository

4. **Enable Dependabot**:
   - Settings → Security & analysis → Dependabot alerts ✓
   - Settings → Security & analysis → Dependabot security updates ✓

5. **Deploy Workflows**:
   Copy all `.github/workflows/*.yml` and `.github/scripts/` to your repository.

## Workflow Files

| File | Purpose |
|------|---------|
| `dependabot-to-jules.yml` | Alerta → Issue com prompt Jules (webhook + schedule + manual) |
| `jules-pr-conflict.yml` | Detecta e resolve conflitos de merge (comenta @jules) |
| `jules-pr-ci-failure.yml` | Fallback de falha de CI (após 1 dia útil) |
| `jules-auto-recovery.yml` | Recupera "failed to create a task" (retry em ciclos) |
| `auto-merge.yml` | Auto-merge de PRs qualificadas (Dependabot/Jules) com CI verde |
| `sla-tracker.yml` | Monitora SLA e abre alerta de breach |

## Scripts

| Script | Purpose |
|--------|---------|
| `generate-jules-prompt.ts` | Fetches alert data + generates prompt |
| `analyze-conflicts.ts` | Git diff extraction + conflict analysis |
| `analyze-ci-failure.ts` | CI log fetching + failure analysis |
| `sla-tracker.ts` | Business day calculation + breach alerts |
| `lib/openrouter-client.ts` | Free model client + safety filter |

## Local Development

```bash
cd .github/scripts

# Install dependencies
bun install

# Type check
bun run typecheck

# Test scripts (requires env vars)
export SECURITY_PAT=<pat>
export OPENROUTER_API_KEY=<key>
export REPO_OWNER=<owner>
export REPO_NAME=<repo>

# Generate prompt for specific alert
bun run generate-jules-prompt.ts 123

# Analyze conflicts in PR
bun run analyze-conflicts.ts 456

# Analyze CI failure
bun run analyze-ci-failure.ts 456

# Run SLA tracker
bun run sla-tracker.ts 1
```

## SLA Policy

- **P0 Critical**: 1 business day from alert creation to resolution
- **Business Days**: Monday-Friday, excludes weekends
- **Breach**: Creates `sla-breach` issue with P0 label
- **Tracking**: Links alert → issue → PR → merge

## Troubleshooting

### "Jules has failed to create a task"
- The `jules-auto-recovery.yml` workflow handles this automatically
- It removes and re-adds the `jules` label when this error is detected
- Ensure 5-minute delay between issue creations

### Free model outputs "User Safety: safe"
- The `openrouter-client.ts` automatically filters this text
- If still appearing, check the sanitization patterns in the client

### Merge conflicts not detected
- Workflow uses `pull_request_target` for fork safety
- Ensure PR has `jules` label
- Check `jules-conflict-notified` label isn't already present

### CI failure fallback not triggering
- Only triggers after 1 business day
- Check PR has `jules` label
- Verify `check_suite` event is firing (some CI configs use different events)

### Auto-merge not working
- Ensure `allow_auto_merge=true` in repo settings
- SECURITY_PAT needs `contents:write` and `pull-requests:write`
- Check PR is mergeable (no conflicts, CI passing)

## Customization Points

1. **Prompt Templates**: Modify `generate-jules-prompt.ts` for different Jules instructions
2. **Conflict Resolution**: Adjust `analyze-conflicts.ts` classification/resolution logic
3. **SLA Threshold**: Change `SLA_BUSINESS_DAYS` env var
4. **Free Model**: Change `OPENROUTER_FREE_MODEL` env var
5. **Delay Intervals**: Adjust `ISSUE_CREATION_DELAY_MS` and `LABEL_DELAY_MS`

## Monitoring

- Check workflow runs in Actions tab
- SLA breach issues appear with `sla-breach` label
- Jules PRs have `jules` label
- Conflict notifications have `jules-conflict-notified` label

## Security Notes

- All write operations use `SECURITY_PAT` (not `GITHUB_TOKEN`)
- `pull_request_target` used for fork safety (reads fork PRs without write access)
- Free models only - no paid model costs
- API keys stored as GitHub Secrets (encrypted)

## Histórico de consolidação (2026-06-30)

Reconstrução limpa: workflows duplicados foram removidos e consolidados num único conjunto.

| Removido | Substituído por |
|----------|-----------------|
| `dependabot-alert-to-issue.yml` + `dependabot-alerts-to-issues.yml` + `manual-dependabot-processor.yml` | `dependabot-to-jules.yml` |
| `analyze-unmergeable-prs.yml` | `jules-pr-conflict.yml` |
| `dependabot-pr-failure.yml` (25KB, sobreposto) | `jules-pr-conflict.yml` + `jules-pr-ci-failure.yml` |

`security-alerts-to-issues.yml` (CodeQL/secret scanning) está **desligado** (`if: false`) até a
fase 2. O auto-PR de segurança do Dependabot foi **desligado** (repo setting
`automated-security-fixes`): vulnerabilidade vira alerta → Jules conserta.

---

*Generated by GitOrch Dependabot-Jules Automation System*