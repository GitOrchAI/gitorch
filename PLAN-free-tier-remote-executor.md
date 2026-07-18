# Plano — Executor remoto de missões grátis na MT-SaaS

**Branch:** `feat/free-tier-remote-executor-mtsaas` (worktree isolada)
**Objetivo:** rodar missões de clientes de tier GRÁTIS em contêiner rootless na MT-SaaS
(máquina do colega), via Tailscale, com o segredo do cliente NUNCA tocando o disco de lá.

## Decisões travadas (Guilherme, 06/07)
- Pago = nossa VM; Grátis = MT-SaaS isolado.
- Segredo do cliente injetado via `podman --secret` em memória (tmpfs), zero rastro em disco.
- Contêiner rootless como usuário `gitorch` (sem sudo, sem docker do colega). JÁ PRONTO.
- Tier grátis "pobre de credencial" (decisão de produto, paralela).

## Prontos (infra verificada nesta sessão)
- [x] Usuário `gitorch` isolado na MT-SaaS + chave dedicada `~/.ssh/mtsaas_gitorch`.
- [x] Podman 4.9.3 rootless funcionando como `gitorch` (hello-world rodou).
- [x] Conectividade Tailscale nossa VM (<TAILSCALE_IP>) ↔ MT-SaaS.

## Tarefas (TDD + commits por fase)

### T1 — Imagem do agente x86_64 na MT-SaaS
- Obter binário `agy` x86_64 (o nosso é aarch64). Investigar origem/distribuição do agy.
- Rodar `infra/build-agent-image.sh` (repo privado de infra — migrado de
  `scripts/infra/build-agent-image.sh` na task t8) na MT-SaaS como `gitorch`
  (rootless) com `GITORCH_AGY_BIN` apontando pro binário x86_64 e
  `GITORCH_PUBLIC_REPO_ROOT` apontando pro checkout local deste repo público
  (fonte dos playbooks do Cadence). Verificar `podman images` mostra
  `localhost/gitorch-agent:latest`.
- DoD: `podman run gitorch-agent ...` executa um agy `--version` na MT-SaaS.

### T2 — Conexão podman remota (control plane → gitorch@MT-SaaS)
- `podman system connection add mtsaas ssh://gitorch@<TAILSCALE_IP> --identity ~/.ssh/mtsaas_gitorch`.
- Testar `podman --connection mtsaas run --rm gitorch-agent` da nossa VM.
- DoD: nossa VM lança contêiner rootless na MT-SaaS por Tailscale, sem tocar o docker do colega.

### T3 — Injeção de segredo em memória (o coração da segurança)
- Reescrever o caminho de credencial p/ execução remota: em vez de materializar arquivo
  0700 no disco (host local), criar `podman secret` a partir de um STREAM (stdin/pipe) e
  passar `--secret` ao run. O entrypoint lê o secret do tmpfs, nunca de disco persistente.
- Testes: (a) unit no adapter que constrói o comando; (b) prova de que NENHUM arquivo de
  credencial descriptografada aparece no disco da MT-SaaS durante/após a missão.
- DoD: teste de segurança verde — grep no disco remoto não acha o segredo em momento nenhum.

### T4 — Roteamento por tier (grátis → nó remoto)
- No scheduler: projeto de tier grátis → executor remoto (connection mtsaas); pago → local.
- Config dirigida a dados (plano do projeto no banco), nada hardcoded.
- DoD: missão de projeto grátis dispara na MT-SaaS; de projeto pago, na nossa VM.

### T5 — Prova E2E real
- Um projeto grátis de teste roda uma missão real ponta a ponta na MT-SaaS: clona repo,
  agente entrega brief, resultado volta, contêiner descartado, disco remoto limpo.
- QA real (não HTTP 200): ver a missão no painel, logs, container sumindo.

## Pipeline (CLAUDE.md god mode)
Cada T = commit(s). Ao fim: `/review` + lentes (`/cso` — segurança de segredo é o núcleo) →
QA real → testes E2E → PR → CI verde → docs → merge → deploy → memória.

## Riscos
- agy x86_64 pode não ter build pronto → investigar antes (bloqueador de T1).
- `podman --secret` via connection remota: validar que o secret vai pro tmpfs e some.
- fail2ban da MT-SaaS: conexões devem ser estáveis (chave certa, sem retintos falhos).
