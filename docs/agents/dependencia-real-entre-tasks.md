# GitOrch — Dependência real entre tasks (D74, 05/09/2026)

**Status:** ATUAL — o contrato descrito aqui é imposto por código em
`packages/cadence/src/rails.ts` (`dependenciaTemJustificativa`) e cobrado em
`apps/control-plane/src/services/backlog-executor.ts` (`validateBacklogPlan`).

## 1. A decisão do dono

> "Só dependência real." (D74)

O planejador (PO, `role-rails.ts` → `runPoRails`) para de amarrar
`blockedByTaskIndexes` por hábito de ordem. Uma task só declara dependência de
outra quando **precisa do RESULTADO** dela para existir — nunca porque "faz
sentido" fazer depois, ou porque veio depois na conversa.

## 2. O problema medido (GitHub, 05/09/2026)

51 issues com a etiqueta de tarefa abertas nos dois repositórios do produto;
**39 travadas**. Em `GitOrchAI/gitorch`: 24 presas contra só 4 livres, numa
corrente linear literal —

```
#497 → #498 → #499 → #500 → #501 → #502 → #503 → #504 → #505 → #506 → #507 → #508 → #516 → #521
```

— com **15 vagas simultâneas** disponíveis no plano do dev assíncrono. No
repositório do Jardim: 15 presas contra 8 livres. Quem barra a delegação é
`apps/control-plane/src/services/fila-de-delegacao.ts:116`
(`c.bloqueadoresAbertos === 0`), lendo "Blocked by #N" do corpo da issue via
`extractBlockers` (`apps/control-plane/src/services/sm-delegation.ts:473`).

Esse portão de leitura está **correto** — uma task realmente bloqueada não
deve rodar antes da hora. O defeito é a ORIGEM: o schema (`poTasks`,
`packages/cadence/src/rails.ts`) sempre permitiu `blockedByTaskIndexes` sem
cobrar nada além do índice — nenhum código perguntava "por quê". O desenho do
backlog virou uma corrente de hábito, não uma árvore de dependências reais, e
15 vagas ficaram ociosas com 24 tasks presas atrás de uma única issue.

## 3. O critério: o que É dependência, o que NÃO é

**É dependência real** quando a task precisa de um RESULTADO concreto que a
outra produz:

- **Um artefato que ela produz.** Ex.: a task "#499 liga o filtro na tela do
  catálogo" precisa da rota `GET /produtos?material=` que "#498 cria a rota
  de filtro" produz — sem a rota, a tela não tem o que chamar.
- **Uma migração de banco que precisa existir antes.** Ex.: "#497 migração
  adiciona a coluna `material`" tem que rodar antes de "#498 filtra por
  `material` na rota" — a coluna é pré-requisito de dado, não de ordem.
- **Um contrato de dados ou interface que ela define.** Ex.: uma task que
  implementa o cliente de uma API interna precisa que a task que define o
  formato do payload (o contrato) já tenha decidido os campos — mudar o
  contrato depois quebra quem já implementou contra ele.

**NÃO é dependência** (mesmo que pareça natural encadear):

- **Ordem preferida de execução.** "Faz mais sentido fazer a #500 depois da
  #499" não é dependência — é preferência de sequenciamento, e o roadmap
  (`poRoadmap`) já resolve isso com números de sprint, sem travar a fila de
  delegação.
- **Tarefas que tocam a mesma área ou o mesmo arquivo.** Duas tasks que
  editam `apps/control-plane/src/services/scheduler.ts` não são dependentes
  entre si por isso — a reserva de arquivos declarados (já existente, ver
  §5) é quem evita dois devs colidindo no mesmo arquivo ao mesmo tempo; não
  é papel de `blockedByTaskIndexes` duplicar essa proteção.
- **"Faz sentido fazer depois."** Julgamento de prioridade não é dependência
  de resultado. Se não há um artefato, migração ou contrato concreto que a
  segunda task precise da primeira, a dependência é falsa.
- **Sequência numérica.** A corrente `#497 → #498 → ... → #521` do achado
  acima é o sintoma exato deste erro: 14 tasks encadeadas só porque nasceram
  em ordem no mesmo plano, não porque a #521 precisa de algo que só a #520
  produz.

Na dúvida: se a task bloqueadora fosse cancelada, a task bloqueada ainda
teria como ser feita (com uma decisão diferente, um dado mockado, uma rota
alternativa)? Se sim, não é dependência real.

## 4. Como o contrato cobra isso

`packages/cadence/src/rails.ts`:

- `PoTasksForm.tasks[].blockedByRationale?: string` — campo novo, ao lado de
  `blockedByTaskIndexes`. Preenchido pelo PO junto com o índice da task
  bloqueadora.
- `dependenciaTemJustificativa(blockedByTaskIndexes, blockedByRationale)` —
  função pura: sem `blockedByTaskIndexes` (ou array vazio), não exige nada;
  com `blockedByTaskIndexes` não vazio, exige `blockedByRationale` com pelo
  menos `MIN_CARACTERES_JUSTIFICATIVA_DE_DEPENDENCIA` (20) caracteres —
  citando o RESULTADO necessário, não uma frase vaga.
- O `MiniSchema` declarativo (o mesmo usado por todo `RAILS_SCHEMAS`) **não
  sabe validar** "campo X obrigatório só se campo Y está presente" — a mesma
  lacuna já documentada no comentário de `RAILS_SCHEMAS.devQuestion`. Por
  isso esta checagem vive em código, no mesmo padrão de `validateDoD` e
  `criterioEhTestavel` (checagens semânticas que o schema declarativo não
  expressa).

`apps/control-plane/src/services/backlog-executor.ts`:

- `BacklogPlan.tasks[].blockedByRationale?: string` — o mesmo campo, no tipo
  que `applyBacklog`/`validateBacklogPlan` consomem.
- `validateBacklogPlan` chama `dependenciaTemJustificativa` para cada task,
  no mesmo laço que já rejeita DoD incompleto e peso fora da escala —
  **all-or-nothing**: um plano com uma dependência sem justificativa não cria
  NENHUMA issue, do mesmo jeito que um plano com uma task sem DoD completo
  não cria nenhuma.

## 5. O que NÃO muda (lado que lê)

- `fila-de-delegacao.ts:116` (`c.bloqueadoresAbertos === 0`) continua
  exatamente como está. Uma dependência REAL, uma vez declarada com
  justificativa, ainda trava a delegação até o bloqueador fechar — isso é o
  comportamento certo, e não é o que causou a corrente de 39 issues presas.
- `extractBlockers` (`sm-delegation.ts:473`) continua lendo "Blocked by #N"
  do corpo da issue do jeito que já lê hoje.
- A reserva de arquivos declarados (proteção contra dois devs colidindo no
  mesmo arquivo) continua ligada e é quem resolve o caso "mesma área/mesmo
  arquivo" — não é substituída nem duplicada por este critério.

## 6. Fora do escopo desta entrega

A varredura das 39 issues já abertas (que dependência ali é real e qual é só
corrente de hábito, e o que fazer com as que já existem no GitHub) é etapa
separada — este documento e o código descrito acima cobrem só o contrato do
planejador para tasks NOVAS a partir de agora.
