# QA manual: login assistido — Claude e Antigravity

> Este roteiro NÃO foi executado por automação. É o passo a passo que uma
> pessoa segue com o navegador de verdade, usando uma **conta de teste
> dedicada** (nunca a conta pessoal/produção de ninguém). Codex já tem
> cobertura automatizada do contrato de backend em
> `tests/e2e/setup-wizard-assisted-login-codex.spec.ts` — Claude e Antigravity
> não têm equivalente possível em CI porque a aprovação final acontece numa
> página OAuth real (`claude.com` / `accounts.google.com`), exigindo um
> humano clicando "Allow"/"Autorizar".

## Pré-requisitos

- [ ] Uma conta Anthropic de teste (e-mail dedicado, não a conta pessoal nem a
      de produção de ninguém).
- [ ] Uma conta Google de teste (idem — nunca a conta pessoal).
- [ ] O control-plane rodando (local ou o ambiente de QA) com
      `GITORCH_AGENT_IMAGE` apontando pra uma imagem que tenha os binários
      `claude` e `agy` reais.
- [ ] Navegador com DevTools aberto (aba Console + aba Network) durante todo
      o roteiro — qualquer erro ali é falha, mesmo que a tela "pareça" ter
      funcionado.

## Roteiro — Claude

1. Abrir o wizard (`/setup`) e avançar até o passo **"Conecte seus motores"**.
2. No card **Claude Code**, clicar no botão **"Conectar"**.
   - Esperado: o botão vira um indicador **"Verificando..."** por alguns
     segundos (o backend está subindo o container isolado e rodando
     `claude setup-token` real lá dentro).
3. Esperado em seguida: aparece o botão **"Abrir página de autorização"**, um
   campo de texto com o placeholder **"Cole o código da página…"**, e o texto
   **"Aguardando sua aprovação na página acima…"**.
   - Verificar que NÃO aparece nenhum código pronto no card (Claude não emite
     código no terminal — só a URL; o código vem da própria página de
     callback do OAuth, o usuário é quem cola de volta).
4. Clicar em **"Abrir página de autorização"** (abre em nova aba).
   - Verificar que a URL começa com `https://claude.com/cai/oauth/authorize`.
5. Na nova aba, fazer login/aprovar com a **conta de teste Anthropic**
   (nunca a pessoal).
   - Verificar que a página pede consentimento explícito antes de prosseguir
     (não deve autorizar "sozinha").
6. Depois de aprovar, a página de callback do Claude mostra um código de
   autorização em texto.
7. Copiar esse código, voltar pra aba do GitOrch, colar no campo **"Cole o
   código da página…"** do card Claude Code, e clicar em **"Enviar"**.
8. Esperado dentro de alguns segundos: o card Claude Code vira **"Conectado"**
   (ícone de check, borda de destaque).
   - Checar a aba Console: zero erros.
   - Checar a aba Network: nenhuma chamada com status 4xx/5xx relacionada a
     `/api/v1/engines/*`.
9. Recarregar a página do wizard (F5) e voltar no passo de conectar motores.
   - Esperado: o card Claude Code já aparece como **"Conectado"** direto (sem
     precisar clicar em nada) — confirma que a conexão persistiu no backend,
     não só no estado local da aba.

**Resultado esperado do passo Claude:** conectado, sem erro, credencial
persistida. Se qualquer subitem falhar, registrar exatamente onde parou (qual
passo, qual erro no console/network) — não marcar como "passou parcialmente".

## Roteiro — Antigravity

1. No mesmo passo do wizard, no card **Antigravity**, clicar em **"Conectar"**.
   - Esperado: mesmo indicador **"Verificando..."** (o backend precisa mandar
     um Enter inicial pro CLI escolher "Google OAuth" no menu antes da URL
     aparecer — não deveria levar mais que alguns segundos a mais que o
     Claude).
2. Esperado em seguida: botão **"Abrir página de autorização"** + campo
   **"Cole o código da página…"** + **"Aguardando sua aprovação na página
   acima…"** (mesmo padrão do Claude — Antigravity também não emite código no
   terminal).
3. Clicar em **"Abrir página de autorização"**.
   - Verificar que a URL começa com
     `https://accounts.google.com/o/oauth2/auth`.
4. Aprovar com a **conta de teste Google** (nunca a pessoal).
5. Depois de aprovar, o callback deve levar para (ou mostrar um código em)
   `antigravity.google/oauth-callback`.
6. Copiar o código, voltar pro GitOrch, colar no campo do card Antigravity e
   clicar em **"Enviar"**.
7. Esperado: card Antigravity vira **"Conectado"**.
   - Checar Console e Network como no passo 8 do Claude (zero erro).
8. Recarregar a página (F5) e confirmar que o card continua **"Conectado"**
   sem precisar reconectar (mesma verificação de persistência do Claude).

**Resultado esperado do passo Antigravity:** conectado, sem erro, credencial
persistida.

## Casos de erro a checar (não pular)

- [ ] Colar um código errado/expirado no campo de qualquer um dos dois
      motores: o card deve virar o estado de erro (mensagem "Não deu para
      conectar...") com um botão para tentar de novo — nunca travar
      silenciosamente em "Aguardando...".
- [ ] Clicar em "Conectar" duas vezes seguidas rápido no mesmo card: não deve
      abrir dois containers/duas sessões conflitantes (o frontend fecha a
      stream anterior antes de abrir uma nova — conferir que só uma sessão
      fica ativa e o resultado final é consistente).
- [ ] Deixar a aba do wizard parada na tela "Aguardando aprovação" por vários
      minutos sem aprovar: eventualmente o card deve virar erro por timeout
      (não ficar girando pra sempre) — não é preciso esperar o timeout todo
      pra fechar o QA, mas vale confirmar que o comportamento existe.

## Registro do resultado

Depois de rodar este roteiro com contas de teste reais, registrar o
resultado (passou / o que faltou / prints ou trechos de erro relevantes) na
memória do projeto — a fase de login assistido só pode ser considerada
concluída com este roteiro executado de verdade, mesmo que a cobertura
automatizada do Codex já esteja verde.
