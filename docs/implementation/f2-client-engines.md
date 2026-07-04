# Fase 2 — Motores do cliente (multi-tenant)

**Branch:** `feat/f2-client-engines`
**Objetivo:** o cliente traz seus próprios motores (Claude, Codex, Antigravity),
conectados por OAuth, isolados por tenant, escolhidos por projeto, com failover e
catálogo dinâmico de modelos.

## O que muda

### Conexão de motor por usuário (F2.1)
- `credential-crypto`: cifra credenciais de motor em repouso (AES-256-GCM
  autenticado; chave `GITORCH_CREDENTIAL_KEY`; envelope com byte de versão para
  rotação; erro tipado `CredentialDecryptError`).
- `credential-archive`: empacota/restaura APENAS os arquivos de token (não o
  diretório do motor, que tem GBs de histórico/cache); recusa symlink (lstat) e
  path traversal; restaura com permissão 0700/0600.
- `EngineConnectionService`: captura de um HOME logado, cifra e guarda por
  usuário (`EngineConnection`); restaura sob demanda. Caminhos de credencial por
  runtime configuráveis (`GITORCH_ENGINE_CRED_PATHS`).
- Rotas: `GET /api/v1/engines` (status, nunca o segredo), `DELETE
  /api/v1/engines/:runtime`.

### Seleção por projeto + herança (F2.2)
- `runtime-resolver`: motor+modelo por agente lidos de
  `project.runtimeConfig.agents`, com cadeia de fallback e queda para o padrão
  da instância. Nada de motor hardcoded no scheduler.

### Credencial do dono no container (F2.5)
- `podman-runner` ganha `prepareMounts`: por missão, materializa a credencial do
  DONO do projeto num staging temporário (0700), monta read-only em
  `/run/gitorch-credentials`, o entrypoint copia para o HOME gravável, e o
  staging é apagado no `finally`. Varredura de staging no boot (crash não deixa
  token em disco). Falha de descriptografia NÃO é mascarada.

### Failover (F2.4)
- O scheduler tenta a cadeia de motores do projeto; erro de cota/rate/auth
  (`isFailoverError`) OU timeout/hang (exit 124) cai para o próximo motor do
  MESMO cliente; erro sistêmico encerra em failed. `startedAt` é reiniciado a
  cada tentativa (a varredura de stale não descarta um sucesso posterior).

### Catálogo de modelos (F2.3)
- `model-catalog`: descoberta por provider (agy models; models_cache do Codex;
  lista conhecida do Claude, `GITORCH_CLAUDE_MODELS`), guardada em
  `EngineConnection.models`; refresh sob demanda. Descoberta vazia não sobrescreve
  um catálogo bom.

### Priming por papel + injeção no workspace (F2.6)
- `priming`: RA/QA são técnicos e PODEM montar dev/testar; PO/SM são de
  coordenação; todos DEVEM convergir e entregar o deliverable.
- `workspace-priming`: injeta os arquivos de instrução do GitOrch na raiz do
  clone e neutraliza os do repo (renomeia para `.gitorch-orig`), **commitando** a
  mudança — o Antigravity CLI segue os arquivos da raiz acima do prompt e reseta
  o working tree via git durante a exploração; sem o commit, ele desfazia a
  injeção e voltava ao processo do repo.

## QA real (visto, não deduzido)
- 3 motores autenticam DENTRO do container com a credencial cifrada do dono
  (`CODEX_IN_CONTAINER_OK`, `CLAUDE_IN_CONTAINER_OK`, agy idem).
- Catálogo ao vivo: antigravity 8, codex 3, claude 4 modelos.
- Matriz RA: Codex e Claude entregam Research Brief completo; Antigravity
  converge com a injeção commitada.

## Revisão adversarial
Dois revisores (segurança + correção) sobre a diff; 11 achados, todos corrigidos
antes do merge (detalhes no corpo do PR e no commit de correções).

## Pendência conhecida (mesmo gate "sem cliente externo")
- Refresh de modelos de provider CLI (`agy models`) ainda executa no host, não no
  container — containerizar é fast-follow antes do primeiro cliente externo.
