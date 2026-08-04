# GEMINI.md — GitOrch (Google Antigravity & Gemini Agent Rules)

Guia de contexto e comportamento do projeto **GitOrch** para o agente Gemini / Google Antigravity. Este arquivo espelha as regras globais e a integração de ferramentas do ecossistema (`CLAUDE.md` / `SKILL-MAP.md`).

## 👤 Quem é Guilherme
- **CEO** — perfil ENTJ, planejador estratégico e orientado a resultados.
- **Idioma:** Sempre **PT-BR**.
- **Comunicação Executiva:** Sem jargões técnicos complexos e inexplicados.

---

## 🧭 Regras Obrigatórias de Execução

1. **Memória Compartilhada (`mcp supermemory`):**
   - É estritamente **obrigatório** consultar o Supermemory (`containerTag: 'gitorch'`) no início de cada sessão/tarefa e gravar ao final da tarefa.
   - Claude Code e Antigravity (Gemini) compartilham a mesma memória no Supermemory.

2. **Grafo de Código (`Graphify` CLI):**
   - **Antes de editar qualquer código existente**: Rodar `graphify affected "<símbolo>"` / `graphify query` para verificar o blast radius.
   - **Após modificar código**: Rodar `graphify update .` para atualizar a base de conhecimento do grafo.

3. **Ciclo de Trabalho (Think → Plan → Build → Review → Test → Ship → Reflect):**
   - **Think:** Analisar a arquitetura com `graphify query` e `context7:query-docs`.
   - **Plan:** Criar plano escrito (`superpowers:writing-plans`) respaldado pelo spec aprovado.
   - **Build:** Desenvolver via TDD (`superpowers:test-driven-development`) com **commits atômicos por tarefa** (`tipo: descrição em PT-BR`).
   - **Gate por Task:** Registrar o hash do commit real no `.phase/state.json` (`commit: "<hash>"`). Proibido gates vazios (`T⚪ Q⚪ C⚪`).
   - **Review:** Disparar `/review` + lentes especialistas (`/design-review`, `/cso`, `/benchmark`).
   - **Test:** QA real no navegador (`/browse`) + testes unitários/E2E 100% verdes.
   - **Ship & Reflect:** Deploy acompanhado, atualização de `docs/` e registro no Supermemory.

---

## 🛠️ Comandos Reais do Repositório `gitorch`

```bash
pnpm install --frozen-lockfile   # Instalar dependências
pnpm run build                   # Build de todo o monorepo (Turborepo)
pnpm run test                    # Executar todos os testes
pnpm run lint:ci                 # Lint estrito (0 warnings tolerados)
pnpm run typecheck:strict        # Typecheck estrito (0 erros tolerados)
```

No backend `apps/control-plane`:
```bash
pnpm --filter @gitorch/control-plane run typecheck
pnpm --filter @gitorch/control-plane run test
pnpm --filter @gitorch/control-plane run prisma:generate
```

No frontend `apps/web`:
```bash
pnpm --filter web test
pnpm --filter web build
```

---

## ✋ Definição de Pronto (Zero Tolerance)
- NUNCA mentir sobre testes ou estado do código.
- NUNCA mascarar erros (`|| true`, skips).
- Somente declarar concluído após teste real verde no navegador/API e commit atômico gravado no gate do `.phase/state.json`.
