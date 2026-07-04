# GitOrch — Contrato de comportamento dos agentes (lifecycle)

**Status:** ACORDADO com o owner (2026-07-04, sessão de brainstorming).
**Escopo:** define o que cada agente (RA, PO, SM, QA) faz nos eventos de ciclo de
vida de um projeto e como usam a memória. Engine-agnóstico (vale para os 3
motores: Claude, Codex, Antigravity).

## Princípios transversais

### Memória do projeto (Cortex) — cérebro compartilhado
- Cada projeto tem UMA memória (Cortex), isolada dos outros projetos (um projeto
  nunca vê a memória de outro).
- **Disciplina obrigatória:** toda missão COMEÇA lendo a memória (recall do que já
  se sabe do projeto) e TERMINA gravando o que descobriu na sua camada.
- Cada agente é dono da sua camada, mas todos leem tudo: contexto do RA, decisões
  do PO, estado do SM, evidências do QA. O projeto fica mais inteligente a cada
  ciclo; nenhum agente age no escuro.

### Gatilho do trabalho — híbrido
- Evento do GitHub tem prioridade: PR aberto → QA; issue nova → RA/PO.
- O cron agendado (por projeto) é a rede de segurança: sem evento, cada agente
  faz sua "ronda" no horário.

## Evento 1 — Projeto novo (onboarding coordenado)

Sequência única antes da cadência periódica começar:
1. **RA** — análise profunda: mapeia o código (codegraph/CGC), lê docs, monta a
   memória inicial (Cortex) e o entendimento do projeto.
2. **PO** — roadmap inicial a partir da memória do RA + wishlist do owner.
3. **SM** — backlog inicial no padrão Shrimp.
4. **QA** — aprende o que "correto" significa neste projeto (docs, testes, CI,
   critérios).

Garante que os 4 partem da mesma base de contexto.

## Evento 2 — Wishlist nova

Fluxo: **RA (contexto por fase) → PO (hierarquia) → SM (execução)**.

- **RA NÃO cria épicos/features/tasks** (isso é linguagem de produto, do PO). O RA:
  - é acordado e ENTENDE o desejo;
  - REGISTRA dúvidas para o owner (aparecem no painel e/ou Telegram) e segue com o
    que dá — NÃO trava o pipeline esperando resposta; marca as suposições;
  - faz a "engenharia reversa" no sentido de CONTEXTO: onde no código o pedido
    encaixa (codegraph/CGC), o que toca, riscos, dependências, pesquisa se preciso.
  - Entrega esse contexto **por fase** (a fase atual do roadmap), não um documentão
    de uma vez — casa com a entrega guiada por prazo.
- **PO** consome o contexto do RA + wishlist + prazos e constrói a hierarquia:
  **Fase → Épico → Feature → Task**, priorizada. Um desejo grande vira uma Fase com
  VÁRIOS épicos, não um épico só. A cada fase do roadmap, o RA alimenta novo
  contexto e o PO cria os épicos daquela fase.
- **SM** ajusta sprint/backlog com os épicos gerados.

## Evento 3 — Wake agendado (ronda quando não há evento)

- **RA:** varredura de melhoria contínua — dívida técnica, riscos, oportunidades;
  grava na memória.
- **PO:** revisa prioridades — o backlog ainda reflete os desejos e o estado real?
- **SM:** saúde do fluxo — impedimentos, atribui trabalho, garante o padrão das
  issues (Shrimp).
- **QA:** valida PRs abertos contra os critérios da issue + auditoria periódica de
  saúde do projeto.

## Pendências (a decidir em conversa futura com o owner)

- **GSTACK:** COMO e QUANDO cada agente usa o framework gstack (o fork renomeado do
  GitOrch), não a lista de comandos — o gstack em si. Qual agente aciona qual parte
  do framework e em que momento do fluxo.
- **MCPs por agente:** quais MCPs cada agente tem no seu ambiente isolado (ex.: QA
  com navegador headless + Postman; RA/PO com pesquisa/context7), como lista
  curada e fechada (nenhum MCP externo fora da lista).

## Nota de implementação (honesta)
Este contrato é engine-agnóstico. Em QA real (2026-07-04): Codex e Claude entregam
o deliverable estruturado de forma confiável seguindo o contrato via prompt +
priming. O Antigravity CLI (`agy --print --sandbox`) autentica e roda, mas ainda
NÃO converge para um deliverable estruturado de forma confiável (narra exploração
extensa) — precisa de tratamento específico do motor antes de contar como pronto.
