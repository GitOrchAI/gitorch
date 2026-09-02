# Dependabot + Jules Automation System (removido)

**02/09/2026 (decisão do dono, D62):** os 6 workflows descritos originalmente
neste documento — `code-scanning-to-jules.yml`, `dependabot-to-jules.yml`,
`jules-apology-handler.yml`, `jules-auto-recovery.yml`,
`jules-pr-ci-failure.yml` e `jules-pr-conflict.yml` — foram **removidos** do
repositório, junto dos scripts que só existiam para eles
(`.github/scripts/{analyze-ci-failure,analyze-conflicts,analyze-jules-failure,
generate-codeql-prompt,generate-jules-prompt}.ts` e a `lib/` que só eles usavam:
`jules-client.ts`, `log-extraction.ts`, `notification-cooldown.ts`,
`openrouter-client.ts`).

Motivo: o GitOrch é a única esteira. Resgate de conflito de merge e de CI
vermelho em PR da automação passou a ser responsabilidade do próprio produto,
não de um workflow de Actions acionando o Jules por fora:

- conflito de merge → `apps/control-plane/src/services/conflito-de-merge.ts`
- vigilância/retomada de PR travado → `apps/control-plane/src/services/vigia-do-pr.ts`
- julgamento e merge → QA do GitOrch (control-plane), como já valia desde a
  D54 de 29/08/2026 para o merge automático.

O que **continua** vivo em `.github/scripts` (esteira de infra do próprio
repositório, fora do escopo do GitOrch-produto):

- `sla-tracker.ts` / `.github/workflows/sla-tracker.yml` — monitora SLA de
  alerta de segurança e abre issue de breach.
- `lib/pr-eligibility.ts` — não é mais chamado por script nenhum aqui, mas
  segue como fonte de verdade lida por
  `apps/control-plane/src/services/vigia-do-pr.test.ts` (teste de paridade
  entre a regra do rodapé do dev assíncrono e a cópia usada no produto). Não
  remover sem antes atualizar esse teste.

O conteúdo histórico completo (arquitetura, segredos, troubleshooting) que
descrevia os workflows removidos pode ser consultado no histórico do git
deste arquivo antes de 02/09/2026 (task Shrimp `155e5958-598d-47ea-b5b6-eb23dbaa6699`).
