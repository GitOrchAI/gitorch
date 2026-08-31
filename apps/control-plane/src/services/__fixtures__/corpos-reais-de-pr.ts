/**
 * Corpos REAIS de pull requests deste repositorio, capturados com
 * `gh pr view <n> --json body,author,labels,state` e colados aqui byte a byte (GERADOS, nao digitados).
 *
 * Existem pelo mesmo motivo de `.github/scripts/lib/__fixtures__/corpos-reais-de-pr.ts`: a decisao
 * do vigia e sobre TEXTO QUE HUMANOS E BOTS ESCREVEM, e corpo inventado por quem escreve o teste
 * tende a confirmar a regra que ele acabou de escrever. O corpo real traz o que ninguem lembraria
 * de simular — a prosa do dono que MENCIONA a automacao sem ser dela, e o rodape do dev com o link
 * da tarefa.
 *
 * O autor vem da API (`author.login`), que e o que o codigo le.
 */

/** PR #347 — PR do DONO, escrito a mao. Fala da automacao em prosa. Autor `loureng`, labels [], estado MERGED. */
export const CORPO_PR_347_DONO =
  '## Por quê\n\nMedido ao vivo em 29/08: a esteira do dev assíncrono (Jules) parou nos **dois** repos de teste. Causa raiz: das 23 sessões que a conta tem, **21 estão COMPLETED/FAILED** — o Jules já entregou ou falhou — mas o GitOrch nunca fecha essas linhas (`closed_at` fica nulo). O contador de concorrência somava **toda** linha aberta contra o teto de 15 da conta → `15 − 23 = −8` → `escolherParaDelegar` devolvia `[]` → **zero delegação**. No gitorch, 15 linhas COMPLETED abertas = teto batido; o patinhas, com 8, ainda delegava.\n\nSessão terminada no Jules **não ocupa vaga de concorrência lá** — a vaga libera no instante em que a sessão termina. Contá-la aqui era erro puro de contabilidade.\n\n## O que muda (ESTEIRA-T0 + T1, camada A)\n\n**T0 — migração** (`esteira-terminal-migration.sql`, base do resto do plano):\n- `dev_sessions.requeue_count` / `analysis_done_at` — para o passo terminal e a análise de 2 falhas (D51), nas próximas PRs.\n- tabela `infra_incidents` — rastreio de incidente de CI/CD pela identidade **estável** do workflow (`wf:<workflow_id>`), nunca pelo nome que o Dependabot muda a cada rodada.\n- Aditiva/idempotente. Entrada no `MIGRATION_LEDGER`; espelho no `schema.prisma`; mock de teste atualizado.\n\n**T1 — o conserto agudo:**\n- `estados-de-sessao.ts` — fonte única. `ESTADOS_TERMINAIS = {COMPLETED, FAILED, CANCELLED}`; `ESTADOS_QUE_OCUPAM_VAGA` = os que o Jules ainda está tocando. `ocupaVaga()` / `ehTerminal()` com **fail-closed** para estado desconhecido.\n- `fila-de-delegacao.ts` — o fallback de `vivasQueContam` passa a filtrar por `ocupaVaga(state)`; novo `ocupamVagaNaConta` pré-calculado.\n- `scheduler.ts` — novo `count ocupamVagaNaConta` (`closedAt:null AND state notIn TERMINAIS`), repassado por `montarOpcoesDeDelegacao`. **Achado:** a função computava `vivasNaConta` mas nunca o entregava ao `escolherParaDelegar` — o teto da conta estava inerte. Agora `vivasNaConta` é só log.\n- `sm-delegation.ts` — repassa `ocupamVagaNaConta` / `vivasNaConta` ao `escolherParaDelegar`.\n\n## Testes\n\n- `estados-de-sessao.test.ts` (8) · `fila-de-delegacao.test.ts` (+2) · `sm-delegation.test.ts` (+2 — 15 COMPLETED não travam a delegação real; conta cheia por outro projeto barra) · `scheduler-teto-delegacao.test.ts` (+1) · `migration-ledger.test.ts` (drift guard).\n- Suíte completa: 2570 testes do control-plane + todos os pacotes verdes. `tsc` + `eslint --max-warnings 0` limpos.\n- Migração aplicada e verificada no banco de dev (`db-migrate.sh` + `\\d`).\n\n## Prova pós-merge\n\nApós deploy: log ao vivo do SM voltando a delegar no gitorch (`ocupamVagaNaConta` real ~0, folga = 15).\n\nPlano completo: `docs/superpowers/plans/2026-08-29-destravar-esteira-e-subsistema-cicd.md` (T0..T13).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'

export const AUTOR_PR_347 = 'loureng'

export const LABELS_PR_347: string[] = []

/** PR #361 — PR do DONO, escrito a mao. Cita o Dependabot e tres issues por numero. Autor `loureng`, labels [], estado MERGED. */
export const CORPO_PR_361_DONO =
  'CAMADA C (ESTEIRA-T9, SUPERSEDE 8ca431a5). **Empilhado em #359** — base `fix/esteira-ra-po-infra`. Os incidentes #24/#188/#216 eram o MESMO bug do Dependabot, reabertos a cada varredura porque nada olhava se já tinha issue/PR e nada fechava quando sarava.\n\n- **fechar-incidente-resolvido.ts** (regras PURAS): `decidirFechamentoDeIncidente` (última run verde DEPOIS do conserto → fecha issue + `cleared_at`; PR mesclado mas run não rodou → espera; job do Dependabot/alerta → PR mesclado basta); `mesmaCausa` / `agruparPorCausa` (2 achados com path + assinatura de erro compartilhados = UM `infra_incidents`); `varrerIncidentesResolvidos` (driver best-effort, deps injetadas).\n- **sm-delegation.ts**: `issuesComPrDeIncidente` (Map issueNumber→prNumber) tira da fila a issue de incidente que já tem PR aberto e comenta "coberto por #PR" 1x (idempotente por marcador).\n- **scheduler.ts**: `varrerIncidentesDeInfraResolvidos` na cadência do sensor (wake do SM) — relê a última run do workflow (`wf:<id>`) + `merged_at` do PR, aplica a regra, `PATCH state=closed` + `update cleared_at`. Passa `issuesComPrDeIncidente` + `comentarCoberturaDeIncidente` ao SM. + **endurecimento da revisão de segurança do T8**: `ghIssue` confere o formato `dono/repo` antes de montar a URL.\n\n`build` + `eslint` (projeto todo) limpos; 14 testes novos + 57 arquivos de plugin/serviço (324) + pre-commit hook verdes.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'

export const AUTOR_PR_361 = 'loureng'

export const LABELS_PR_361: string[] = []

/** PR #356 — PR do dev assincrono, ABERTO e orfao (sessao fechada como pr-rejeitado-sem-retomada). Autor `loureng`, labels ["jules-conflict-notified"], estado OPEN. */
export const CORPO_PR_356_DEV =
  "The issue #329 describes a failure of the 'Infra Guard' workflow on the `main` branch. However, the root cause—a leaked VM internal IP (`100.77.141.44`) and path (`/home/ubuntu/projects/gitorch`) in `AGENTS.md`—has already been resolved in a prior commit (`4b8ce47`).\n\nThe local CI run of `scripts/ci/infra-guard.sh` and the Secret scan (`gitleaks`) both execute cleanly on the current `main` branch. \n\nThis PR simply contains a trivial whitespace addition to `AGENTS.md` to trigger a PR creation, satisfying the requirement to formally close the incident issue.\n\n---\n*PR created automatically by Jules for task [11545412311253110690](https://jules.google.com/task/11545412311253110690) started by @loureng*"

export const AUTOR_PR_356 = 'loureng'

export const LABELS_PR_356: string[] = ['jules-conflict-notified']

/** PR #408 — PR do dev assincrono, ABERTO e com sessao VIVA — quem cuida dele e a vigia de sessoes. Autor `loureng`, labels [], estado OPEN. */
export const CORPO_PR_408_DEV =
  "This PR implements the `/esperas` Telegram command as requested in #265.\n\nIt queries the `Mission` model directly for missions that have `status: 'waiting'` and a non-null `waitingReason`, retrieving the `issueNumber` from the JSON payload. This avoids cross-talk issues that would arise if the relation to `DevSession` were queried via the `Project` relation, ensuring each message accurately reflects its associated issue. The output string is correctly formatted into a single line, effectively replacing newlines in the waiting reasons with spaces.\n\nVerification Criteria satisfied:\n1. `X entregas aguardando: #Y - motivo, ...` output.\n2. `0 entregas aguardando.` output when none exist.\n3. No newline characters returned in output logic.\n\n---\n*PR created automatically by Jules for task [6355343329827661619](https://jules.google.com/task/6355343329827661619) started by @loureng*"

export const AUTOR_PR_408 = 'loureng'

export const LABELS_PR_408: string[] = []
