export const locales = {
  en: {
    nav: {
      features: 'Features',
      anatomy: 'Anatomy',
      pricing: 'Pricing',
      login: 'Login',
      startAuto: 'Start Automation',
    },
    hero: {
      badge: 'PRO ORCHESTRATION',
      title: 'Orchestrate AI Agents Directly Inside Your GitHub Workflow.',
      subtitle:
        'GitOrch is the definitive control plane for software engineering automation. Connect your account and let autonomous agents manage, test, and document demands directly in your Issues and Projects V2. Without switching platforms, with zero friction.',
      ctaPrimary: 'Connect Repository For Free',
      ctaMicro: '1-click installation via GitHub App. No bureaucracy.',
      githubStars: 'GitHub Stars',
    },
    anatomy: {
      title: 'Anatomy of the Solution',
      subtitle: 'Stop managing code. Start orchestrating outcomes.',
      syncTitle: 'Native & Invisible Sync',
      syncDesc:
        'Your agents work where your team already is. They manage sub-issues, update schedules, and move cards in Projects V2 automatically.',
      ragTitle: 'Zero Code Hallucinations',
      ragDesc:
        'The engine maps the entire architecture, dependencies, and repository impact before acting. Agents make decisions based on facts, not guesses.',
      cortexTitle: 'Coordination & Long-Term Memory',
      cortexDesc:
        'Agents talk to each other and remember the context of past deliveries. Less rework and more autonomy for complex end-to-end tasks.',
    },
    pricing: {
      recommended: 'RECOMMENDED',
      title: 'Scale Your Automations',
      subtitle: 'From single developers to enterprise fleets.',
      openCore: 'Open Core',
      openCorePrice: '$0',
      openCoreTarget: 'For individual developers and enthusiasts',
      openCoreDesc: 'Open source to run on your own infrastructure (self-hosted).',
      cloudPro: 'Cloud Pro',
      cloudProPrice: 'Usage Based',
      cloudProTarget: 'Ideal for growing tech teams',
      cloudProDesc:
        'We manage infrastructure and isolated testing environments with full cloud dashboards.',
      enterprise: 'Enterprise',
      enterprisePrice: 'Custom',
      enterpriseTarget: 'For corporations demanding max security',
      enterpriseDesc:
        'Secrets Vault, full log auditing, and rigid data compliance. Dedicated support.',
      btnFree: 'View Source',
      btnPro: 'Start Trial',
      btnEnterprise: 'Talk to Sales',
    },
    dashboard: {
      statsCompleted: 'Completed Missions',
      statsFailed: 'Failed Missions',
      recentMissions: 'Recent Missions (live)',
      noMissions: 'No missions yet. Your agents will report here as soon as they run.',
      connectTitle: 'Connect to see your agents',
      connectDesc: 'Sign in with GitHub in the setup to see your real missions, live.',
      connectBtn: 'Go to setup',
      connectCheckError:
        "We couldn't confirm your session (connection issue). If you're already logged in, try reloading.",
      checkingSession: 'Checking your session…',
      loadError: 'Could not reach the GitOrch API. Check that your session is valid.',
      title: 'Agents Control Center',
      activeMissions: 'Active Missions',
      uptime: 'Uptime',
      successRate: 'Success Rate',
      agentStatus: 'Agent Core: Operational',
      cognitiveLogs: 'Cognitive Log (Synapse Engine)',
      blastRadius: 'Blast Radius & Affected Files',
      relaunchBtn: 'Trigger Agent Mission',
    },
    setup: {
      begin: 'Get started',
      next: 'Continue',
      back: 'Back',
      retry: 'Try again',
      connected: 'Connected',
      welcomeTitle: 'Start your setup',
      welcomeDesc:
        "Welcome to the GitOrch Setup Wizard. We'll isolate your environment, connect your repositories, and prepare your intelligent agents to code autonomously.",
      githubTitle: 'Connect your GitHub',
      githubDesc:
        'Sign in with GitHub so the agents can read the repositories you choose and open pull requests on your behalf.',
      githubBtn: 'Continue with GitHub',
      termsTitle: 'Terms of Service & Policies',
      termsDesc: 'Please review and accept the terms so we can isolate and set up your workspace.',
      terms1Title: '1. Data collection & GitHub access',
      terms1Body:
        'GitOrch reads the repositories you select to give the agents semantic context (RAG). We never change your code without your explicit authorization or a pull-request trigger.',
      terms2Title: '2. CLI engines & credentials',
      terms2Body:
        'We support Claude Code, Codex and Antigravity. Your tokens are kept encrypted in the Control Plane vault for assisted authentication and coding tasks.',
      terms3Title: '3. Privacy & storage',
      terms3Body:
        'Data extracted from commits and files is stored isolated per tenant. We never use your proprietary data to train global language models.',
      termsAccept: 'I have read and accept the GitOrch terms of service and privacy policy.',
      termsAcceptBtn: 'Accept & continue',
      termsAccepting: 'Preparing your environment…',
      termsEnvError: 'Could not prepare your environment. Please try again.',
      reposTitle: 'Select your repositories',
      reposDesc: 'Choose which repositories the GitOrch AI agents will work on.',
      reposLoading: 'Loading your GitHub repositories...',
      reposCloning: 'Cloning your repositories into your environment…',
      cloneError: 'Could not clone your repositories. Please try again.',
      reposError: 'Failed to load your GitHub repositories.',
      reposSearch: 'Search repository...',
      reposEmpty: 'No repositories found.',
      reposPrivate: 'Private',
      diagTitle: 'Reading your repository',
      diagDesc: 'No AI involved yet — this is real, structural analysis of your code, free.',
      diagLoadingClone: 'Cloning your repository…',
      diagLoadingIndex: 'Reading the code structure…',
      diagLoadingGithub: 'Checking issues, pull requests and CI…',
      diagEmptyTitle: 'Not much to read yet',
      diagEmptyBody:
        "This repository doesn't have enough recognizable source code for a structural read. You can pick another one, or continue — the agents can still work here.",
      diagErrorTitle: 'Could not read this repository',
      diagErrorBody:
        'Something went wrong while cloning or reading the code. Check access and try again.',
      diagRetry: 'Try again',
      diagScoreLabel: 'Repo health',
      diagVerdictGood: 'Solid foundation. A few things to tighten up.',
      diagVerdictWarn: 'Workable, but some real friction is slowing the team down.',
      diagVerdictBad: 'This repo is fighting back — there is real, fixable pain here.',
      diagFindingHealthyCore:
        'Core structure looks solid — {{fileCount}} files indexed, nothing alarming found.',
      diagFindingUntestedRatio:
        '{{percent}}% of the code ({{untestedCount}} of {{totalCount}} files) has no matching tests — changes there are a bet, not a certainty.',
      diagFindingStalePrs:
        '{{staleCount}} of {{openCount}} open pull requests have been sitting still for a while.',
      diagFindingCiFailing:
        'The most recent CI run failed — the main branch may be broken right now.',
      diagFindingOpenIssues: '{{openIssues}} open issues are piling up.',
      diagDetailsToggle: 'See the technical details',
      diagDetailsFiles: 'Files indexed',
      diagDetailsLargest: 'Largest files',
      diagDetailsMostCalled: 'Most-called functions',
      diagDetailsDirs: 'Directory inventory',
      diagContinue: 'Connect an engine to fix this',
      diagGraphLoading: 'Building the 3D graph…',
      diagGraphTruncated: 'Large repository — graph aggregated by directory.',
      diagGraphExpand: 'Expand graph',
      diagGraphCollapse: 'Close',
      diagGraphPanelTitle: 'Selected symbol',
      diagGraphPanelFile: 'File',
      diagGraphPanelType: 'Type',
      diagGraphPanelHealth: 'Health',
      diagGraphPanelDirectory: '{{count}} symbols in this directory',
      diagGraphPanelEmpty: 'Click a node to see its details.',
      diagGraphUnavailable: "Couldn't build the 3D graph — showing the technical details instead.",
      enginesTitle: 'Choose your engines',
      enginesDesc: 'Pick which AI engines will work in your repository. All three are equals.',
      engClaudeDesc:
        "Anthropic's official terminal agent. Great for deep refactors, running local commands and untangling complex bugs right on the working branch.",
      engCodexDesc:
        "OpenAI's coding agent. Strong at focused, read-first analysis and precise changes across the repository.",
      engAntigravityDesc:
        'Our own automation engine. Runs in the background orchestrating full workflows and integrating with the Control Plane.',
      planTitle: 'Choose your plan',
      planDesc: 'Adopt GitOrch entirely for free, or start a 30-day cloud trial.',
      planPopular: 'Popular',
      planFreeName: 'Free',
      planFreeTag: '1 repository',
      planFreeDesc: 'Great for solo developers or quick tests on a single personal project.',
      planFreeF1: '1 active repository',
      planFreeF2: 'Local engines (self-hosted)',
      planFreeF3: 'RAG processing limits',
      planProName: 'Cloud Pro',
      planProTag: 'Up to 2 repos',
      planProPer: '/mo',
      planProDesc: '30 days free. Full cloud access for growing teams. Redirects via Stripe.',
      planProF1: 'Up to 2 active repositories',
      planProF2: 'Autonomous execution on our cloud',
      planProF3: 'No token rate limit',
      planProF4: 'Extra telemetry integrations',
      confirmTitle: 'Confirm & launch',
      confirmDesc:
        'Review your choices. When you continue, the system clones the repositories and activates the engines.',
      confirmOverTitle: 'Repository limit exceeded',
      confirmOverBody:
        'You chose the Free plan, which allows at most 1 active repository. Remove the extra repositories below to continue:',
      confirmPlanLabel: 'Selected plan',
      confirmEnginesLabel: 'Active engines',
      confirmReposLabel: 'Repositories',
      confirmRemove: 'Remove',
      confirmFreePlan: 'Free plan',
      confirmSubmit: 'Finish & clone',
      confirmSubmitting: 'Cloning & starting...',
      confirmPayNext:
        'Next we create your environment and show your API key — you will only see it once. Payment comes right after that.',
      connectTitle: 'Connect your engines',
      connectDesc:
        'Sign in to each engine with your own account — you just click a link, authorize on the provider’s page, and paste the code back. Nothing to install, no terminal. All three work the same way — connect at least one to continue.',
      connectPaste: 'Paste here',
      connectBtn: 'Connect',
      connecting: 'Checking...',
      connectedLabel: 'Connected',
      connectModelsLabel: 'models',
      connectQuotaLabel: 'quota',
      // 21/07: Claude's real usage (`claude -p "/usage"`) — % used per window
      // (session/week) with each reset time. Replaces the old generic caption
      // ("quota managed by your subscription") now that we actually collect it.
      connectClaudeSessionLabel: 'Session',
      connectClaudeWeekLabel: 'Week (all models)',
      connectClaudeUsedLabel: 'used',
      connectClaudeResetsLabel: 'resets',
      connectGate: 'Connect at least one engine to continue.',
      connectError: 'Could not connect. Check what you pasted and try again.',
      connectOpenLink: 'Open authorization page',
      connectPasteCodePlaceholder: 'Authorization page code',
      connectSubmitCode: 'Submit',
      connectWaitingApproval: 'Waiting for your approval on the page above…',
      connectManualToggle: 'Problems? Paste the token manually',
      connectManualHintEnv:
        'Paste the `claude setup-token` token (starts with sk-ant-oat…) — this is not the authorization page code.',
      connectManualHintFile:
        'Paste the contents of the credential file the CLI created (e.g. auth.json) — this is not the authorization page code.',
      connectManualSubmit: 'Connect with what I pasted',
      connectVerifying: 'Verifying the connection…',
      connectErrorHintTerms:
        'If the Antigravity Terms screen got stuck, paste the credential manually below.',
      connectErrorHintCapture:
        'We could not capture the token automatically. Paste what the CLI printed below.',
      connectErrorHintGeneric: 'You can also paste the token manually below.',
      connectManualLooksLikeCode:
        'This looks like the authorization page code — paste it in the "Authorization page code" field above instead.',
      tgTitle: 'Telegram alerts (optional)',
      tgDesc:
        'Get a ping when a task in your project gets stuck or needs you. Tap the button, press Start in Telegram, and you are connected.',
      tgBenefit1: 'Updates when there is news about your project',
      tgBenefit2: 'Alerts when something breaks (incidents)',
      tgBenefit3: 'Questions from the agents, with buttons to reply right in the chat',
      tgBenefit4: 'Ask for improvements anytime with /wish',
      tgConnect: 'Connect my Telegram',
      tgWaiting: 'Telegram is open — press Start there. We are waiting for it, right here.',
      tgLinked: 'Telegram connected — alerts about your project land in this chat.',
      tgError: 'We could not connect right now. Try again, or set it up later from the panel.',
      tgRetry: 'Try again',
      tgOptional: 'Optional. You can connect later from the panel — nothing here is lost.',
      readyTitle: 'Your environment is coming to life',
      readyDesc:
        'Your project and credentials are set. The agents are warming up — follow along from the panel.',
      readyLedgerRepo: 'Repositories linked',
      readyLedgerEngines: 'Engines connected',
      readyLedgerActivating: 'Environment activating',
      readyLedgerActivatingDesc:
        'Cortex memory, the code graph and Cadence orchestration are warming up for your repo.',
      readyLedgerActivatingQueued: 'Queued: provisioning starts in a moment.',
      readyLedgerActivatingQueuedPosition:
        'In queue (position {{position}}): the instance is at capacity — provisioning starts as soon as a slot frees up.',
      readyLedgerActivatingRunning:
        'Cloning your repository and starting the engines inside your environment.',
      readyLedgerActivatingSlow:
        'This is taking longer than usual. Provisioning keeps running in the background — refresh to see the current state.',
      readyLedgerActivatingReady: 'Environment is live',
      readyLedgerActivatingFailed: 'Provisioning failed',
      readyLedgerActivatingFailedDesc:
        'We could not provision your environment. You can try again.',
      readyRefresh: 'Refresh',
      readyRetry: 'Try again',
      readyResourcesTitle: 'Your isolated environment is ready with:',
      readyResourcesCommit: 'GitOrch resources at version {{commit}}',
      readyResourcesPreparing: 'Preparing your environment…',
      readyKeys: 'Your API key',
      readyKeyOnce:
        'This is the only time we show your key. We only store a scrambled version of it, so not even we can display it again — copy it now and keep it somewhere safe.',
      readyKeySaved: 'I have saved my key somewhere safe',
      readyKeyCopy: 'Copy the key',
      readyLockedHint: 'Copy the key (or tick the box above) to continue.',
      readyKeysHint:
        'Add this secret to your GitHub Actions so agents running on GitHub can report back:',
      readyGoPay: 'Go to payment',
      readyPaying: 'Opening payment...',
      readyPayFailed:
        'We could not open payment right now. Your environment and key are ready — try again or head to the panel.',
      readyPayCapacity:
        'We are at capacity right now. Your environment and key are ready — we will reach out to unlock the paid plan.',
      readyGoPanel: 'Go to the panel',
      planIntent: 'You came in with this plan — you can still change it below.',
      reposFreeNote:
        'Your Free plan includes 1 active repository. Pick your most important one, or upgrade for more.',
      startOver: 'Start over',
      startOverError: 'Could not reset your environment. Please try again.',
      errREPO_ACCESS_DENIED:
        'Access denied. Make sure GitOrch has permission to this repository (reconnect GitHub if needed), then try again.',
      errREPO_NOT_FOUND:
        'We could not find this repository. Check that the name is right and that you still have access to it.',
      errRATE_LIMITED: 'GitHub is rate-limiting requests right now. Wait a minute and try again.',
      errDISK_FULL:
        'We ran out of storage on our side while working on this. Try again in a moment — if it keeps happening, start over.',
      errCLONE_TIMEOUT:
        'Cloning this repository took too long (it may be large, or the connection is slow). Try again.',
      errDIAG_TIMEOUT:
        'Reading this repository took too long. Try again, or continue without the free read.',
      errDIAG_EMPTY_REPO:
        "This repository doesn't have any commits yet. Push some code to it first, then try again.",
      errGITHUB_TOKEN_EXPIRED:
        'Your GitHub access has expired. The login expired or was revoked — sign in with GitHub again to continue.',
      errINTERNAL: 'Something unexpected happened on our side. Try again in a moment.',
      reposSignInAgain: 'Sign in to GitHub again',
    },
  },
  pt: {
    nav: {
      features: 'Recursos',
      anatomy: 'Anatomia',
      pricing: 'Preços',
      login: 'Entrar',
      startAuto: 'Iniciar Automação',
    },
    hero: {
      badge: 'ORQUESTRAÇÃO PROFISSIONAL',
      title: 'Orquestre Agentes de IA Diretamente no Fluxo do seu GitHub.',
      subtitle:
        'O GitOrch é o plano de controle definitivo para automação de engenharia de software. Conecte sua conta e coloque agentes autônomos para gerenciar, testar e documentar demandas direto nas suas Issues e Projetos V2. Sem mudar de plataforma, com fricção zero.',
      ctaPrimary: 'Conectar Repositório Gratuitamente',
      ctaMicro: 'Instalação em 1 clique via GitHub App. Sem burocracia.',
      githubStars: 'GitHub Stars',
    },
    anatomy: {
      title: 'Anatomia da Solução',
      subtitle: 'Pare de gerenciar código. Comece a orquestrar resultados.',
      syncTitle: 'Sincronização Nativa e Invisível',
      syncDesc:
        'Seus agentes trabalham onde seu time já está. Eles gerenciam sub-issues, atualizam cronogramas e movem cards no Projects V2 automaticamente.',
      ragTitle: 'Zero Alucinações de Código',
      ragDesc:
        'A engine mapeia toda a arquitetura, dependências e impacto do repositório antes de agir. Os agentes tomam decisões baseadas em fatos, não em palpites.',
      cortexTitle: 'Coordenação e Memória de Longo Prazo',
      cortexDesc:
        'Os agentes conversam entre si e lembram do contexto de entregas passadas. Menos retrabalho e mais autonomia para tarefas complexas de ponta a ponta.',
    },
    pricing: {
      recommended: 'RECOMENDADO',
      title: 'Escale suas Automações',
      subtitle: 'De desenvolvedores solos a frotas corporativas.',
      openCore: 'Open Core',
      openCorePrice: 'R$ 0',
      openCoreTarget: 'Para desenvolvedores individuais e entusiastas',
      openCoreDesc: 'Código aberto para rodar na própria infraestrutura (auto-hospedado).',
      cloudPro: 'Cloud Pro',
      cloudProPrice: 'Sob Demanda',
      cloudProTarget: 'Ideal para times de tecnologia em crescimento',
      cloudProDesc:
        'Nós cuidamos da infraestrutura, isolamento de testes e painel completo na nuvem.',
      enterprise: 'Enterprise',
      enterprisePrice: 'Customizado',
      enterpriseTarget: 'Para corporações com segurança máxima',
      enterpriseDesc:
        'Secrets Vault, auditoria completa de logs e conformidade rígida de dados. Suporte dedicado.',
      btnFree: 'Ver Código Fonte',
      btnPro: 'Começar Teste',
      btnEnterprise: 'Falar com Especialista',
    },
    dashboard: {
      statsCompleted: 'Missões Concluídas',
      statsFailed: 'Missões Falhas',
      recentMissions: 'Missões Recentes (ao vivo)',
      noMissions: 'Nenhuma missão ainda. Seus agentes vão reportar aqui assim que rodarem.',
      connectTitle: 'Conecte para ver seus agentes',
      connectDesc: 'Entre com o GitHub no setup para ver suas missões reais, ao vivo.',
      connectBtn: 'Ir para o setup',
      connectCheckError:
        'Não deu pra confirmar sua sessão (problema de conexão). Se você já está logado, tente recarregar.',
      checkingSession: 'Verificando sua sessão…',
      loadError: 'Não foi possível falar com a API do GitOrch. Verifique se sua sessão é válida.',
      title: 'Painel dos Agentes',
      activeMissions: 'Missões Ativas',
      uptime: 'Disponibilidade',
      successRate: 'Taxa de Sucesso',
      agentStatus: 'Core do Agente: Operacional',
      cognitiveLogs: 'Log Cognitivo (Synapse Engine)',
      blastRadius: 'Blast Radius e Arquivos Afetados',
      relaunchBtn: 'Disparar Missão do Agente',
    },
    setup: {
      begin: 'Começar',
      next: 'Avançar',
      back: 'Voltar',
      retry: 'Tentar novamente',
      connected: 'Conectado',
      welcomeTitle: 'Inicie sua configuração',
      welcomeDesc:
        'Bem-vindo ao Setup Wizard do GitOrch. Vamos isolar seu ambiente, conectar seus repositórios e preparar seus agentes inteligentes para codificar de forma autônoma.',
      githubTitle: 'Conecte seu GitHub',
      githubDesc:
        'Entre com o GitHub para que os agentes leiam os repositórios que você escolher e abram pull requests por você.',
      githubBtn: 'Continuar com GitHub',
      termsTitle: 'Termos de Serviço e Políticas',
      termsDesc:
        'Por favor, revise e aceite os termos para isolarmos e configurarmos o seu workspace.',
      terms1Title: '1. Coleta de dados e acesso ao GitHub',
      terms1Body:
        'O GitOrch lê os repositórios que você seleciona para dar contexto semântico (RAG) aos agentes. Nunca alteramos seu código sem sua autorização explícita ou um trigger via pull request.',
      terms2Title: '2. Motores CLI e credenciais',
      terms2Body:
        'Suportamos Claude Code, Codex e Antigravity. Seus tokens ficam cifrados no cofre do Control Plane para autenticação assistida e execução das tarefas de código.',
      terms3Title: '3. Privacidade e armazenamento',
      terms3Body:
        'Os dados extraídos de commits e arquivos são armazenados isolados por tenant. Nunca usamos seus dados proprietários para treinar modelos de linguagem globais.',
      termsAccept: 'Eu li e aceito os termos de serviço e a política de privacidade do GitOrch.',
      termsAcceptBtn: 'Aceitar e continuar',
      termsAccepting: 'Preparando seu ambiente…',
      termsEnvError: 'Não foi possível preparar seu ambiente. Tente novamente.',
      reposTitle: 'Selecione seus repositórios',
      reposDesc: 'Escolha em quais repositórios os agentes de IA do GitOrch vão atuar.',
      reposLoading: 'Carregando seus repositórios do GitHub...',
      reposCloning: 'Clonando seus repositórios no seu ambiente…',
      cloneError: 'Não foi possível clonar seus repositórios. Tente novamente.',
      reposError: 'Falha ao buscar seus repositórios do GitHub.',
      reposSearch: 'Buscar repositório...',
      reposEmpty: 'Nenhum repositório encontrado.',
      reposPrivate: 'Privado',
      diagTitle: 'Lendo o seu repositório',
      diagDesc: 'Ainda sem IA nenhuma — é análise estrutural real do seu código, de graça.',
      diagLoadingClone: 'Clonando seu repositório…',
      diagLoadingIndex: 'Lendo a estrutura do código…',
      diagLoadingGithub: 'Cruzando issues, pull requests e CI…',
      diagEmptyTitle: 'Ainda não há muito pra ler',
      diagEmptyBody:
        'Este repositório não tem código-fonte reconhecível o suficiente para uma leitura estrutural. Você pode escolher outro, ou continuar — os agentes ainda podem trabalhar aqui.',
      diagErrorTitle: 'Não consegui ler este repositório',
      diagErrorBody:
        'Algo deu errado ao clonar ou ler o código. Verifique o acesso e tente de novo.',
      diagRetry: 'Tentar de novo',
      diagScoreLabel: 'Saúde do repo',
      diagVerdictGood: 'Base sólida. Alguns pontos pra apertar.',
      diagVerdictWarn: 'Dá pra trabalhar, mas tem fricção real segurando o time.',
      diagVerdictBad: 'Este repo está resistindo — tem dor real aqui, mas dá pra resolver.',
      diagFindingHealthyCore:
        'A base está sólida — {{fileCount}} arquivos indexados, nada alarmante encontrado.',
      diagFindingUntestedRatio:
        '{{percent}}% do código ({{untestedCount}} de {{totalCount}} arquivos) não tem teste correspondente — mexer ali é aposta, não certeza.',
      diagFindingStalePrs:
        '{{staleCount}} de {{openCount}} pull requests abertos estão parados há um tempo.',
      diagFindingCiFailing:
        'O último run do CI falhou — a branch principal pode estar quebrada agora.',
      diagFindingOpenIssues: '{{openIssues}} issues abertas estão se acumulando.',
      diagDetailsToggle: 'Ver os detalhes técnicos',
      diagDetailsFiles: 'Arquivos indexados',
      diagDetailsLargest: 'Maiores arquivos',
      diagDetailsMostCalled: 'Funções mais chamadas',
      diagDetailsDirs: 'Inventário por diretório',
      diagContinue: 'Conecte um motor pra resolver isso',
      diagGraphLoading: 'Construindo o grafo 3D…',
      diagGraphTruncated: 'Repositório grande — grafo agregado por diretório.',
      diagGraphExpand: 'Expandir grafo',
      diagGraphCollapse: 'Fechar',
      diagGraphPanelTitle: 'Símbolo selecionado',
      diagGraphPanelFile: 'Arquivo',
      diagGraphPanelType: 'Tipo',
      diagGraphPanelHealth: 'Saúde',
      diagGraphPanelDirectory: '{{count}} símbolos neste diretório',
      diagGraphPanelEmpty: 'Clique num nó pra ver os detalhes.',
      diagGraphUnavailable: 'Não deu pra montar o grafo 3D — mostrando os detalhes técnicos.',
      enginesTitle: 'Escolha seus motores',
      enginesDesc:
        'Selecione quais motores de IA vão atuar no seu repositório. Os três são iguais.',
      engClaudeDesc:
        'O agente oficial da Anthropic para o terminal. Ideal para refatorações profundas, comandos locais e investigação de bugs complexos direto na branch de trabalho.',
      engCodexDesc:
        'O agente de código da OpenAI. Forte em análise focada (lê primeiro) e mudanças precisas em todo o repositório.',
      engAntigravityDesc:
        'Nosso próprio motor de automação. Roda em segundo plano orquestrando workflows completos e integrando com o Control Plane.',
      planTitle: 'Escolha seu plano',
      planDesc: 'Adote o GitOrch totalmente grátis ou inicie um teste de 30 dias na nuvem.',
      planPopular: 'Popular',
      planFreeName: 'Grátis',
      planFreeTag: '1 repositório',
      planFreeDesc: 'Ideal para desenvolvedores solo ou testes rápidos num único projeto pessoal.',
      planFreeF1: '1 repositório ativo',
      planFreeF2: 'Motores locais (self-hosted)',
      planFreeF3: 'Limites de processamento RAG',
      planProName: 'Cloud Pro',
      planProTag: 'Até 2 repos',
      planProPer: '/mês',
      planProDesc: '30 dias grátis. Acesso total na nuvem para times em crescimento. Via Stripe.',
      planProF1: 'Até 2 repositórios ativos',
      planProF2: 'Execução autônoma na nossa nuvem',
      planProF3: 'Sem rate limit de tokens',
      planProF4: 'Integrações extras de telemetria',
      confirmTitle: 'Confirmação e inicialização',
      confirmDesc:
        'Revise suas escolhas. Ao continuar, o sistema clona os repositórios e ativa os motores.',
      confirmOverTitle: 'Limite de repositórios excedido',
      confirmOverBody:
        'Você escolheu o plano Grátis, que permite no máximo 1 repositório ativo. Remova os repositórios extras abaixo para continuar:',
      confirmPlanLabel: 'Plano selecionado',
      confirmEnginesLabel: 'Motores ativos',
      confirmReposLabel: 'Repositórios',
      confirmRemove: 'Remover',
      confirmFreePlan: 'Plano Grátis',
      confirmSubmit: 'Finalizar e clonar',
      confirmSubmitting: 'Clonando e iniciando...',
      confirmPayNext:
        'A seguir criamos o seu ambiente e mostramos a sua chave de API — você só vai vê-la uma vez. O pagamento vem logo depois disso.',
      connectTitle: 'Conecte seus motores',
      connectDesc:
        'Entre em cada motor com a sua própria conta — você só clica num link, autoriza na página do provedor e cola o código de volta. Nada pra instalar, nenhum terminal. Os três funcionam do mesmo jeito — conecte pelo menos um para continuar.',
      connectPaste: 'Cole aqui',
      connectBtn: 'Conectar',
      connecting: 'Verificando...',
      connectedLabel: 'Conectado',
      connectModelsLabel: 'modelos',
      connectQuotaLabel: 'cota',
      // 21/07: quota REAL do Claude (`claude -p "/usage"`) — % usado por
      // janela (sessão/semana) com o horário de reset de cada uma. Substitui
      // a legenda genérica antiga ("cota gerenciada pela sua assinatura")
      // agora que dá pra coletar de verdade.
      connectClaudeSessionLabel: 'Sessão',
      connectClaudeWeekLabel: 'Semana (todos os modelos)',
      connectClaudeUsedLabel: 'usada',
      connectClaudeResetsLabel: 'reseta',
      connectGate: 'Conecte pelo menos um motor para continuar.',
      connectError: 'Não deu para conectar. Confira o que você colou e tente de novo.',
      connectOpenLink: 'Abrir página de autorização',
      connectPasteCodePlaceholder: 'Código da página de autorização',
      connectSubmitCode: 'Enviar',
      connectWaitingApproval: 'Aguardando sua aprovação na página acima…',
      connectManualToggle: 'Problemas? Colar token manualmente',
      connectManualHintEnv:
        'Cole o token do `claude setup-token` (começa com sk-ant-oat…) — não é o código da página de autorização.',
      connectManualHintFile:
        'Cole o conteúdo do arquivo de credencial que o CLI gerou (ex.: auth.json) — não é o código da página de autorização.',
      connectManualSubmit: 'Conectar com o que colei',
      connectVerifying: 'Verificando a conexão…',
      connectErrorHintTerms:
        'Se a tela de Termos do Antigravity travou, cole a credencial manualmente abaixo.',
      connectErrorHintCapture:
        'Não consegui capturar o token automaticamente. Cole o que o CLI gerou abaixo.',
      connectErrorHintGeneric: 'Você também pode colar o token manualmente abaixo.',
      connectManualLooksLikeCode:
        'Isso parece o código da página — cole no campo "Código da página de autorização" acima.',
      tgTitle: 'Alertas no Telegram (opcional)',
      tgDesc:
        'Receba um aviso quando uma task do seu projeto travar ou precisar de você. Toque no botão, aperte Start no Telegram e pronto.',
      tgBenefit1: 'Anúncios de novidades do seu projeto',
      tgBenefit2: 'Alertas quando algo dá errado (incidentes)',
      tgBenefit3: 'Perguntas dos agentes, com botões pra você responder direto no chat',
      tgBenefit4: 'Peça melhorias a qualquer momento com /wish',
      tgConnect: 'Conectar meu Telegram',
      tgWaiting: 'O Telegram abriu — aperte Start por lá. A gente fica esperando aqui.',
      tgLinked: 'Telegram conectado — os avisos do seu projeto chegam nesta conversa.',
      tgError: 'Não deu para conectar agora. Tente de novo, ou conecte depois pelo painel.',
      tgRetry: 'Tentar de novo',
      tgOptional: 'Opcional. Dá para conectar depois pelo painel — nada aqui se perde.',
      readyTitle: 'Seu ambiente está nascendo',
      readyDesc:
        'Seu projeto e as credenciais estão prontos. Os agentes estão aquecendo — acompanhe pelo painel.',
      readyLedgerRepo: 'Repositórios vinculados',
      readyLedgerEngines: 'Motores conectados',
      readyLedgerActivating: 'Ambiente ativando',
      readyLedgerActivatingDesc:
        'A memória Cortex, o grafo de código e a orquestração Cadence estão aquecendo para o seu repositório.',
      readyLedgerActivatingQueued: 'Na fila: o provisionamento começa em instantes.',
      readyLedgerActivatingQueuedPosition:
        'Na fila (posição {{position}}): a instância está no limite de capacidade — o provisionamento começa assim que uma vaga abrir.',
      readyLedgerActivatingRunning:
        'Clonando o seu repositório e ligando os motores dentro do seu ambiente.',
      readyLedgerActivatingSlow:
        'Está demorando mais que o normal. O provisionamento continua rodando em segundo plano — atualize para ver o estado atual.',
      readyLedgerActivatingReady: 'Ambiente ativo',
      readyLedgerActivatingFailed: 'O provisionamento falhou',
      readyLedgerActivatingFailedDesc:
        'Não conseguimos provisionar o seu ambiente. Você pode tentar de novo.',
      readyRefresh: 'Atualizar',
      readyRetry: 'Tentar de novo',
      readyResourcesTitle: 'Seu ambiente isolado está pronto com:',
      readyResourcesCommit: 'recursos do GitOrch na versão {{commit}}',
      readyResourcesPreparing: 'Preparando seu ambiente…',
      readyKeys: 'Sua chave de API',
      readyKeyOnce:
        'Esta é a única vez que mostramos a sua chave. Guardamos apenas uma versão embaralhada dela, então nem nós conseguimos exibi-la de novo — copie agora e guarde num lugar seguro.',
      readyKeySaved: 'Já guardei minha chave em um lugar seguro',
      readyKeyCopy: 'Copiar a chave',
      readyLockedHint: 'Copie a chave (ou marque a caixa acima) para continuar.',
      readyKeysHint:
        'Adicione este segredo nas suas GitHub Actions para os agentes que rodam no GitHub reportarem de volta:',
      readyGoPay: 'Ir para o pagamento',
      readyPaying: 'Abrindo o pagamento...',
      readyPayFailed:
        'Não conseguimos abrir o pagamento agora. Seu ambiente e sua chave já estão prontos — tente de novo ou siga para o painel.',
      readyPayCapacity:
        'Estamos no limite de capacidade no momento. Seu ambiente e sua chave já estão prontos — entramos em contato para liberar o plano pago.',
      readyGoPanel: 'Ir para o painel',
      planIntent: 'Você entrou já com este plano — dá para mudar aqui embaixo.',
      reposFreeNote:
        'Seu plano Grátis inclui 1 repositório ativo. Escolha o mais importante, ou faça upgrade para mais.',
      startOver: 'Recomeçar do zero',
      startOverError: 'Não foi possível reiniciar o seu ambiente. Tente novamente.',
      errREPO_ACCESS_DENIED:
        'Acesso negado. Confira se o GitOrch tem permissão nesse repositório (reconecte o GitHub se precisar) e tente de novo.',
      errREPO_NOT_FOUND:
        'Não encontramos esse repositório. Confira se o nome está certo e se você ainda tem acesso a ele.',
      errRATE_LIMITED:
        'O GitHub está limitando as requisições agora. Espere um minuto e tente de novo.',
      errDISK_FULL:
        'Ficamos sem espaço de armazenamento do nosso lado nessa hora. Tente de novo em instantes — se continuar acontecendo, recomece do zero.',
      errCLONE_TIMEOUT:
        'Clonar esse repositório demorou demais (pode ser grande, ou a conexão está lenta). Tente de novo.',
      errDIAG_TIMEOUT:
        'Ler esse repositório demorou demais. Tente de novo, ou continue sem a leitura grátis.',
      errDIAG_EMPTY_REPO:
        'Esse repositório ainda não tem nenhum commit. Suba algum código nele primeiro e tente de novo.',
      errGITHUB_TOKEN_EXPIRED:
        'Seu acesso ao GitHub expirou. O login expirou ou foi revogado — faça login de novo para continuar.',
      errINTERNAL: 'Algo inesperado aconteceu do nosso lado. Tente de novo em instantes.',
      reposSignInAgain: 'Entrar de novo no GitHub',
    },
  },
  es: {
    nav: {
      features: 'Recursos',
      anatomy: 'Anatomía',
      pricing: 'Precios',
      login: 'Entrar',
      startAuto: 'Iniciar Automatización',
    },
    hero: {
      badge: 'ORQUESTACIÓN PROFESIONAL',
      title: 'Orquestre Agentes de IA Directamente en el Flujo de su GitHub.',
      subtitle:
        'GitOrch es el plano de control definitivo para la automatización de ingeniería de software. Conecte su cuenta y permita que agentes autónomos gestionen, prueben y documenten directamente en sus Issues y Projects V2. Sin fricción.',
      ctaPrimary: 'Conectar Repositorio Gratis',
      ctaMicro: 'Instalación con 1 clic vía GitHub App. Sin burocracia.',
      githubStars: 'GitHub Stars',
    },
    anatomy: {
      title: 'Anatomía de la Solución',
      subtitle: 'Deje de gestionar código. Comience a orquestar resultados.',
      syncTitle: 'Sincronización Nativa e Invisible',
      syncDesc:
        'Sus agentes trabajan donde su equipo ya está. Gestionan sub-issues, actualizan cronogramas y mueven tarjetas en Projects V2 automáticamente.',
      ragTitle: 'Cero Alucinaciones de Código',
      ragDesc:
        'El motor mapea la arquitectura, dependencias e impacto antes de actuar. Agentes toman decisiones basadas en hechos, no suposiciones.',
      cortexTitle: 'Coordinación y Memoria a Largo Plazo',
      cortexDesc:
        'Los agentes conversan entre sí y recuerdan el contexto de entregas pasadas. Menos retrabajo y más autonomía para tareas de extremo a extremo.',
    },
    pricing: {
      recommended: 'RECOMENDADO',
      title: 'Escale sus Automatizaciones',
      subtitle: 'Desde desarrolladores individuales hasta flotas corporativas.',
      openCore: 'Open Core',
      openCorePrice: '$0',
      openCoreTarget: 'Para desarrolladores y entusiastas',
      openCoreDesc: 'Código abierto para ejecutar en su propia infraestructura (auto-alojado).',
      cloudPro: 'Cloud Pro',
      cloudProPrice: 'A demanda',
      cloudProTarget: 'Ideal para equipos en crecimiento',
      cloudProDesc: 'Nos encargamos de la infraestructura y el panel en la nube completo.',
      enterprise: 'Enterprise',
      enterprisePrice: 'Personalizado',
      enterpriseTarget: 'Para máxima seguridad',
      enterpriseDesc: 'Secrets Vault, auditoría de logs y cumplimiento de datos. Soporte dedicado.',
      btnFree: 'Ver Código',
      btnPro: 'Probar Gratis',
      btnEnterprise: 'Hablar con Ventas',
    },
    dashboard: {
      statsCompleted: 'Misiones Completadas',
      statsFailed: 'Misiones Fallidas',
      recentMissions: 'Misiones Recientes (en vivo)',
      noMissions: 'Aún no hay misiones. Tus agentes reportarán aquí en cuanto se ejecuten.',
      connectTitle: 'Conéctate para ver tus agentes',
      connectDesc: 'Inicia sesión con GitHub en el setup para ver tus misiones reales, en vivo.',
      connectBtn: 'Ir al setup',
      connectCheckError:
        'No pudimos confirmar tu sesión (problema de conexión). Si ya iniciaste sesión, intenta recargar.',
      checkingSession: 'Verificando tu sesión…',
      loadError: 'No se pudo contactar la API de GitOrch. Verifica que tu sesión sea válida.',
      title: 'Panel de Agentes',
      activeMissions: 'Misiones Activas',
      uptime: 'Disponibilidad',
      successRate: 'Tasa de Éxito',
      agentStatus: 'Núcleo del Agente: Operativo',
      cognitiveLogs: 'Log Cognitivo (Synapse Engine)',
      blastRadius: 'Blast Radius y Archivos Afectados',
      relaunchBtn: 'Disparar Misión del Agente',
    },
    setup: {
      begin: 'Empezar',
      next: 'Continuar',
      back: 'Volver',
      retry: 'Reintentar',
      connected: 'Conectado',
      welcomeTitle: 'Inicia tu configuración',
      welcomeDesc:
        'Bienvenido al Setup Wizard de GitOrch. Vamos a aislar tu entorno, conectar tus repositorios y preparar tus agentes inteligentes para programar de forma autónoma.',
      githubTitle: 'Conecta tu GitHub',
      githubDesc:
        'Inicia sesión con GitHub para que los agentes lean los repositorios que elijas y abran pull requests por ti.',
      githubBtn: 'Continuar con GitHub',
      termsTitle: 'Términos de Servicio y Políticas',
      termsDesc: 'Revisa y acepta los términos para aislar y configurar tu workspace.',
      terms1Title: '1. Recopilación de datos y acceso a GitHub',
      terms1Body:
        'GitOrch lee los repositorios que selecciones para dar contexto semántico (RAG) a los agentes. Nunca cambiamos tu código sin tu autorización explícita o un trigger vía pull request.',
      terms2Title: '2. Motores CLI y credenciales',
      terms2Body:
        'Soportamos Claude Code, Codex y Antigravity. Tus tokens se guardan cifrados en la bóveda del Control Plane para autenticación asistida y tareas de código.',
      terms3Title: '3. Privacidad y almacenamiento',
      terms3Body:
        'Los datos extraídos de commits y archivos se almacenan aislados por tenant. Nunca usamos tus datos propietarios para entrenar modelos de lenguaje globales.',
      termsAccept:
        'He leído y acepto los términos de servicio y la política de privacidad de GitOrch.',
      termsAcceptBtn: 'Aceptar y continuar',
      termsAccepting: 'Preparando tu entorno…',
      termsEnvError: 'No se pudo preparar tu entorno. Inténtalo de nuevo.',
      reposTitle: 'Selecciona tus repositorios',
      reposDesc: 'Elige en qué repositorios trabajarán los agentes de IA de GitOrch.',
      reposLoading: 'Cargando tus repositorios de GitHub...',
      reposCloning: 'Clonando tus repositorios en tu entorno…',
      cloneError: 'No se pudieron clonar tus repositorios. Inténtalo de nuevo.',
      reposError: 'No se pudieron cargar tus repositorios de GitHub.',
      reposSearch: 'Buscar repositorio...',
      reposEmpty: 'No se encontraron repositorios.',
      reposPrivate: 'Privado',
      diagTitle: 'Leyendo tu repositorio',
      diagDesc: 'Todavía sin IA — es análisis estructural real de tu código, gratis.',
      diagLoadingClone: 'Clonando tu repositorio…',
      diagLoadingIndex: 'Leyendo la estructura del código…',
      diagLoadingGithub: 'Cruzando issues, pull requests y CI…',
      diagEmptyTitle: 'Todavía no hay mucho que leer',
      diagEmptyBody:
        'Este repositorio no tiene código fuente reconocible suficiente para una lectura estructural. Puedes elegir otro, o continuar — los agentes igual pueden trabajar aquí.',
      diagErrorTitle: 'No pude leer este repositorio',
      diagErrorBody:
        'Algo salió mal al clonar o leer el código. Verifica el acceso e intenta de nuevo.',
      diagRetry: 'Intentar de nuevo',
      diagScoreLabel: 'Salud del repo',
      diagVerdictGood: 'Base sólida. Algunos puntos para ajustar.',
      diagVerdictWarn: 'Se puede trabajar, pero hay fricción real frenando al equipo.',
      diagVerdictBad: 'Este repo está resistiendo — hay dolor real aquí, pero se puede resolver.',
      diagFindingHealthyCore:
        'La base está sólida — {{fileCount}} archivos indexados, nada alarmante encontrado.',
      diagFindingUntestedRatio:
        'El {{percent}}% del código ({{untestedCount}} de {{totalCount}} archivos) no tiene test correspondiente — tocar ahí es apuesta, no certeza.',
      diagFindingStalePrs:
        '{{staleCount}} de {{openCount}} pull requests abiertos llevan un tiempo parados.',
      diagFindingCiFailing:
        'La última ejecución de CI falló — la rama principal podría estar rota ahora.',
      diagFindingOpenIssues: '{{openIssues}} issues abiertas se están acumulando.',
      diagDetailsToggle: 'Ver los detalles técnicos',
      diagDetailsFiles: 'Archivos indexados',
      diagDetailsLargest: 'Archivos más grandes',
      diagDetailsMostCalled: 'Funciones más llamadas',
      diagDetailsDirs: 'Inventario por directorio',
      diagContinue: 'Conecta un motor para resolver esto',
      diagGraphLoading: 'Construyendo el grafo 3D…',
      diagGraphTruncated: 'Repositorio grande — grafo agregado por directorio.',
      diagGraphExpand: 'Expandir grafo',
      diagGraphCollapse: 'Cerrar',
      diagGraphPanelTitle: 'Símbolo seleccionado',
      diagGraphPanelFile: 'Archivo',
      diagGraphPanelType: 'Tipo',
      diagGraphPanelHealth: 'Salud',
      diagGraphPanelDirectory: '{{count}} símbolos en este directorio',
      diagGraphPanelEmpty: 'Haz clic en un nodo para ver los detalles.',
      diagGraphUnavailable: 'No se pudo construir el grafo 3D — mostrando los detalles técnicos.',
      enginesTitle: 'Elige tus motores',
      enginesDesc:
        'Selecciona qué motores de IA trabajarán en tu repositorio. Los tres son iguales.',
      engClaudeDesc:
        'El agente oficial de Anthropic para la terminal. Ideal para refactors profundos, comandos locales e investigación de bugs complejos en la rama de trabajo.',
      engCodexDesc:
        'El agente de código de OpenAI. Fuerte en análisis enfocado (lee primero) y cambios precisos en todo el repositorio.',
      engAntigravityDesc:
        'Nuestro propio motor de automatización. Corre en segundo plano orquestando workflows completos e integrando con el Control Plane.',
      planTitle: 'Elige tu plan',
      planDesc: 'Adopta GitOrch totalmente gratis o inicia una prueba de 30 días en la nube.',
      planPopular: 'Popular',
      planFreeName: 'Gratis',
      planFreeTag: '1 repositorio',
      planFreeDesc:
        'Ideal para desarrolladores solo o pruebas rápidas en un único proyecto personal.',
      planFreeF1: '1 repositorio activo',
      planFreeF2: 'Motores locales (self-hosted)',
      planFreeF3: 'Límites de procesamiento RAG',
      planProName: 'Cloud Pro',
      planProTag: 'Hasta 2 repos',
      planProPer: '/mes',
      planProDesc:
        '30 días gratis. Acceso total en la nube para equipos en crecimiento. Vía Stripe.',
      planProF1: 'Hasta 2 repositorios activos',
      planProF2: 'Ejecución autónoma en nuestra nube',
      planProF3: 'Sin rate limit de tokens',
      planProF4: 'Integraciones extra de telemetría',
      confirmTitle: 'Confirmación e inicialización',
      confirmDesc:
        'Revisa tus elecciones. Al continuar, el sistema clona los repositorios y activa los motores.',
      confirmOverTitle: 'Límite de repositorios superado',
      confirmOverBody:
        'Elegiste el plan Gratis, que permite como máximo 1 repositorio activo. Elimina los repositorios extra de abajo para continuar:',
      confirmPlanLabel: 'Plan seleccionado',
      confirmEnginesLabel: 'Motores activos',
      confirmReposLabel: 'Repositorios',
      confirmRemove: 'Eliminar',
      confirmFreePlan: 'Plan Gratis',
      confirmSubmit: 'Finalizar y clonar',
      confirmSubmitting: 'Clonando e iniciando...',
      confirmPayNext:
        'A continuación creamos tu entorno y mostramos tu clave de API — solo la verás una vez. El pago viene justo después.',
      connectTitle: 'Conecta tus motores',
      connectDesc:
        'Inicia sesión en cada motor con tu propia cuenta — solo haces clic en un enlace, autorizas en la página del proveedor y pegas el código de vuelta. Nada que instalar, sin terminal. Los tres funcionan igual — conecta al menos uno para continuar.',
      connectPaste: 'Pega aquí',
      connectBtn: 'Conectar',
      connecting: 'Verificando...',
      connectedLabel: 'Conectado',
      connectModelsLabel: 'modelos',
      connectQuotaLabel: 'cuota',
      // 21/07: cuota REAL de Claude (`claude -p "/usage"`) — % usado por
      // ventana (sesión/semana) con la hora de reinicio de cada una. Sustituye
      // la leyenda genérica anterior ("cuota gestionada por tu plan") ahora
      // que se puede recolectar de verdad.
      connectClaudeSessionLabel: 'Sesión',
      connectClaudeWeekLabel: 'Semana (todos los modelos)',
      connectClaudeUsedLabel: 'usada',
      connectClaudeResetsLabel: 'reinicia',
      connectGate: 'Conecta al menos un motor para continuar.',
      connectError: 'No se pudo conectar. Revisa lo que pegaste e inténtalo de nuevo.',
      connectOpenLink: 'Abrir página de autorización',
      connectPasteCodePlaceholder: 'Código de la página de autorización',
      connectSubmitCode: 'Enviar',
      connectWaitingApproval: 'Esperando tu aprobación en la página de arriba…',
      connectManualToggle: '¿Problemas? Pegar el token manualmente',
      connectManualHintEnv:
        'Pega el token de `claude setup-token` (empieza con sk-ant-oat…) — no es el código de la página de autorización.',
      connectManualHintFile:
        'Pega el contenido del archivo de credencial que generó el CLI (p. ej. auth.json) — no es el código de la página de autorización.',
      connectManualSubmit: 'Conectar con lo que pegué',
      connectVerifying: 'Verificando la conexión…',
      connectErrorHintTerms:
        'Si la pantalla de Términos de Antigravity se quedó atascada, pega la credencial manualmente abajo.',
      connectErrorHintCapture:
        'No pudimos capturar el token automáticamente. Pega lo que el CLI generó abajo.',
      connectErrorHintGeneric: 'También puedes pegar el token manualmente abajo.',
      connectManualLooksLikeCode:
        'Esto parece el código de la página — pégalo en el campo "Código de la página de autorización" de arriba.',
      tgTitle: 'Alertas en Telegram (opcional)',
      tgDesc:
        'Recibe un aviso cuando una tarea de tu proyecto se atasque o te necesite. Toca el botón, pulsa Start en Telegram y listo.',
      tgBenefit1: 'Anuncios de novedades de tu proyecto',
      tgBenefit2: 'Alertas cuando algo falla (incidentes)',
      tgBenefit3: 'Preguntas de los agentes, con botones para responder directo en el chat',
      tgBenefit4: 'Pide mejoras en cualquier momento con /wish',
      tgConnect: 'Conectar mi Telegram',
      tgWaiting: 'Telegram se abrió — pulsa Start ahí. Nosotros esperamos aquí.',
      tgLinked: 'Telegram conectado — los avisos de tu proyecto llegan a este chat.',
      tgError: 'No pudimos conectar ahora. Inténtalo de nuevo, o conéctalo después desde el panel.',
      tgRetry: 'Intentar de nuevo',
      tgOptional: 'Opcional. Puedes conectarlo después desde el panel — aquí no se pierde nada.',
      readyTitle: 'Tu entorno está naciendo',
      readyDesc:
        'Tu proyecto y las credenciales están listos. Los agentes se están preparando — síguelo desde el panel.',
      readyLedgerRepo: 'Repositorios vinculados',
      readyLedgerEngines: 'Motores conectados',
      readyLedgerActivating: 'Entorno activándose',
      readyLedgerActivatingDesc:
        'La memoria Cortex, el grafo de código y la orquestación Cadence se están preparando para tu repositorio.',
      readyLedgerActivatingQueued: 'En la cola: el aprovisionamiento empieza en instantes.',
      readyLedgerActivatingQueuedPosition:
        'En la cola (posición {{position}}): la instancia está al límite de capacidad — el aprovisionamiento empieza en cuanto se libere un lugar.',
      readyLedgerActivatingRunning:
        'Clonando tu repositorio y encendiendo los motores dentro de tu entorno.',
      readyLedgerActivatingSlow:
        'Está tardando más de lo normal. El aprovisionamiento sigue en segundo plano — actualiza para ver el estado actual.',
      readyLedgerActivatingReady: 'Entorno activo',
      readyLedgerActivatingFailed: 'El aprovisionamiento falló',
      readyLedgerActivatingFailedDesc:
        'No pudimos aprovisionar tu entorno. Puedes intentarlo de nuevo.',
      readyRefresh: 'Actualizar',
      readyRetry: 'Reintentar',
      readyResourcesTitle: 'Tu entorno aislado está listo con:',
      readyResourcesCommit: 'recursos de GitOrch en la versión {{commit}}',
      readyResourcesPreparing: 'Preparando tu entorno…',
      readyKeys: 'Tu clave de API',
      readyKeyOnce:
        'Esta es la única vez que mostramos tu clave. Solo guardamos una versión cifrada de ella, así que ni nosotros podemos volver a mostrarla — cópiala ahora y guárdala en un lugar seguro.',
      readyKeySaved: 'Ya guardé mi clave en un lugar seguro',
      readyKeyCopy: 'Copiar la clave',
      readyLockedHint: 'Copia la clave (o marca la casilla de arriba) para continuar.',
      readyKeysHint:
        'Añade este secreto a tus GitHub Actions para que los agentes que corren en GitHub reporten de vuelta:',
      readyGoPay: 'Ir al pago',
      readyPaying: 'Abriendo el pago...',
      readyPayFailed:
        'No pudimos abrir el pago ahora. Tu entorno y tu clave ya están listos — inténtalo de nuevo o ve al panel.',
      readyPayCapacity:
        'Estamos al límite de capacidad en este momento. Tu entorno y tu clave ya están listos — te contactaremos para desbloquear el plan de pago.',
      readyGoPanel: 'Ir al panel',
      planIntent: 'Entraste ya con este plan — puedes cambiarlo aquí abajo.',
      reposFreeNote:
        'Tu plan Gratis incluye 1 repositorio activo. Elige el más importante, o mejora para tener más.',
      startOver: 'Empezar de nuevo',
      startOverError: 'No pudimos reiniciar tu entorno. Inténtalo de nuevo.',
      errREPO_ACCESS_DENIED:
        'Acceso denegado. Verifica que GitOrch tenga permiso sobre este repositorio (reconecta GitHub si hace falta) e inténtalo de nuevo.',
      errREPO_NOT_FOUND:
        'No encontramos este repositorio. Verifica que el nombre sea correcto y que todavía tengas acceso a él.',
      errRATE_LIMITED:
        'GitHub está limitando las solicitudes en este momento. Espera un minuto e inténtalo de nuevo.',
      errDISK_FULL:
        'Nos quedamos sin espacio de almacenamiento de nuestro lado en este momento. Inténtalo de nuevo en un momento — si sigue pasando, empieza de nuevo.',
      errCLONE_TIMEOUT:
        'Clonar este repositorio tardó demasiado (puede ser grande, o la conexión está lenta). Inténtalo de nuevo.',
      errDIAG_TIMEOUT:
        'Leer este repositorio tardó demasiado. Inténtalo de nuevo, o continúa sin la lectura gratis.',
      errDIAG_EMPTY_REPO:
        'Este repositorio todavía no tiene ningún commit. Sube algo de código primero e inténtalo de nuevo.',
      errGITHUB_TOKEN_EXPIRED:
        'Tu acceso a GitHub expiró. El inicio de sesión expiró o fue revocado — inicia sesión de nuevo para continuar.',
      errINTERNAL: 'Algo inesperado pasó de nuestro lado. Inténtalo de nuevo en un momento.',
      reposSignInAgain: 'Inicia sesión de nuevo en GitHub',
    },
  },
}
