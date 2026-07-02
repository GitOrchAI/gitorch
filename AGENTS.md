# Google Antigravity Global Rules (AGENTS.md)

Este arquivo é a fonte canônica de comportamento global para os agentes no ecossistema do Google Antigravity (v2.1.4).

## Perfil do Usuário
- **Guilherme** é CEO, planejador estratégico e orientado a resultados.
- **Idioma:** Toda e qualquer comunicação deve ser realizada estritamente em **Português (PT-BR)**.
- **Clareza Executiva:** Priorize uma comunicação direta e de negócios. Evite jargões técnicos complexos e inexplicados. Se um termo técnico for indispensável, explique-o brevemente na mesma resposta.

## Regra Mestra: Descobrir em vez de Assumir
Nunca assuma stack, banco de dados, deploy, hospedagem, framework, ferramentas ou infraestrutura.
Antes de tomar qualquer ação no código, descubra os fatos reais por meio de evidências:
1. **Contexto do Projeto:** Identifique qual projeto está ativo e qual é o seu caminho físico.
2. **Regras Locais:** Leia o `GEMINI.md`, `AGENTS.md`, `CLAUDE.md` ou outra documentação de regras na raiz do projeto, se existirem. Elas sobrepõem as diretrizes globais para assuntos locais.
3. **Código Real:** Verifique manifestos de build, dependências (`package.json`, `pnpm-workspace.yaml`), configurações de banco (`schema.prisma`, migrations), dockerfiles e workflows do GitHub Actions.
4. **Capacidades Ativas:** Descubra os MCPs e Skills reais expostos nesta sessão.

*Proibido agir no "eu acho". Descubra primeiro, depois planeje, depois execute.*

---

## Matriz de Gatilhos de MCPs (Uso Inteligente e Obrigatório)

Você deve usar os servidores MCPs acoplados a cenários específicos, de acordo com as diretrizes abaixo:

| Cenário / Necessidade | MCP a Utilizar | Ação e Validação Obrigatória |
| :--- | :--- | :--- |
| **Antes de editar qualquer código existente (classe, função, método)** | `gitnexus` | Rodar `gitnexus:impact` para verificar o blast radius (caladores diretos, riscos e processos afetados). Reportar o risco (se HIGH ou CRITICAL) ao usuário. Executar `gitnexus:detect_changes` antes de qualquer commit para garantir escopo limpo. |
| **Consulta de bibliotecas, APIs externas, frameworks ou dependências** | `context7` | Rodar `context7:query-docs` para validar os contratos reais de código, assinaturas de classes e métodos de terceiros (ex: React, NestJS, Nest, etc.). Proibido adivinhar assinaturas ou tipos. |
| **Busca de erros de compilação externos, problemas de ambiente ou busca na web** | `perplexity` | Rodar `perplexity:search` ou `perplexity:chat_perplexity` para buscar resoluções de erros atualizadas, threads do GitHub ou documentações públicas que não estejam indexadas localmente. |
| **Criação, modificação, testes ou depuração de rotas e APIs (Backend)** | `postman-mcp-server` | Criar requisições ou rodar coleções reais de teste de API através de `postman-mcp-server:runCollection`. É obrigatório anexar os logs de resposta HTTP com sucesso como evidência de validação da API. |
| **Persistência de histórico de decisões, aprendizados e configurações** | `Supermemory` | Usar as ferramentas MCP do `supermemory` (como `supermemory:memory`) ao final de cada tarefa. É obrigatório manter a segregação de contexto associando a informação ao projeto adequado ou "guilherme-global" para regras gerais. |

---

## O Ciclo de Trabalho Metodológico (GStack + Superpowers)

Todo trabalho de implementação deve seguir o pipeline completo. É estritamente proibido pular etapas:

### Fase 1: Think (Pensar)
- **Ação:** Pesquise o contexto do código atual usando `gitnexus:context` ou `gitnexus:query` e documentações de frameworks com `context7:query-docs`.
- **Análise:** Execute `gitnexus:impact` nos arquivos afetados.

### Fase 2: Plan (Planejar - GStack ANTES do código)
- **Ação:** Execute `/office-hours` (se houver dúvidas de negócio) ou `/plan-ceo-review` (estratégia e escopo).
- **Rigor Técnico:** Valide a arquitetura com `/plan-eng-review` e `/plan-design-review` (se houver interface).
- **Documento:** Crie o `implementation_plan.md` com as decisões. **Antes de planejar:** Use `ask_question` para perguntas de múltipla escolha interativas sem interromper a conversa do chat. Não execute comandos de terminal modificadores ou de código sem o plano aprovado.

### Fase 3: Build (Construir - Superpowers DURANTE o código)
- **Ação:** Crie o `task.md` detalhado usando `superpowers:writing-plans`.
- **Execução:** Execute as tarefas de forma autônoma (God Mode) via `superpowers:executing-plans` ou `superpowers:subagent-driven-development` (para subtarefas).
- **Rigor:** Adote testes locais como guia via `superpowers:test-driven-development` (TDD, escreva um teste falhando antes do código de produção).

### Fase 4: Review (Revisar)
- **Ação:** Rodar `/review` (Staff Engineer Code Review) para a diff completa (lógica, efeitos colaterais e segurança de SQL).
- **Lentes Especialistas:** Dispare `/cso` (segurança STRIDE), `/design-review` (interface/UX), `/benchmark` (performance), ou `/devex-review` (DX), conforme a natureza do código alterado.

### Fase 5: Test (Testar - Evidência Real e Qualidade)
- **Rigor de Qualidade:** O build ou HTTP 200 não é prova de que funciona.
- **Validação de Backend:** Teste endpoints reais com `postman-mcp-server` de forma automatizada e anexe os logs no walkthrough.
- **Validação de Frontend:** Execute `/qa` ou abra o navegador headless com `/browse` e faça testes de cliques reais, fluxos completos de formulários, uploads de arquivos e exclusões. Verifique erros de console e rede.

### Fase 6: Ship (Publicar - GStack DEPOIS do código)
- **Ação:** Integre o código usando `superpowers:finishing-a-development-branch` e `/ship` ou `/land-and-deploy`.
- **Validação:** Acompanhe o deploy e execute `/canary` (monitoramento de produção pós-release).

### Fase 7: Reflect (Refletir - Memória e Fechamento)
- **Ação:** Atualize a documentação em `docs/` via `/document-release` ou `/document-generate`.
- **Memória:** Execute `/learn` e adicione o histórico no `supermemory` com a devida segregação de contexto. Gere o `walkthrough.md` com as evidências reais de funcionamento.

---

## Proibições Inquebráveis
1. **NUNCA MENTIR:** Não declare uma tarefa como concluída se você não testou clique-a-clique no navegador (frontend) ou não fez chamadas com Postman/testes automatizados (backend).
2. **NUNCA MASCARAR ERROS:** Proibido usar `|| true`, `continue-on-error`, skips artificiais ou desativar asserções para fazer builds ou deploys passarem. Trate a causa raiz do erro.
3. **NUNCA AGIR SEM PESQUISA:** Proibido propor correções sem investigar a causa raiz antes (`superpowers:systematic-debugging` ou `/investigate`).
4. **NUNCA USAR SUPERMEMORY SEM CONTEXTO CLARO:** Proibido adicionar memórias no Supermemory sem especificar a qual projeto ou escopo ("guilherme-global") a memória pertence.

---

## Regras Específicas para o Projeto gitorch
Sempre que for agir sobre o projeto `gitorch`, o agente deve seguir obrigatoriamente esta ordem de operações:
1. **Ler a Memória do Projeto:** Consultar as memórias sobre `gitorch` no Supermemory antes de qualquer ação.
   * *Fallback:* Caso o MCP nativo `supermemory` não esteja disponível/carregado na sessão atual, execute a busca utilizando o script utilitário de fallback `supermemory_helper.js` via Node.js:
     `node C:\Users\Admin\.gemini\antigravity\brain\45bd7286-5bc7-4e5b-8585-5dc8b805c313\scratch\supermemory_helper.js recall <termo_busca>`
2. **Mapear Impacto e Função:** Investigar a função ou lógica que precisa ser ajustada utilizando o `gitnexus` (com `gitnexus:impact`, `gitnexus:query` ou `gitnexus:context`) para compreender completamente o blast radius antes de realizar qualquer alteração física no código.
3. **Executar o Desenvolvimento:** Somente após a leitura da memória e compreensão do código via GitNexus iniciar o planejamento e a construção seguindo o ciclo metodológico.
4. **Persistir Aprendizados no Encerramento:** Após finalizar as alterações, salvar o histórico de decisões, mudanças e aprendizados de volta na memória do Supermemory com a tag `gitorch` (ou via helper script se o MCP não estiver ativo):
     `node C:\Users\Admin\.gemini\antigravity\brain\45bd7286-5bc7-4e5b-8585-5dc8b805c313\scratch\supermemory_helper.js save "Histórico estruturado da entrega do gitorch"`

4 .   * * A U T O N O M I A   T � C N I C A   ( R e g r a   G u i l h e r m e ) : * *   N U N C A   p e r g u n t e   a o   C E O   s o b r e   t e r m o s   t � c n i c o s ,   f r a m e w o r k s ,   a r q u i t e t u r a   o u   p a d r � e s   d e   p r o j e t o .   U t i l i z e   M C P s   ( P e r p l e x i t y ,   c o n t e x t 7 )   o u   p e s q u i s a   w e b   p a r a   d e c i d i r   a   m e l h o r   a b o r d a g e m   t � c n i c a   d e   f o r m a   a u t � n o m a .  
 