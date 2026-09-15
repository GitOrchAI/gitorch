# Inventário: avisos por Telegram vs. timeline do painel

Este é o inventário completo exigido pelo critério de aceite da task
**a8e667c8-b069-477b-b535-4a7255e986a3** (DJ-T15, Shrimp gitorch): a régua de
D76 ("Telegram é para o que exige o DONO — uma decisão, um marco de entrega,
um incidente. Progresso e auditoria de rotina vão para o painel"), aplicada a
toda ocorrência de `avisarDonoDoProjeto`/`buildTelegramNotifier` em
`apps/control-plane/src`.

Reconstruído a partir de duas fontes cruzadas: o diff real da própria task
(commit que converteu as primeiras 10 ocorrências) e uma varredura nova,
`grep -rn "avisarDonoDoProjeto\|buildTelegramNotifier" apps/control-plane/src`,
para garantir que nada ficou de fora — inclusive a linha (então 8851) que o QA
encontrou vazando e que este mesmo commit corrige.

## As três classes

- **a — Executivo real.** O texto pede uma decisão, uma ação concreta do
  dono, ou é um marco de entrega/incidente. Vai (corretamente) para o
  Telegram — nunca convertido.
- **b — Auditoria já reconhecida por `classificarAviso`.** O texto bate um
  dos 4 padrões de rotina (`classe-do-aviso.ts`: "entregas barradas", "parei
  de reencaminhar", "voltou/voltaram para a fila", "Encanamento do
  GitOrch") — `avisarOuAuditar` já desviava isso do Telegram para o painel
  (evento `audit`) mesmo ANTES desta task, só sem dedupe por chave. Não era
  vazamento; converter ganhou só o dedupe.
- **c — Vazamento de status/andamento.** Texto que não bate nenhum padrão de
  `classificarAviso`, caía no default `'executivo'` e vazava para o
  Telegram, mas é puro progresso — nenhuma decisão pendente do dono. Alvo
  desta task: convertido para `registrarStatusNoPainel` (chave estável,
  nunca mais passa pelo reconhecimento de texto).

## Tabela — todas as ocorrências

| Arquivo:linha | Gatilho (o que dispara) | Classe | Justificativa | Status |
|---|---|---|---|---|
| `scheduler.ts:3961` (wiring) → `sm-watchdog.ts:157` | Task do GitHub travada após N retentativas do dev assíncrono (label `stuck` aplicada) | a | Escalação real para revisão humana — a esteira já desistiu de insistir sozinha | Convertido (leva anterior) para `registrarStatusNoPainel`, chave `sm-watchdog-travada:{repo}:{issue}` |
| `scheduler.ts:4808` | Motor terminou sem entregar e a saída lembra um pedido de login expirado | a→c* | *Inferência de infra, não decisão do dono — "a reserva da cadeia assume o trabalho" (autocura); nunca foi pedido de ação imediata | Convertido (leva anterior) para `registrarStatusNoPainel`, chave `credencial-expirada:{userId}:{runtime}` |
| `scheduler.ts:5626` | RA entendeu por que uma issue falhou 2× e ajustou o pedido para a 3ª tentativa | c | Puro status — "a esteira já corrige e segue", nada pede decisão do dono | Convertido (leva anterior), chave `analise-falhas-ra:{wingId}:{issues}` |
| `scheduler.ts:5941` | "Encanamento do GitOrch..." (achado de automação de `processar-achados-de-infra.ts`) | b | Já batia o padrão `/Encanamento do GitOrch/i` de `classificarAviso` — nunca chegava ao Telegram, só ao evento `audit` sem dedupe | Convertido (leva anterior) só para ganhar dedupe por chave; canal já era o painel antes |
| `scheduler.ts:6415` | 3º PR de conserto de incidente de infra fracassou — o RA para de insistir | c | Marco de autocura ("o RA vai fazer um retro sozinho"), não pede decisão — o incidente continua sendo acompanhado por `infraIncident` | Convertido (leva anterior), chave `incidente-infra-desistiu:{id}` |
| `scheduler.ts:6494` | Esteira parada por vaga do dev assíncrono ocupada, tarefas prontas esperando | c | "Volta a andar sozinha quando uma sessão terminar" — autocura explícita no texto | Convertido (leva anterior), chave `esteira-parada-vaga:{wingId}:{desde}` |
| `scheduler.ts:6785` | Entrega(s) devolvida(s) para a fila sem PR que mesclasse | c | Frase que motivou a régua do dono em 29/08 ("isso me torna um caos") — "a esteira vai tentar de novo" | Convertido (leva anterior), chave `entrega-voltou-fila:{projectId}:{issues}` |
| `scheduler.ts:7958` | Entrega mesclada (fluxo `encerrarEntrega`) | c | Marco de progresso, sem decisão pendente — o dono confere no painel quando quiser | Convertido (leva anterior), chave `entrega-mesclada:{wingId}:{commitSha}` |
| `scheduler.ts:8147` | Entrega mesclada pelo teto absoluto (`fecharComTetoAbsoluto`) | c | Mesmo marco do item acima, ramo irmão | Convertido (leva anterior), chave `entrega-mesclada:{wingId}:{commitSha}` |
| `scheduler.ts:8858` | QA/RA respondeu sozinho a uma dúvida técnica do dev (política `tudo`/`executivo-e-tecnico-bloqueante`) — texto "...já respondeu — nada bloqueado" | c | **Achado do QA nesta rodada (score 70).** O dev já foi respondido ANTES desta linha rodar — nunca bloqueante — mas o texto não batia nenhum padrão de `classificarAviso` e vazava para o Telegram pelo default `'executivo'` | **Convertido nesta sessão** para `registrarStatusNoPainel`, chave `duvida-resolvida:{repo}:{issueNumber}:{hashDaPergunta}` — dead code removido junto (`app.prisma.project.findUnique` que só existia para alimentar o Telegram) |
| `scheduler.ts:9724` | Publicação confirmada no ar, depois do merge | c | Mesmo marco de "entrega mesclada", etapa seguinte (foi ao ar) — sem decisão pendente | Convertido (leva anterior), chave `entrega-no-ar:{wingId}:{sessionName}` |
| `scheduler.ts:2408` (`marcarPrecisaReconectar`) | Conexão GitHub do dono virou `needs_reconnect` (login expirado) | a | Exige ação real do dono: reconectar a conta. Nível de USUÁRIO, não de projeto — por isso nunca passou por `avisarDonoDoProjeto` | Mantido — Telegram correto |
| `scheduler.ts:3554` → `sm-delegation.ts:892` | SM não conseguiu passar a tarefa para o dev; ela fica na fila sem ninguém trabalhando | a | "Notícia de negócio, não de infraestrutura" (comentário explícito no código) — tarefa sem dono precisa de decisão | Mantido — roteia por `avisarDonoDoProjeto`/`avisarOuAuditar` (chokepoint de texto), Telegram se `classificarAviso` disser `'executivo'` |
| `scheduler.ts:4170` → `qa-rails-mission.ts` (4 gatilhos: PR travado no teto de mescla L858, verificação parada L1176, resgate de entrega travada, projeto travado por julgamento repetido L1650) | PR ou verificação do QA travada e precisa de decisão | a | Todos pedem atenção real (PR travado, verificação sem avançar) — comentário no código chama este ponto de "o chokepoint que classifica executivo vs auditoria" | Mantido — mesmo chokepoint de `avisarDonoDoProjeto` |
| `scheduler.ts:6941` → `vigia-do-pr.ts:647` (case `'escalar'`) | Vigia do PR decidiu escalar um PR problemático | a | Escalação explícita de um problema que o vigia não resolveu sozinho | Mantido — mesmo chokepoint |
| `scheduler.ts:7305` | Retrospectiva semanal com melhoria identificada ("o que mais atrapalhou foi X") | a | Síntese executiva de negócio (o que impediu entregas na semana), não rotina de progresso — período saudável nem vira mensagem (`if (!melhoria) continue`) | Mantido — Telegram direto |
| `scheduler.ts:8474` (ramo `'desistir'` de `responderDuvidaPendente`) | Teto de tentativas de responder ao dev batido — "o trabalho está parado esperando essa resposta" | a | Ao contrário do item 8858 (nada bloqueado), aqui o trabalho FICA bloqueado — decisão real do dono | Mantido — Telegram correto |
| `scheduler.ts:8990` → `supor-duvida-pendente.ts` (3 gatilhos: sem conseguir reler a pergunta, parada há N dias, sem suposição segura) | Dúvida escalada ao dono venceu 24h (ou N dias) em silêncio | a | Texto pede decisão explícita ("só você decide o que fazer com este trabalho parado") | Mantido — passagem direta da função (`avisarDono: avisarDonoDoProjeto`) |
| `scheduler.ts:9778` | Publicação após merge "precisa de atenção" (veredito não confirmou nem falhou dentro do prazo) | a | Estado ambíguo que só o dono resolve — inclui número da issue de conserto quando aberta | Mantido — Telegram correto |
| `scheduler.ts:9807` | Entrega mesclada mas sem publicação identificável (`sem-publicacao`) | a | Veredito final, e D47 manda sempre perguntar em vez de assumir quando falta contexto | Mantido — Telegram correto (e sempre seguido de uma pergunta via `agentQuestion`) |
| `scheduler.ts:10088` | Motor de execução (Codex/Antigravity/Claude) revogado, credencial precisa renovar | a | Ação real do dono (reconectar o motor). Nível de USUÁRIO, mesma razão do item 2408 | Mantido — Telegram direto |
| `scheduler.ts:10612` | Quadro do GitHub Projects V2 indefinido — sprint não anda | a | Ação real do dono (criar/ligar um quadro). Já grava no painel (`event.create` tipo `audit`) ANTES de mandar o Telegram — canal duplo intencional para bloqueio persistente | Mantido — Telegram + painel |
| `banco-atrasado.ts:80` (`notificadorDaInstancia`, usado em `conferirBancoNoArranque`) | Banco de dados atrasado em relação ao ledger de migrações, no arranque do processo | a | Crítico de infraestrutura com ação concreta (`bash scripts/db-migrate.sh`) — sem isto a esteira pode morrer em silêncio (incidente real de 26/08) | Mantido — Telegram direto, nível de instância (nem sempre há projeto em mãos no arranque) |

\* A linha `credencial-expirada` está listada como "a→c" porque o texto tem
tom de alerta (parece pedir ação imediata), mas a decisão do dono já foi
tomada quando esta task rodou: o texto termina afirmando que "a reserva da
cadeia assume o trabalho" — é a mesma classe dos outros vazamentos de
status, só com um texto mais grave.

## Mecanismos e definições (não são avisos individuais)

Estas linhas aparecem no grep mas são o encanamento em si, não uma mensagem
a classificar:

- `scheduler.ts:2183-2217` (`avisarOuAuditar`) — o chokepoint real: chama
  `classificarAviso(texto)` e decide entre gravar `event` tipo `audit` ou
  resolver o chat do dono e chamar `buildTelegramNotifier`.
- `scheduler.ts:7724` (`avisarDonoDoProjeto`) — wrapper fino que só chama
  `avisarOuAuditar(app, projeto, texto)`; é por ele que passam todos os
  itens classe `a` e `b` da tabela acima.
- `scheduler.ts:7742` (`registrarStatusNoPainel`) — o destino de toda
  conversão classe `c`: chama `registrarNoPainelUmaVez` (dedupe por
  `chave`), nunca toca Telegram.
- `sm-watchdog.ts:229` (`buildTelegramNotifier`) — o construtor do
  notificador HTTP puro (`fetch` contra a API do Telegram); usado pelo
  chokepoint acima e pelos avisos de nível de usuário (itens 2408, 10088) e
  de instância (`banco-atrasado.ts`).

## Fora do escopo desta task (nota para uma rodada futura)

`scheduler.ts:7340` constrói um `buildTelegramNotifier` cru e passa como
`avisarDono` direto para `vigiarSessoes` (`session-watch.ts`) — este caminho
**nunca** passa por `avisarDonoDoProjeto`/`classificarAviso`, então não é
capturado pelo grep desta task (que mirou só `avisarDonoDoProjeto`) nem pela
régua de texto. Os 4 gatilhos que ele alimenta:

1. Reentrega de pedido de retrabalho esgotou tentativas sem chegar ao dev —
   classe a (exige ação manual).
2. Issue fechada após 24h parada esperando o dev, dúvida já respondida —
   classe a (fechamento definitivo).
3. Sessão chegou a um estado de falha sem entregar PR, "o SM foi acionado
   para investigar" — **candidato a classe c** (autocura em andamento, texto
   parecido com os vazamentos já corrigidos), mas convertê-lo está fora do
   escopo dos dois achados desta rodada de QA.
4. Sessão abandonada após N tentativas de retomada sem sucesso — classe a
   (fechamento definitivo).

Registrado aqui para não se perder, não corrigido nesta task.
