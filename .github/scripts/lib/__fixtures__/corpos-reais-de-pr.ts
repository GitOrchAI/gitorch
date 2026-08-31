/**
 * Corpos REAIS de PRs deste repositório, capturados com
 * `gh pr view <n> --json body --jq '.body'` e colados aqui byte a byte (gerados, não digitados).
 *
 * Existem porque a decisão de elegibilidade é sobre TEXTO QUE HUMANOS E BOTS ESCREVEM, e texto
 * inventado por quem escreve o teste tende a confirmar a regra que ele acabou de escrever. Um
 * corpo real traz o que ninguém lembraria de simular: o link da tarefa no rodapé, a mudança de
 * formato entre versões do dev, e a prosa do dono que MENCIONA a automação sem ser dela.
 *
 * Autor e labels vêm da API REST (`pr.user.login`), que é o que o código lê — NÃO de
 * `gh --json author`, que normaliza `dependabot[bot]` para `app/dependabot`.
 */

/** PR #388 — dev assíncrono, MESCLADO. Autor `loureng`, sem label: só o rodapé o identifica. */
export const CORPO_PR_388_DEV =
  'Fixes issue #329 by updating `scripts/ci/infra-guard.sh` to safely normalize zero SHAs (`0000000000000000000000000000000000000000`) and fallback gracefully across git diff strategies (`${base}...HEAD` -> `${base}..HEAD` -> `HEAD~1...HEAD` -> `HEAD`), preventing `set -e -o pipefail` CI failures. Additional unit tests were added to `scripts/ci/infra-guard.test.ts`.\n\n---\n*PR created automatically by Jules for task [13060562796874471910](https://jules.google.com/task/13060562796874471910) started by @loureng*'

/** PR #393 — dev assíncrono, MESCLADO. Mesmo rodapé, corpo curto. */
export const CORPO_PR_393_DEV =
  'This PR triggers a workflow rerun to resolve a transient infrastructure failure on GitHub\'s side that caused the `CodeQL` workflow to fail with the error "The job was not acquired by Runner of type hosted even after multiple attempts".\n\nFixes #253.\n\n---\n*PR created automatically by Jules for task [13220677287628102928](https://jules.google.com/task/13220677287628102928) started by @loureng*'

/**
 * PR #347 — DO DONO, escrito à mão. Autor `loureng`, sem label. Fala da automação em prosa
 * ("a esteira do dev assíncrono (Jules) parou"), que é exatamente o caso que o gate antigo,
 * baseado em `body.includes(...)`, classificava errado.
 */
export const CORPO_PR_347_DONO =
  '## Por quê\n\nMedido ao vivo em 29/08: a esteira do dev assíncrono (Jules) parou nos **dois** repos de teste. Causa raiz: das 23 sessões que a conta tem, **21 estão COMPLETED/FAILED** — o Jules já entregou ou falhou — mas o GitOrch nunca fecha essas linhas (`closed_at` fica nulo). O contador de concorrência somava **toda** linha aberta contra o teto de 15 da conta → `15 − 23 = −8` → `escolherParaDelegar` devolvia `[]` → **zero delegação**. No gitorch, 15 linhas COMPLETED abertas = teto batido; o patinhas, com 8, ainda delegava.\n\nSessão terminada no Jules **não ocupa vaga de concorrência lá** — a vaga libera no instante em que a sessão termina. Contá-la aqui era erro puro de contabilidade.\n\n## O que muda (ESTEIRA-T0 + T1, camada A)\n\n**T0 — migração** (`esteira-terminal-migration.sql`, base do resto do plano):\n- `dev_sessions.requeue_count` / `analysis_done_at` — para o passo terminal e a análise de 2 falhas (D51), nas próximas PRs.\n- tabela `infra_incidents` — rastreio de incidente de CI/CD pela identidade **estável** do workflow (`wf:<workflow_id>`), nunca pelo nome que o Dependabot muda a cada rodada.\n- Aditiva/idempotente. Entrada no `MIGRATION_LEDGER`; espelho no `schema.prisma`; mock de teste atualizado.\n\n**T1 — o conserto agudo:**\n- `estados-de-sessao.ts` — fonte única. `ESTADOS_TERMINAIS = {COMPLETED, FAILED, CANCELLED}`; `ESTADOS_QUE_OCUPAM_VAGA` = os que o Jules ainda está tocando. `ocupaVaga()` / `ehTerminal()` com **fail-closed** para estado desconhecido.\n- `fila-de-delegacao.ts` — o fallback de `vivasQueContam` passa a filtrar por `ocupaVaga(state)`; novo `ocupamVagaNaConta` pré-calculado.\n- `scheduler.ts` — novo `count ocupamVagaNaConta` (`closedAt:null AND state notIn TERMINAIS`), repassado por `montarOpcoesDeDelegacao`. **Achado:** a função computava `vivasNaConta` mas nunca o entregava ao `escolherParaDelegar` — o teto da conta estava inerte. Agora `vivasNaConta` é só log.\n- `sm-delegation.ts` — repassa `ocupamVagaNaConta` / `vivasNaConta` ao `escolherParaDelegar`.\n\n## Testes\n\n- `estados-de-sessao.test.ts` (8) · `fila-de-delegacao.test.ts` (+2) · `sm-delegation.test.ts` (+2 — 15 COMPLETED não travam a delegação real; conta cheia por outro projeto barra) · `scheduler-teto-delegacao.test.ts` (+1) · `migration-ledger.test.ts` (drift guard).\n- Suíte completa: 2570 testes do control-plane + todos os pacotes verdes. `tsc` + `eslint --max-warnings 0` limpos.\n- Migração aplicada e verificada no banco de dev (`db-migrate.sh` + `\\d`).\n\n## Prova pós-merge\n\nApós deploy: log ao vivo do SM voltando a delegar no gitorch (`ocupamVagaNaConta` real ~0, folga = 15).\n\nPlano completo: `docs/superpowers/plans/2026-08-29-destravar-esteira-e-subsistema-cicd.md` (T0..T13).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'

/**
 * PR #361 — DO DONO, escrito à mão. Autor `loureng`, sem label. Cita o Dependabot e três
 * issues por número (#24/#188/#216) sem palavra-chave de fechamento.
 */
export const CORPO_PR_361_DONO =
  'CAMADA C (ESTEIRA-T9, SUPERSEDE 8ca431a5). **Empilhado em #359** — base `fix/esteira-ra-po-infra`. Os incidentes #24/#188/#216 eram o MESMO bug do Dependabot, reabertos a cada varredura porque nada olhava se já tinha issue/PR e nada fechava quando sarava.\n\n- **fechar-incidente-resolvido.ts** (regras PURAS): `decidirFechamentoDeIncidente` (última run verde DEPOIS do conserto → fecha issue + `cleared_at`; PR mesclado mas run não rodou → espera; job do Dependabot/alerta → PR mesclado basta); `mesmaCausa` / `agruparPorCausa` (2 achados com path + assinatura de erro compartilhados = UM `infra_incidents`); `varrerIncidentesResolvidos` (driver best-effort, deps injetadas).\n- **sm-delegation.ts**: `issuesComPrDeIncidente` (Map issueNumber→prNumber) tira da fila a issue de incidente que já tem PR aberto e comenta "coberto por #PR" 1x (idempotente por marcador).\n- **scheduler.ts**: `varrerIncidentesDeInfraResolvidos` na cadência do sensor (wake do SM) — relê a última run do workflow (`wf:<id>`) + `merged_at` do PR, aplica a regra, `PATCH state=closed` + `update cleared_at`. Passa `issuesComPrDeIncidente` + `comentarCoberturaDeIncidente` ao SM. + **endurecimento da revisão de segurança do T8**: `ghIssue` confere o formato `dono/repo` antes de montar a URL.\n\n`build` + `eslint` (projeto todo) limpos; 14 testes novos + 57 arquivos de plugin/serviço (324) + pre-commit hook verdes.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'

/**
 * PR #360 — Dependabot real. Autor REST `dependabot[bot]`, labels `dependabot`/`dependencies`.
 * TRUNCADO nos primeiros 380 de 28.875 caracteres (o resto são notas de release). Truncar é
 * seguro e não fabrica o resultado: o que torna este PR elegível é o AUTOR e a LABEL, não o
 * corpo — e foi verificado que o corpo COMPLETO tem zero ocorrências do rodapé do dev, então o
 * corte não pode ter escondido um sinal que mudaria o veredito.
 */
export const CORPO_PR_360_DEPENDABOT =
  'Bumps the development-dependencies group with 6 updates in the / directory:\n\n| Package | From | To |\n| --- | --- | --- |\n| [turbo](https://github.com/vercel/turborepo) | `2.10.11` | `2.10.12` |\n| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) | `22.10.2` | `22.20.1` |\n| [brace-expansion](https://github.com/juliangruber/brace-expansion) | '
