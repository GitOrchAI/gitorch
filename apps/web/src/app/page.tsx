'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useLanguage } from '../LanguageContext'
import { API_BASE_URL } from '../lib/api'
import { detectCountry } from '../lib/geo'

/* Landing copy lives here (not in locales.ts) because it carries structured
   content — arrays of console events and statement words — that the string-only
   t() helper can't return. pt + en are authored; es falls back to en. */
type Lang = 'pt' | 'en' | 'es'
// Idiomas com tradução completa na landing (aparecem no seletor). O sistema
// (LanguageContext) detecta o navegador; faltando tradução, cai no inglês.
const LANDING_LANGS: Lang[] = ['en', 'pt', 'es']

// Repo real vem de config (produto dinâmico, nunca hardcoded), igual ao Header.
const GITHUB_REPO = process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'loureng/gitorch'
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`

// País pela LOCALIZAÇÃO REAL (IP), não pelo idioma — ver ../lib/geo.

const COPY = {
  pt: {
    nav: {
      entende: 'Entende',
      organiza: 'Organiza',
      vigia: 'Vigia',
      seg: 'Segurança',
      planos: 'Planos',
      aberto: 'Código aberto',
      cta: 'Começar grátis',
    },
    planos: {
      kicker: 'Planos',
      title: 'Comece grátis. Cresça quando quiser.',
      note: 'Preço na moeda do seu país. Cancele quando quiser.',
      tiers: [
        {
          name: 'Grátis',
          price: '$0',
          unit: 'para sempre',
          note: '1 projeto',
          desc: 'Você aprova cada missão. Self-hosted open-core ilimitado.',
          cta: 'Começar',
          href: '/setup',
        },
        {
          name: 'Solo',
          price: '$10',
          unit: '/mês',
          note: '2 projetos · sensores',
          desc: 'O loop que mantém seu repositório saudável, sozinho.',
          cta: 'Assinar',
          href: '/setup',
        },
        {
          name: 'Pro',
          price: '$29',
          unit: '/mês',
          note: 'Mais missões · fila prioritária',
          desc: 'Para quem depende do GitOrch todo dia.',
          cta: 'Assinar',
          href: '/setup',
          featured: true,
        },
        {
          name: 'Team',
          price: '$79',
          unit: '/mês',
          note: 'Multiusuário · SSO',
          desc: 'Seu time inteiro no piloto automático.',
          cta: 'Assinar',
          href: '/setup',
        },
      ],
    },
    hero: {
      eyebrow: 'Orquestração autônoma de repositórios',
      t1: 'Seu repositório bagunçado,',
      t2: 'organizado sozinho.',
      lead: 'Agentes de IA que entendem o seu código, planejam o trabalho em Scrum de verdade e entregam Pull Requests — enquanto você toca o negócio.',
      ctaPrimary: 'Conectar meu GitHub',
      ctaGhost: 'Ver como funciona',
      micro: 'Sem cartão. Começa no plano grátis e roda hoje.',
    },
    console: { live: 'AO VIVO', foot: 'entregue sozinho', mission: 'missão #4021' },
    events: [
      { role: 'RA', txt: 'Li 34 módulos pelo <b>CGC</b>', sub: '6 rotas · 2 riscos mapeados' },
      {
        role: 'sys',
        txt: '<b>Cortex</b> · memória do projeto criada',
        sub: 'a “loja” virou marketplace',
        sys: true,
      },
      { role: 'PO', txt: 'Priorizei o checkout lento', sub: '#3461 · P1 · liberado p/ sprint' },
      { role: 'SM', txt: 'Deleguei ao agente de dev', sub: 'branch fix/checkout-timeout' },
      { role: 'QA', txt: 'Validei no navegador', sub: 'PR #257 · verde ✓' },
    ],
    statement:
      'O GitOrch é o seu time de engenharia autônomo. Ele |entende o código, |decide o que importa e |entrega — sozinho, no seu repositório.',
    entende: {
      kicker: 'Entende',
      tag: 'CGC + Cortex',
      title: 'Conhece seu código melhor que o último dev que saiu.',
      body: 'Antes de tocar em nada, ele lê o repositório inteiro pelo <b>CGC</b>, o nosso grafo de código, e guarda tudo no <b>Cortex</b>, a memória do projeto. Contexto real — não chute.',
      learn: 'O time que executa',
      file: 'CGC · indexando loja-antiga',
    },
    organiza: {
      kicker: 'Organiza',
      tag: 'Cadence',
      title: 'Um time inteiro, rodando Scrum sozinho.',
      body: 'O <b>Cadence</b> é o nosso Scrum autônomo: o Analista descobre, o PO prioriza por valor, o Scrum Master delega e o QA valida no navegador. Cada tarefa só entra na sprint quando faz sentido.',
      learn: 'Como ele vigia',
      file: 'Cadence · sprint 4',
      cols: ['Descoberta', 'Priorizado', 'Em dev', 'Validado'],
      titles: ['Frete lento', 'P1 · caixa', '#3461', 'PR #261'],
      subs: ['descoberto', 'PO liberou', 'em dev…', 'verde ✓'],
      seed: [
        { b: 'Frete lento', s: 'checkout > 3s' },
        { b: 'Testes faltando', s: 'módulo caixa' },
        { b: '#3461', s: 'em entrega…' },
        { b: 'PR #257', s: 'verde ✓' },
      ],
    },
    vigia: {
      kicker: 'Vigia',
      tag: 'Sensores',
      title: 'Vê o incidente antes de você ver.',
      body: 'Sensores acompanham as falhas de produção e o CI o tempo todo. Quando algo quebra, vira um incidente: o PO classifica a gravidade e, se for grave, fura a fila na próxima sprint. Zero humano no caminho.',
      learn: 'Começar grátis',
      file: 'Sensores · produção',
      ping1: 'build da main · verde',
      ping2: 'deploy · verde',
      ping3a: 'workflow dependabot → jules · ',
      ping3b: 'falhou',
      incTitle: 'Build da main quebrado',
      incMeta: 'fingerprint ci:dependabot-jules',
      flow: ['detectado', 'triou P0', 'delegou'],
    },
    security: {
      kicker: 'Segurança',
      title: 'Conecte seu repositório sem medo.',
      sub: 'Padrão de segurança de nível empresarial — do primeiro clique à última missão.',
      items: [
        {
          h: 'Chaves cifradas em repouso',
          p: 'As chaves dos seus motores de IA são guardadas com criptografia autenticada. Nunca em texto puro, nunca compartilhadas.',
          tag: 'AES-256-GCM',
        },
        {
          h: 'Cada missão isolada',
          p: 'Todo trabalho roda num contêiner descartável, criado e destruído a cada missão. O agente enxerga só o necessário.',
          tag: 'Contêiner por missão',
        },
        {
          h: 'Agente em modo seguro',
          p: 'Por padrão o agente opera restrito e em somente-leitura — nada roda às cegas no seu código.',
          tag: 'Sandbox read-only',
        },
        {
          h: 'Um cliente nunca vê o outro',
          p: 'Isolamento total entre contas no banco: toda consulta é amarrada ao seu espaço.',
          tag: 'Multi-tenant',
        },
        {
          h: 'Nada entra sem assinatura',
          p: 'Cada evento do GitHub e de pagamento é verificado por assinatura criptográfica antes de ser aceito.',
          tag: 'HMAC-SHA256',
        },
        {
          h: 'Acesso blindado',
          p: 'Credenciais com hash forte, autenticação obrigatória e limite anti-força-bruta no login.',
          tag: 'bcrypt · rate-limit',
        },
      ],
    },
    trust: {
      kicker: 'Código aberto',
      title: 'O motor é seu. As chaves também.',
      items: [
        {
          h: 'Suas credenciais, isoladas',
          p: 'Você conecta a sua própria conta. Cada projeto roda com a sua chave, cifrada e nunca compartilhada.',
        },
        {
          h: 'Roda onde você quiser',
          p: 'Na nuvem do GitOrch ou na sua própria máquina. Mesmo produto, sem amarras de fornecedor.',
        },
        {
          h: 'Falhas honestas',
          p: 'Se algo não passou, ele diz. Nada de “deve estar funcionando”: só entra como pronto o que foi visto funcionando.',
        },
      ],
    },
    close: {
      title: 'Comece de graça. Deixe o time trabalhar.',
      body: 'Conecte um repositório e veja a primeira missão rodar hoje. Sem cartão, sem compromisso.',
      ctaPrimary: 'Começar com o GitHub',
      ctaGhost: 'Ver os planos',
    },
    foot: {
      tagline: 'Agentes que organizam repositórios sozinhos.',
      bottom: '© 2026 GitOrch. Código aberto.',
      made: 'feito por gente, executado por agentes',
      c1: 'Produto',
      c2: 'Aberto',
      c3: 'Empresa',
      l3: ['Sobre', 'Contato'],
    },
  },
  en: {
    nav: {
      entende: 'Understands',
      organiza: 'Organizes',
      vigia: 'Watches',
      seg: 'Security',
      planos: 'Plans',
      aberto: 'Open source',
      cta: 'Start free',
    },
    planos: {
      kicker: 'Plans',
      title: 'Start free. Grow when you want.',
      note: 'Prices in your local currency. Cancel anytime.',
      tiers: [
        {
          name: 'Free',
          price: '$0',
          unit: 'forever',
          note: '1 project',
          desc: 'You approve every mission. Self-hosted open-core, unlimited.',
          cta: 'Start',
          href: '/setup',
        },
        {
          name: 'Solo',
          price: '$10',
          unit: '/mo',
          note: '2 projects · sensors',
          desc: 'The loop that keeps your repository healthy, on its own.',
          cta: 'Subscribe',
          href: '/setup',
        },
        {
          name: 'Pro',
          price: '$29',
          unit: '/mo',
          note: 'More missions · priority queue',
          desc: 'For those who rely on GitOrch every day.',
          cta: 'Subscribe',
          href: '/setup',
          featured: true,
        },
        {
          name: 'Team',
          price: '$79',
          unit: '/mo',
          note: 'Multi-user · SSO',
          desc: 'Your whole team on autopilot.',
          cta: 'Subscribe',
          href: '/setup',
        },
      ],
    },
    hero: {
      eyebrow: 'Autonomous repository orchestration',
      t1: 'Your messy repository,',
      t2: 'organized on its own.',
      lead: 'AI agents that understand your code, plan the work in real Scrum and ship Pull Requests — while you run the business.',
      ctaPrimary: 'Connect my GitHub',
      ctaGhost: 'See how it works',
      micro: 'No card. Start on the free plan and run today.',
    },
    console: { live: 'LIVE', foot: 'shipped on its own', mission: 'mission #4021' },
    events: [
      { role: 'RA', txt: 'Read 34 modules via <b>CGC</b>', sub: '6 routes · 2 risks mapped' },
      {
        role: 'sys',
        txt: '<b>Cortex</b> · project memory created',
        sub: 'the “shop” became a marketplace',
        sys: true,
      },
      { role: 'PO', txt: 'Prioritized the slow checkout', sub: '#3461 · P1 · released to sprint' },
      { role: 'SM', txt: 'Delegated to the dev agent', sub: 'branch fix/checkout-timeout' },
      { role: 'QA', txt: 'Verified in the browser', sub: 'PR #257 · green ✓' },
    ],
    statement:
      'GitOrch is your autonomous engineering team. It |understands the code, |decides what matters and |ships — on its own, in your repository.',
    entende: {
      kicker: 'Understands',
      tag: 'CGC + Cortex',
      title: 'Knows your code better than the last dev who left.',
      body: 'Before touching anything, it reads the whole repository through <b>CGC</b>, our code graph, and stores everything in <b>Cortex</b>, the project memory. Real context — not guesswork.',
      learn: 'The team that executes',
      file: 'CGC · indexing old-shop',
    },
    organiza: {
      kicker: 'Organizes',
      tag: 'Cadence',
      title: 'A whole team, running Scrum on its own.',
      body: '<b>Cadence</b> is our autonomous Scrum: the Analyst discovers, the PO prioritizes by value, the Scrum Master delegates and QA verifies in the browser. Each task only enters the sprint when it makes sense.',
      learn: 'How it watches',
      file: 'Cadence · sprint 4',
      cols: ['Discovery', 'Prioritized', 'In dev', 'Verified'],
      titles: ['Slow shipping', 'P1 · checkout', '#3461', 'PR #261'],
      subs: ['discovered', 'PO released', 'in dev…', 'green ✓'],
      seed: [
        { b: 'Slow shipping', s: 'checkout > 3s' },
        { b: 'Missing tests', s: 'checkout module' },
        { b: '#3461', s: 'shipping…' },
        { b: 'PR #257', s: 'green ✓' },
      ],
    },
    vigia: {
      kicker: 'Watches',
      tag: 'Sensors',
      title: 'Sees the incident before you do.',
      body: 'Sensors track production failures and CI all the time. When something breaks, it becomes an incident: the PO classifies severity and, if critical, jumps the queue next sprint. Zero humans in the loop.',
      learn: 'Start free',
      file: 'Sensors · production',
      ping1: 'main build · green',
      ping2: 'deploy · green',
      ping3a: 'dependabot → jules workflow · ',
      ping3b: 'failed',
      incTitle: 'Main build broken',
      incMeta: 'fingerprint ci:dependabot-jules',
      flow: ['detected', 'PO triaged P0', 'SM delegated'],
    },
    security: {
      kicker: 'Security',
      title: 'Connect your repository with confidence.',
      sub: 'Enterprise-grade security — from the first click to the last mission.',
      items: [
        {
          h: 'Keys encrypted at rest',
          p: 'Your AI engine keys are stored with authenticated encryption. Never in plaintext, never shared.',
          tag: 'AES-256-GCM',
        },
        {
          h: 'Every mission isolated',
          p: 'All work runs in a disposable container, created and destroyed per mission. The agent sees only what it needs.',
          tag: 'Per-mission container',
        },
        {
          h: 'Agents run in safe mode',
          p: 'By default the agent runs restricted and read-only — nothing executes blindly on your code.',
          tag: 'Read-only sandbox',
        },
        {
          h: 'One customer never sees another',
          p: 'Full isolation between accounts at the database: every query is bound to your space.',
          tag: 'Multi-tenant',
        },
        {
          h: 'Nothing gets in unsigned',
          p: 'Every GitHub and payment event is verified by cryptographic signature before it is accepted.',
          tag: 'HMAC-SHA256',
        },
        {
          h: 'Hardened access',
          p: 'Credentials with strong hashing, mandatory authentication and anti-brute-force limits on login.',
          tag: 'bcrypt · rate-limit',
        },
      ],
    },
    trust: {
      kicker: 'Open source',
      title: 'The engine is yours. So are the keys.',
      items: [
        {
          h: 'Your credentials, isolated',
          p: 'You connect your own account. Each project runs with your key, encrypted and never shared.',
        },
        {
          h: 'Runs wherever you want',
          p: 'On GitOrch cloud or your own machine. Same product, no vendor lock-in.',
        },
        {
          h: 'Honest failures',
          p: 'If something did not pass, it says so. No “should be working”: only what was seen working ships as done.',
        },
      ],
    },
    close: {
      title: 'Start for free. Let the team work.',
      body: 'Connect a repository and watch the first mission run today. No card, no commitment.',
      ctaPrimary: 'Start with GitHub',
      ctaGhost: 'See the plans',
    },
    foot: {
      tagline: 'Agents that organize repositories on their own.',
      bottom: '© 2026 GitOrch. Open source.',
      made: 'made by humans, executed by agents',
      c1: 'Product',
      c2: 'Open',
      c3: 'Company',
      l3: ['About', 'Contact'],
    },
  },
  es: {
    nav: {
      entende: 'Entiende',
      organiza: 'Organiza',
      vigia: 'Vigila',
      seg: 'Seguridad',
      planos: 'Planes',
      aberto: 'Código abierto',
      cta: 'Empezar gratis',
    },
    planos: {
      kicker: 'Planes',
      title: 'Empieza gratis. Crece cuando quieras.',
      note: 'Precio en la moneda de tu país. Cancela cuando quieras.',
      tiers: [
        {
          name: 'Gratis',
          price: '$0',
          unit: 'para siempre',
          note: '1 proyecto',
          desc: 'Apruebas cada misión. Self-hosted open-core ilimitado.',
          cta: 'Empezar',
          href: '/setup',
        },
        {
          name: 'Solo',
          price: '$10',
          unit: '/mes',
          note: '2 proyectos · sensores',
          desc: 'El bucle que mantiene tu repositorio sano, solo.',
          cta: 'Suscribirse',
          href: '/setup',
        },
        {
          name: 'Pro',
          price: '$29',
          unit: '/mes',
          note: 'Más misiones · cola prioritaria',
          desc: 'Para quien depende de GitOrch todos los días.',
          cta: 'Suscribirse',
          href: '/setup',
          featured: true,
        },
        {
          name: 'Team',
          price: '$79',
          unit: '/mes',
          note: 'Multiusuario · SSO',
          desc: 'Todo tu equipo en piloto automático.',
          cta: 'Suscribirse',
          href: '/setup',
        },
      ],
    },
    hero: {
      eyebrow: 'Orquestación autónoma de repositorios',
      t1: 'Tu repositorio desordenado,',
      t2: 'ordenado solo.',
      lead: 'Agentes de IA que entienden tu código, planifican el trabajo en Scrum de verdad y entregan Pull Requests — mientras tú diriges el negocio.',
      ctaPrimary: 'Conectar mi GitHub',
      ctaGhost: 'Ver cómo funciona',
      micro: 'Sin tarjeta. Empieza en el plan gratis y corre hoy.',
    },
    console: { live: 'EN VIVO', foot: 'entregado solo', mission: 'misión #4021' },
    events: [
      { role: 'RA', txt: 'Leí 34 módulos con <b>CGC</b>', sub: '6 rutas · 2 riesgos mapeados' },
      {
        role: 'sys',
        txt: '<b>Cortex</b> · memoria del proyecto creada',
        sub: 'la “tienda” se volvió marketplace',
        sys: true,
      },
      { role: 'PO', txt: 'Prioricé el checkout lento', sub: '#3461 · P1 · liberado p/ sprint' },
      { role: 'SM', txt: 'Delegué al agente de dev', sub: 'branch fix/checkout-timeout' },
      { role: 'QA', txt: 'Validé en el navegador', sub: 'PR #257 · verde ✓' },
    ],
    statement:
      'GitOrch es tu equipo de ingeniería autónomo. |Entiende el código, |decide lo que importa y |entrega — solo, en tu repositorio.',
    entende: {
      kicker: 'Entiende',
      tag: 'CGC + Cortex',
      title: 'Conoce tu código mejor que el último dev que se fue.',
      body: 'Antes de tocar nada, lee el repositorio entero con <b>CGC</b>, nuestro grafo de código, y guarda todo en <b>Cortex</b>, la memoria del proyecto. Contexto real — no adivinanzas.',
      learn: 'El equipo que ejecuta',
      file: 'CGC · indexando tienda-antigua',
    },
    organiza: {
      kicker: 'Organiza',
      tag: 'Cadence',
      title: 'Un equipo entero, corriendo Scrum solo.',
      body: 'El <b>Cadence</b> es nuestro Scrum autónomo: el Analista descubre, el PO prioriza por valor, el Scrum Master delega y el QA valida en el navegador. Cada tarea entra al sprint solo cuando tiene sentido.',
      learn: 'Cómo vigila',
      file: 'Cadence · sprint 4',
      cols: ['Descubrimiento', 'Priorizado', 'En dev', 'Validado'],
      titles: ['Envío lento', 'P1 · caja', '#3461', 'PR #261'],
      subs: ['descubierto', 'PO liberó', 'en dev…', 'verde ✓'],
      seed: [
        { b: 'Envío lento', s: 'checkout > 3s' },
        { b: 'Faltan tests', s: 'módulo caja' },
        { b: '#3461', s: 'entregando…' },
        { b: 'PR #257', s: 'verde ✓' },
      ],
    },
    vigia: {
      kicker: 'Vigila',
      tag: 'Sensores',
      title: 'Ve el incidente antes que tú.',
      body: 'Los sensores siguen las fallas de producción y el CI todo el tiempo. Cuando algo se rompe, se vuelve un incidente: el PO clasifica la gravedad y, si es grave, salta la cola en el próximo sprint. Cero humanos en el camino.',
      learn: 'Empezar gratis',
      file: 'Sensores · producción',
      ping1: 'build de main · verde',
      ping2: 'deploy · verde',
      ping3a: 'workflow dependabot → jules · ',
      ping3b: 'falló',
      incTitle: 'Build de main roto',
      incMeta: 'fingerprint ci:dependabot-jules',
      flow: ['detectado', 'trió P0', 'delegó'],
    },
    security: {
      kicker: 'Seguridad',
      title: 'Conecta tu repositorio sin miedo.',
      sub: 'Seguridad de nivel empresarial — del primer clic a la última misión.',
      items: [
        {
          h: 'Claves cifradas en reposo',
          p: 'Las claves de tus motores de IA se guardan con cifrado autenticado. Nunca en texto plano, nunca compartidas.',
          tag: 'AES-256-GCM',
        },
        {
          h: 'Cada misión aislada',
          p: 'Todo el trabajo corre en un contenedor descartable, creado y destruido en cada misión. El agente ve solo lo necesario.',
          tag: 'Contenedor por misión',
        },
        {
          h: 'Agente en modo seguro',
          p: 'Por defecto el agente opera restringido y en solo lectura — nada se ejecuta a ciegas en tu código.',
          tag: 'Sandbox de solo lectura',
        },
        {
          h: 'Un cliente nunca ve a otro',
          p: 'Aislamiento total entre cuentas en la base de datos: cada consulta queda ligada a tu espacio.',
          tag: 'Multi-tenant',
        },
        {
          h: 'Nada entra sin firma',
          p: 'Cada evento de GitHub y de pago se verifica por firma criptográfica antes de aceptarse.',
          tag: 'HMAC-SHA256',
        },
        {
          h: 'Acceso blindado',
          p: 'Credenciales con hash fuerte, autenticación obligatoria y límite anti-fuerza-bruta en el login.',
          tag: 'bcrypt · rate-limit',
        },
      ],
    },
    trust: {
      kicker: 'Código abierto',
      title: 'El motor es tuyo. Las llaves también.',
      items: [
        {
          h: 'Tus credenciales, aisladas',
          p: 'Conectas tu propia cuenta. Cada proyecto corre con tu llave, cifrada y nunca compartida.',
        },
        {
          h: 'Corre donde quieras',
          p: 'En la nube de GitOrch o en tu propia máquina. Mismo producto, sin ataduras de proveedor.',
        },
        {
          h: 'Fallas honestas',
          p: 'Si algo no pasó, lo dice. Nada de “debería estar funcionando”: solo entra como listo lo que se vio funcionando.',
        },
      ],
    },
    close: {
      title: 'Empieza gratis. Deja que el equipo trabaje.',
      body: 'Conecta un repositorio y mira la primera misión correr hoy. Sin tarjeta, sin compromiso.',
      ctaPrimary: 'Empezar con GitHub',
      ctaGhost: 'Ver los planes',
    },
    foot: {
      tagline: 'Agentes que organizan repositorios solos.',
      bottom: '© 2026 GitOrch. Código abierto.',
      made: 'hecho por humanos, ejecutado por agentes',
      c1: 'Producto',
      c2: 'Abierto',
      c3: 'Empresa',
      l3: ['Acerca de', 'Contacto'],
    },
  },
} as const

const GH = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5Z" />
  </svg>
)
const Arrow = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)
const Mark = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="12" r="2.4" />
    <path d="M6 8.4v7.2M8 6h4.6a3 3 0 0 1 3 3v0M8 18h4.6a3 3 0 0 0 3-3v0" />
  </svg>
)

export default function Home() {
  const { language, setLanguage } = useLanguage()
  const lang: Lang = (LANDING_LANGS as string[]).includes(language) ? (language as Lang) : 'en'
  const c = COPY[lang] ?? COPY.en
  const rootRef = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<'dark' | 'light' | null>(null)
  // Preços por FAIXA do país do visitante (backend detecta pelo IP). null = ainda
  // carregando / falhou → mantém o preço estático dos cards (USD faixa A).
  const [prices, setPrices] = useState<Record<string, { amount: number; currency: string }> | null>(
    null
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      // País pela localização real (IP). Passa pro /api/pricing → moeda do país.
      const country = await detectCountry()
      if (!alive) return
      const qs = country ? `?country=${country}` : ''
      try {
        const r = await fetch(`${API_BASE_URL}/api/pricing${qs}`)
        const data = (r.ok ? await r.json() : null) as {
          plans?: Array<{ planId: string; unitAmount: number; currency: string }>
        } | null
        if (!alive || !data?.plans) return
        const map: Record<string, { amount: number; currency: string }> = {}
        for (const p of data.plans) map[p.planId] = { amount: p.unitAmount, currency: p.currency }
        setPrices(map)
      } catch {
        // mantém o preço estático se a API/geo falhar
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const toggleTheme = () => {
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    const current = theme ?? (prefersDark ? 'dark' : 'light')
    setTheme(current === 'dark' ? 'light' : 'dark')
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cleanups: Array<() => void> = []
    const css = (v: string) => getComputedStyle(root).getPropertyValue(v).trim()

    // Nav border on scroll
    const nav = root.querySelector('.gl-nav') as HTMLElement | null
    const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    cleanups.push(() => window.removeEventListener('scroll', onScroll))

    // Headline spotlight follows cursor
    const ht = root.querySelector('.gl-title') as HTMLElement | null
    if (ht && !reduce) {
      const mv = (e: PointerEvent) => {
        const r = ht.getBoundingClientRect()
        ht.style.setProperty('--mx', e.clientX - r.left + 'px')
        ht.style.setProperty('--my', e.clientY - r.top + 'px')
      }
      ht.addEventListener('pointermove', mv)
      cleanups.push(() => ht.removeEventListener('pointermove', mv))
    }

    // Reveal on scroll
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.14, rootMargin: '0px 0px -8% 0px' }
    )
    root.querySelectorAll('.gl-reveal:not(.in)').forEach((el) => io.observe(el))
    cleanups.push(() => io.disconnect())

    // Statement — word-by-word blur→sharp wave tied to scroll
    const stmt = root.querySelector('.gl-statement') as HTMLElement | null
    const words = stmt ? Array.from(stmt.querySelectorAll<HTMLElement>('.gl-word')) : []
    const litOnScroll = () => {
      if (!stmt) return
      const r = stmt.getBoundingClientRect()
      const vh = window.innerHeight
      const N = words.length
      // stmt é alto; enquanto o texto fica pinado (sticky), -top vai 0 → (altura-vh).
      // Mapeia esse trecho de scroll numa onda palavra a palavra. Sob reduce-motion,
      // revelamos só por OPACIDADE (sem blur/translate) — a "palavra aparecendo ao
      // rolar" continua funcionando, sem o movimento pesado (acessível).
      const prog = Math.max(0, Math.min(1, -r.top / Math.max(1, stmt.offsetHeight - vh)))
      const p = Math.min(1, prog / 0.72) // termina a revelação ~72% do pin
      words.forEach((w, i) => {
        const local = Math.max(0, Math.min(1, p * (N + 2) - i))
        w.style.opacity = (0.08 + 0.92 * local).toFixed(3)
        w.style.filter =
          reduce || local >= 1 ? 'none' : 'blur(' + ((1 - local) * 7).toFixed(2) + 'px)'
        w.style.transform =
          reduce || local >= 1 ? 'none' : 'translateY(' + ((1 - local) * 8).toFixed(2) + 'px)'
      })
    }
    let tick = false
    const onStmtScroll = () => {
      if (!tick) {
        tick = true
        requestAnimationFrame(() => {
          litOnScroll()
          tick = false
        })
      }
    }
    window.addEventListener('scroll', onStmtScroll, { passive: true })
    window.addEventListener('resize', litOnScroll)
    litOnScroll()
    cleanups.push(() => {
      window.removeEventListener('scroll', onStmtScroll)
      window.removeEventListener('resize', litOnScroll)
    })

    // Run an animation only while its section is on screen
    const whenVisible = (el: Element, on: () => void, off?: () => void) => {
      const o = new IntersectionObserver(
        (es) => es.forEach((e) => (e.isIntersecting ? on() : off && off())),
        { threshold: 0.25 }
      )
      o.observe(el)
      cleanups.push(() => o.disconnect())
    }

    // Hero live console
    const feed = root.querySelector('.gl-feed') as HTMLElement | null
    if (feed) {
      const EV = c.events
      let ei = 0
      let nodes: HTMLElement[] = []
      let paused = true
      let timer: ReturnType<typeof setInterval> | null = null
      const render = (ev: (typeof EV)[number]) => {
        const el = document.createElement('div')
        el.className = 'gl-ev active'
        const roleCls = 'sys' in ev && ev.sys ? 'sys' : ''
        el.innerHTML = `<div class="gl-role ${roleCls}">${roleCls ? 'sys' : ev.role}</div><div class="gl-evtxt">${ev.txt}<span class="gl-sub">${ev.sub}</span></div>`
        feed.appendChild(el)
        requestAnimationFrame(() => el.classList.add('show'))
        nodes.forEach((n) => n.classList.remove('active'))
        nodes.push(el)
        while (nodes.length > 5) {
          const old = nodes.shift()
          old?.remove()
        }
      }
      const step = () => {
        render(EV[ei % EV.length])
        ei++
        if (ei % EV.length === 0)
          setTimeout(() => {
            if (!paused) {
              nodes.forEach((n) => n.remove())
              nodes = []
            }
          }, 1600)
      }
      if (reduce) {
        EV.forEach(render)
      } else
        whenVisible(
          feed,
          () => {
            if (!timer) {
              paused = false
              step()
              timer = setInterval(step, 1700)
            }
          },
          () => {
            paused = true
            if (timer) clearInterval(timer)
            timer = null
          }
        )
      cleanups.push(() => {
        if (timer) clearInterval(timer)
      })
    }

    // Pillar 1 — CGC graph building on canvas
    const cv = root.querySelector('.gl-graph') as HTMLCanvasElement | null
    if (cv) {
      const ctx = cv.getContext('2d')!
      let W = 0,
        H = 0,
        t = 0,
        raf = 0
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let pts: Array<{ x: number; y: number; r: number; born: number }> = []
      let edges: Array<{ a: number; b: number; born: number }> = []
      const build = () => {
        const r = cv.getBoundingClientRect()
        W = r.width
        H = r.height
        cv.width = W * dpr
        cv.height = H * dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        pts = []
        const N = 16
        for (let i = 0; i < N; i++)
          pts.push({
            x: 40 + Math.random() * (W - 80),
            y: 26 + Math.random() * (H - 52),
            r: 3 + Math.random() * 3,
            born: i * 0.06,
          })
        edges = []
        for (let i = 0; i < N; i++) {
          const cc = 1 + ((i * 7) % 2)
          for (let k = 1; k <= cc; k++) {
            const j = (i + k * 3) % N
            if (j !== i) edges.push({ a: i, b: j, born: Math.max(i, j) * 0.06 + 0.05 })
          }
        }
      }
      const frame = () => {
        t += 0.008
        const tt = Math.min(t, 1.2)
        const ink = css('--gl-ink'),
          acc = css('--gl-accent'),
          line = css('--gl-graph-line')
        ctx.clearRect(0, 0, W, H)
        ctx.strokeStyle = line
        ctx.lineWidth = 1.2
        edges.forEach((e) => {
          if (tt > e.born) {
            const a = pts[e.a],
              b = pts[e.b]
            const k = Math.min(1, (tt - e.born) * 3)
            ctx.globalAlpha = 0.78 * k
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k)
            ctx.stroke()
          }
        })
        ctx.globalAlpha = 1
        pts.forEach((p, i) => {
          if (tt > p.born) {
            const k = Math.min(1, (tt - p.born) * 4)
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.r * k, 0, Math.PI * 2)
            ctx.fillStyle = i % 5 === 0 ? acc : ink
            ctx.globalAlpha = i % 5 === 0 ? 1 : 0.5
            ctx.fill()
          }
        })
        ctx.globalAlpha = 1
        if (t < 1.5) raf = requestAnimationFrame(frame)
      }
      const start = () => {
        t = 0
        build()
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(frame)
      }
      const onResize = () => build()
      if (reduce) {
        build()
        t = 2
        frame()
      } else {
        whenVisible(cv, start, () => cancelAnimationFrame(raf))
        window.addEventListener('resize', onResize)
      }
      cleanups.push(() => {
        cancelAnimationFrame(raf)
        window.removeEventListener('resize', onResize)
      })
    }

    // Pillar 2 — Kanban: build seed cards imperatively, move one across columns
    const kb = root.querySelector('.gl-kb') as HTMLElement | null
    if (kb) {
      const cols = Array.from(kb.querySelectorAll<HTMLElement>('.gl-kbcol'))
      const made: HTMLElement[] = []
      c.organiza.seed.forEach((d, i) => {
        const el = document.createElement('div')
        el.className = 'gl-card' + (i === 0 ? ' mover' : '')
        el.innerHTML = `<b>${d.b}</b>${d.s}`
        cols[i]?.appendChild(el)
        made.push(el)
      })
      const mover = made[0]
      let col = 0
      let timer: ReturnType<typeof setInterval> | null = null
      const move = () => {
        col = (col + 1) % 4
        cols[col].appendChild(mover)
        const b = mover.querySelector('b')
        if (b) b.textContent = c.organiza.titles[col]
        const last = mover.lastChild
        if (last) last.textContent = c.organiza.subs[col]
      }
      if (!reduce)
        whenVisible(
          kb,
          () => {
            if (!timer) timer = setInterval(move, 1600)
          },
          () => {
            if (timer) clearInterval(timer)
            timer = null
          }
        )
      cleanups.push(() => {
        if (timer) clearInterval(timer)
        made.forEach((m) => m.remove())
      })
    }

    // Pillar 3 — incident appears after the alert ping
    const inc = root.querySelector('.gl-inc') as HTMLElement | null
    const vigia = root.querySelector('#vigia') as HTMLElement | null
    if (inc && vigia) {
      if (reduce) inc.classList.add('in')
      else
        whenVisible(
          vigia,
          () => setTimeout(() => inc.classList.add('in'), 900),
          () => inc.classList.remove('in')
        )
    }

    return () => cleanups.forEach((fn) => fn())
  }, [c, lang])

  const stmtWords = c.statement.split(' ').map((w, i) => {
    const key = w.startsWith('|')
    return (
      <React.Fragment key={i}>
        <span className={'gl-word' + (key ? ' key' : '')}>{key ? w.slice(1) : w}</span>{' '}
      </React.Fragment>
    )
  })

  return (
    <div className="gl" data-theme={theme ?? undefined} ref={rootRef}>
      <header className="gl-nav">
        <div className="gl-container gl-nav-inner">
          <Link className="gl-brand" href="#top" aria-label="GitOrch">
            <span className="gl-mark" aria-hidden="true">
              <Mark />
            </span>
            GitOrch
          </Link>
          <nav className="gl-links" aria-label="Principal">
            <a href="#entende">{c.nav.entende}</a>
            <a href="#organiza">{c.nav.organiza}</a>
            <a href="#vigia">{c.nav.vigia}</a>
            <a href="#seguranca">{c.nav.seg}</a>
            <a href="#planos">{c.nav.planos}</a>
            <a href="#aberto">{c.nav.aberto}</a>
          </nav>
          <div className="gl-nav-right">
            <button
              className="gl-lang"
              onClick={() => {
                const i = LANDING_LANGS.indexOf(lang)
                setLanguage(LANDING_LANGS[(i + 1) % LANDING_LANGS.length])
              }}
              aria-label="Idioma"
            >
              {lang.toUpperCase()}
            </button>
            <button
              className="gl-toggle"
              onClick={toggleTheme}
              aria-label="Tema claro/escuro"
              title="Tema"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
              </svg>
            </button>
            <Link className="gl-pill" href="/setup">
              {c.nav.cta}
            </Link>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="gl-hero gl-container">
          <div className="gl-hero-grid">
            <div>
              <span className="gl-eyebrow gl-reveal in">
                <span className="gl-dot" aria-hidden="true" />
                {c.hero.eyebrow}
              </span>
              <h1 className="gl-title gl-reveal in">
                {c.hero.t1} <span className="gl-accent">{c.hero.t2}</span>
                <span className="gl-spot" aria-hidden="true" />
              </h1>
              <p className="gl-lead gl-reveal in d1">{c.hero.lead}</p>
              <div className="gl-cta gl-reveal in d2">
                <Link className="gl-pill" href="/setup">
                  <span className="gl-ico">{GH}</span>
                  {c.hero.ctaPrimary}
                </Link>
                <a className="gl-pill ghost" href="#entende">
                  {c.hero.ctaGhost}
                </a>
              </div>
              <p className="gl-micro gl-reveal in d3">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {c.hero.micro}
              </p>
            </div>
            <div className="gl-console-wrap gl-reveal in d1">
              <div className="gl-halo" aria-hidden="true" />
              <div className="gl-console">
                <div className="gl-console-bar">
                  <span className="gl-tl" />
                  <span className="gl-tl" />
                  <span className="gl-tl" />
                  <span className="gl-repo">seu-org/loja-antiga</span>
                  <span className="gl-livetag">
                    <span className="gl-g" />
                    {c.console.live}
                  </span>
                </div>
                <div className="gl-feed" />
                <div className="gl-feed-foot">
                  <span className="gl-mono">{c.console.mission}</span>
                  <span className="gl-ok">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {c.console.foot}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="gl-statement">
          <div className="gl-statement-sticky gl-container">
            <p>{stmtWords}</p>
          </div>
        </section>

        <Pillar
          id="entende"
          data={c.entende}
          learnHref="#organiza"
          viz={
            <div className="gl-viz-body">
              <canvas className="gl-graph" aria-hidden="true" />
            </div>
          }
        />

        <Pillar
          id="organiza"
          flip
          data={c.organiza}
          learnHref="#vigia"
          viz={
            <div className="gl-viz-body">
              <div className="gl-kb">
                {c.organiza.cols.map((col, i) => (
                  <div className="gl-kbcol" key={i}>
                    <div className="gl-kbh">
                      <span className="gl-rd" />
                      {col}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          }
        />

        <Pillar
          id="vigia"
          data={c.vigia}
          learnHref="#preco"
          viz={
            <div className="gl-viz-body">
              <div className="gl-radar">
                <div className="gl-ping">
                  <span className="gl-pd" />
                  {c.vigia.ping1}
                </div>
                <div className="gl-ping">
                  <span className="gl-pd" />
                  {c.vigia.ping2}
                </div>
                <div className="gl-ping alert">
                  <span className="gl-pd" />
                  {c.vigia.ping3a}
                  <span style={{ color: 'var(--gl-sev)' }}>{c.vigia.ping3b}</span>
                </div>
                <div className="gl-inc">
                  <div className="gl-stripe" aria-hidden="true" />
                  <div className="gl-inc-b">
                    <div className="gl-inc-top">
                      <span className="gl-sev">P0</span>
                      <span className="gl-inc-title">{c.vigia.incTitle}</span>
                    </div>
                    <div className="gl-inc-meta gl-mono">{c.vigia.incMeta}</div>
                    <div className="gl-inc-flow">
                      <span>{c.vigia.flow[0]}</span>
                      <Arrow />
                      <span>
                        <span className="gl-c">PO</span> {c.vigia.flow[1]}
                      </span>
                      <Arrow />
                      <span>
                        <span className="gl-c">SM</span> {c.vigia.flow[2]}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          }
        />

        <section className="gl-security" id="seguranca">
          <div className="gl-container" style={{ paddingBlock: 'clamp(72px,13vh,130px)' }}>
            <div className="gl-reveal" style={{ marginBottom: 'clamp(36px,6vh,56px)' }}>
              <span className="gl-kicker">{c.security.kicker}</span>
              <h2 className="gl-trust-title">{c.security.title}</h2>
              <p
                style={{
                  color: 'var(--gl-muted)',
                  fontSize: '1rem',
                  margin: '12px 0 0',
                  maxWidth: '46ch',
                }}
              >
                {c.security.sub}
              </p>
            </div>
            <div className="gl-trust-grid">
              {c.security.items.map((it, i) => (
                <div className={'gl-trust-item gl-reveal d' + ((i % 3) + 1)} key={i}>
                  <h3>
                    <TrustIcon i={i % 3} />
                    {it.h}
                  </h3>
                  <p>{it.p}</p>
                  <span className="gl-sec-tag">{it.tag}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="gl-trust" id="aberto">
          <div className="gl-container" style={{ paddingBlock: 'clamp(72px,13vh,130px)' }}>
            <div className="gl-reveal" style={{ marginBottom: 'clamp(36px,6vh,56px)' }}>
              <span className="gl-kicker">{c.trust.kicker}</span>
              <h2 className="gl-trust-title">{c.trust.title}</h2>
            </div>
            <div className="gl-trust-grid">
              {c.trust.items.map((it, i) => (
                <div className={'gl-trust-item gl-reveal d' + (i + 1)} key={i}>
                  <h3>
                    <TrustIcon i={i} />
                    {it.h}
                  </h3>
                  <p>{it.p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="gl-planos" id="planos">
          <div className="gl-container">
            <div
              className="gl-reveal"
              style={{ textAlign: 'center', marginBottom: 'clamp(40px,7vh,64px)' }}
            >
              <span className="gl-kicker">{c.planos.kicker}</span>
              <h2 className="gl-trust-title" style={{ marginInline: 'auto' }}>
                {c.planos.title}
              </h2>
            </div>
            <div className="gl-plan-grid">
              {c.planos.tiers.map((tier, i) => {
                const planId =
                  (
                    {
                      Grátis: 'free',
                      Free: 'free',
                      Solo: 'solo',
                      Pro: 'pro',
                      Team: 'team',
                    } as Record<string, string>
                  )[tier.name] ?? tier.name.toLowerCase()
                const geo = prices?.[planId]
                // Moeda da faixa detectada (qualquer plano pago define a moeda do
                // país) — pro plano grátis não mostrar "$0" pra quem vê R$.
                const geoIsBrl = prices
                  ? Object.values(prices).some((g) => g.currency === 'brl')
                  : false
                let priceLabel: string = tier.price
                if (geo) {
                  const v = geo.amount / 100
                  const num = Number.isInteger(v) ? String(v) : v.toFixed(2)
                  priceLabel = (geoIsBrl ? 'R$' : '$') + (geoIsBrl ? num.replace('.', ',') : num)
                } else if (geoIsBrl) {
                  // grátis (não vem na API): troca só o símbolo pra coerência.
                  priceLabel = tier.price.replace(/\$/g, 'R$')
                }
                const isFree = planId === 'free'
                return (
                  <div
                    className={
                      'gl-plan gl-reveal d' + (i + 1) + ('featured' in tier ? ' featured' : '')
                    }
                    key={i}
                  >
                    {'featured' in tier && <span className="gl-plan-badge">Recomendado</span>}
                    <div className="gl-plan-name">{tier.name}</div>
                    <div className="gl-plan-price">
                      {priceLabel}
                      {'unit' in tier && <span className="gl-plan-unit">{tier.unit}</span>}
                    </div>
                    <div className="gl-plan-note">{tier.note}</div>
                    <p className="gl-plan-desc">{tier.desc}</p>
                    <Link
                      className={'gl-pill' + ('featured' in tier ? '' : ' ghost')}
                      href={isFree ? '/setup' : `/setup?plan=${planId}`}
                    >
                      {tier.cta}
                    </Link>
                  </div>
                )
              })}
            </div>
            <p className="gl-plan-foot gl-reveal">{c.planos.note}</p>
          </div>
        </section>

        <section className="gl-close gl-container" id="preco">
          <div className="gl-reveal">
            <h2>{c.close.title}</h2>
            <p>{c.close.body}</p>
            <div className="gl-cta" style={{ justifyContent: 'center' }}>
              <Link className="gl-pill" href="/setup">
                <span className="gl-ico">{GH}</span>
                {c.close.ctaPrimary}
              </Link>
              <a className="gl-pill ghost" href="#planos">
                {c.close.ctaGhost}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="gl-foot">
        <div className="gl-container">
          <div className="gl-foot-grid">
            <div style={{ maxWidth: 260 }}>
              <span className="gl-brand" style={{ marginBottom: 14 }}>
                <span className="gl-mark" aria-hidden="true">
                  <Mark />
                </span>
                GitOrch
              </span>
              <p style={{ fontSize: '.9rem', color: 'var(--gl-muted)', margin: 0 }}>
                {c.foot.tagline}
              </p>
            </div>
            <div className="gl-foot-cols">
              <div className="gl-foot-col">
                <h4>{c.foot.c1}</h4>
                <a href="#entende">{c.nav.entende}</a>
                <a href="#organiza">{c.nav.organiza}</a>
                <a href="#vigia">{c.nav.vigia}</a>
                <a href="#seguranca">{c.nav.seg}</a>
                <a href="#planos">{c.nav.planos}</a>
              </div>
              <div className="gl-foot-col">
                <h4>{c.foot.c2}</h4>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                  GitHub
                </a>
                <a href="#aberto">Self-hosted</a>
              </div>
            </div>
          </div>
          <div className="gl-foot-bottom">
            <span>{c.foot.bottom}</span>
            <span className="gl-mono">{c.foot.made}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

function TrustIcon({ i }: { i: number }) {
  if (i === 0)
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    )
  if (i === 1)
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4Z" />
      </svg>
    )
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  )
}

type PillarData = {
  kicker: string
  tag: string
  title: string
  body: string
  learn: string
  file: string
}
function Pillar({
  id,
  flip,
  data,
  viz,
  learnHref,
}: {
  id: string
  flip?: boolean
  data: PillarData
  viz: React.ReactNode
  learnHref: string
}) {
  return (
    <section className={'gl-pillar' + (flip ? ' flip' : '')} id={id}>
      <div className="gl-pillar-grid gl-container">
        <div className="gl-ptext gl-reveal">
          <span className="gl-kicker">
            {data.kicker} <span className="gl-tag">· {data.tag}</span>
          </span>
          <h2 dangerouslySetInnerHTML={{ __html: data.title }} />
          <p dangerouslySetInnerHTML={{ __html: data.body }} />
          <a className="gl-learn" href={learnHref}>
            {data.learn} <Arrow />
          </a>
        </div>
        <div className="gl-viz gl-reveal d1">
          <div className="gl-viz-bar">
            <span className="gl-tl" />
            <span className="gl-tl" />
            <span className="gl-tl" />
            <span className="gl-fname gl-mono">{data.file}</span>
          </div>
          {viz}
        </div>
      </div>
    </section>
  )
}
