import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// POR QUE ESTE TESTE EXISTE: o interruptor da régua de pronto é um <button>
// SEM FILHOS com className `pn-sw`. A classe nunca foi escrita no CSS, então o
// botão nasceu com 0x0 e a seção "Marque o que precisa acontecer" não tinha
// nada para marcar — dois PRs verdes passaram por cima porque todo teste
// conferia CHAMADA (a rota respondeu, o onClick disparou), nunca RESULTADO
// (o controle tem tamanho na tela). Aqui a asserção é sobre a regra CSS.

const RAIZ = join(__dirname, '..', '..')
// Sem os comentários: senão uma classe só CITADA num comentário contaria como
// definida, e um `/* ... */` antes de uma propriedade escondia a propriedade
// do leitor de regras abaixo.
const semComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '')
const CSS = semComentarios(readFileSync(join(RAIZ, 'app', 'globals.css'), 'utf8'))

/** Corpo da primeira regra cujo seletor casa exatamente com `seletor`. */
function corpoDaRegra(seletor: string): string | null {
  // Percorre bloco a bloco em vez de uma regex gulosa: o arquivo tem media
  // queries aninhadas e um `[^}]*` pegaria o bloco errado.
  const alvo = seletor.trim()
  let i = 0
  while (i < CSS.length) {
    const abre = CSS.indexOf('{', i)
    if (abre === -1) return null
    const fecha = CSS.indexOf('}', abre)
    if (fecha === -1) return null
    const cabeca = CSS.slice(i, abre)
    const seletores = cabeca
      .split(/[\n;]/)
      .pop()!
      .split(',')
      .map((s) => s.trim())
    if (seletores.includes(alvo)) return CSS.slice(abre + 1, fecha)
    i = fecha + 1
  }
  return null
}

/**
 * TODA regra do arquivo, com seletor e corpo próprio. Diferente de
 * `corpoDaRegra`, que procura UM seletor já conhecido e por isso tolera
 * imprecisão dentro de `@media`, este varre o arquivo INTEIRO — se atribuísse
 * uma declaração ao seletor errado, o teste estrutural acusaria a regra errada
 * e mandaria consertar código inocente. Por isso conta profundidade de chave.
 */
function todasAsRegras(): { sel: string; corpo: string }[] {
  const regras: { sel: string; corpo: string }[] = []
  const pilha: { sel: string; corpo: string }[] = []
  let i = 0
  let ini = 0
  while (i < CSS.length) {
    const abre = CSS.indexOf('{', i)
    const fecha = CSS.indexOf('}', i)
    if (fecha === -1) break
    if (abre !== -1 && abre < fecha) {
      const trecho = CSS.slice(ini, abre)
      if (pilha.length) pilha[pilha.length - 1].corpo += trecho
      pilha.push({ sel: trecho.split(/[;{}]/).pop()!.trim().replace(/\s+/g, ' '), corpo: '' })
      i = abre + 1
      ini = i
    } else {
      if (pilha.length) {
        const r = pilha.pop()!
        r.corpo += CSS.slice(ini, fecha)
        regras.push(r)
      }
      i = fecha + 1
      ini = i
    }
  }
  return regras
}

/**
 * Todo `style={{ … }}` de todo .tsx sob `src/`, com arquivo e linha.
 * Casa as chaves por PROFUNDIDADE, não por regex: um `[^}]*` pararia no
 * primeiro `}` interno (um `rgba()` não tem chaves, mas um objeto aninhado
 * tem) e cortaria o bloco no meio, escondendo justamente o `color:` que esta
 * varredura existe para achar.
 */
function todosOsEstilosInline(): { arquivo: string; linha: number; bloco: string }[] {
  const arquivos: string[] = []
  const desce = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const caminho = join(dir, item.name)
      if (item.isDirectory()) desce(caminho)
      else if (item.name.endsWith('.tsx')) arquivos.push(caminho)
    }
  }
  // As TRÊS telas que abrem o escopo `.gl` moram aqui dentro: landing (app/),
  // wizard e painel (components/). Varrer só uma delas foi o erro que deixou a
  // quarta cor chumbada passar.
  desce(join(RAIZ, 'components'))
  desce(join(RAIZ, 'app'))

  const blocos: { arquivo: string; linha: number; bloco: string }[] = []
  const marca = 'style={{'
  for (const arquivo of arquivos) {
    const fonte = readFileSync(arquivo, 'utf8')
    let i = fonte.indexOf(marca)
    while (i !== -1) {
      let profundidade = 2 // as duas chaves de `{{` já entraram
      let j = i + marca.length
      while (j < fonte.length && profundidade > 0) {
        if (fonte[j] === '{') profundidade++
        else if (fonte[j] === '}') profundidade--
        j++
      }
      blocos.push({
        arquivo: arquivo.slice(RAIZ.length + 1),
        linha: fonte.slice(0, i).split('\n').length,
        bloco: fonte.slice(i + marca.length, j - 2),
      })
      i = fonte.indexOf(marca, j)
    }
  }
  return blocos
}

/**
 * Valor de uma chave dentro de um objeto de estilo inline. O separador é
 * vírgula, então um `split(',')` cortaria `rgba(1, 2, 3, 0.4)` em quatro —
 * por isso a vírgula só encerra o valor em profundidade zero de parênteses.
 */
function valorInline(bloco: string, chave: string): string | null {
  const m = bloco.match(new RegExp(`(?:^|[,{\\s])${chave}\\s*:`))
  if (!m) return null
  let i = (m.index ?? 0) + m[0].length
  let profundidade = 0
  let valor = ''
  while (i < bloco.length) {
    const c = bloco[i]
    if (c === '(' || c === '[' || c === '{') profundidade++
    else if (c === ')' || c === ']' || c === '}') profundidade--
    else if (c === ',' && profundidade === 0) break
    valor += c
    i++
  }
  return valor.trim()
}

/** Valor de uma propriedade dentro de um corpo de regra. */
function prop(corpo: string, nome: string): string | null {
  const m = corpo.match(new RegExp(`(?:^|;)\\s*${nome}\\s*:\\s*([^;]+)`))
  return m ? m[1].trim() : null
}

/** Comprimento CSS em px; 0 para ausente, vazio ou zero. */
function px(valor: string | null): number {
  if (!valor) return 0
  const m = valor.match(/(-?[\d.]+)px/)
  return m ? parseFloat(m[1]) : 0
}

// 24 CSS px é o piso do WCAG 2.5.8 (Target Size — Minimum, AA na 2.2): abaixo
// disso o alvo deixa de ser confiavelmente acertável no toque. O interruptor
// mede 42x24 — sobra na largura, encosta exatamente no piso na altura. O
// `> 0` de antes deixava passar um interruptor de 1x1px, que é a MESMA classe
// de defeito (existe no CSS, inútil na tela) que este arquivo existe para
// impedir. O `> 0` só provava que alguém escreveu a propriedade.
const ALVO_MIN_PX = 24

describe('interruptor da régua de pronto (.pn-sw)', () => {
  const base = corpoDaRegra('.gl .pn-sw')

  it('a regra existe no CSS do painel', () => {
    expect(base).not.toBeNull()
  })

  it(`é clicável de verdade — pelo menos ${ALVO_MIN_PX}x${ALVO_MIN_PX}px (WCAG 2.5.8)`, () => {
    expect(px(prop(base ?? '', 'width'))).toBeGreaterThanOrEqual(ALVO_MIN_PX)
    expect(px(prop(base ?? '', 'height'))).toBeGreaterThanOrEqual(ALVO_MIN_PX)
  })

  it('o estado ligado muda a aparência (.pn-sw.on tem background próprio)', () => {
    const ligado = corpoDaRegra('.gl .pn-sw.on')
    expect(ligado).not.toBeNull()
    expect(prop(ligado ?? '', 'background')).toBeTruthy()
    expect(prop(ligado ?? '', 'background')).not.toBe(prop(base ?? '', 'background'))
  })

  it('tem o botão deslizante (::before) e ele se move no estado ligado', () => {
    const botao = corpoDaRegra('.gl .pn-sw::before')
    expect(botao).not.toBeNull()
    expect(px(prop(botao ?? '', 'width'))).toBeGreaterThan(0)
    const movido = corpoDaRegra('.gl .pn-sw.on::before')
    expect(movido).not.toBeNull()
    expect(prop(movido ?? '', 'transform')).toBeTruthy()
  })

  it('a bolinha anda de verdade e o curso não a joga para fora do trilho', () => {
    // Geometria, não presença de propriedade: `transform` existir só prova que
    // alguém escreveu `transform`. O que importa é o RESULTADO — a bolinha
    // parar dentro do trilho. Descontando a borda dos dois lados sobra a
    // largura útil, e folga inicial + curso + bolinha tem que caber nela.
    const bolinha = corpoDaRegra('.gl .pn-sw::before')
    const movido = corpoDaRegra('.gl .pn-sw.on::before')
    const util = px(prop(base ?? '', 'width')) - 2 * px(prop(base ?? '', 'border'))
    const folga = px(prop(bolinha ?? '', 'left'))
    const diametro = px(prop(bolinha ?? '', 'width'))
    const curso = px(prop(movido ?? '', 'transform'))

    expect(curso).toBeGreaterThan(0)
    expect(diametro).toBeGreaterThan(0)
    expect(folga + curso + diametro).toBeLessThanOrEqual(util)
  })

  it('a transição é suave (o próprio ::before declara transition)', () => {
    expect(prop(corpoDaRegra('.gl .pn-sw::before') ?? '', 'transition')).toBeTruthy()
  })

  it('tem foco visível pelo teclado', () => {
    const foco = corpoDaRegra('.gl .pn-sw:focus-visible')
    expect(foco).not.toBeNull()
    expect(prop(foco ?? '', 'outline') ?? prop(foco ?? '', 'box-shadow')).toBeTruthy()
  })
})

/**
 * POR QUE ESTE BLOCO EXISTE: a tela da cascata desabilita o seletor de esforço
 * do Antigravity (lá `--effort` junto de `--model` é erro duro do CLI). O
 * `disabled` estava no atributo e o motivo estava escrito embaixo — mas o
 * CAMPO continuava com a mesma aparência de um campo ativo, porque
 * `.gl .pn-field` nunca teve regra de `:disabled`. Visto na captura do
 * navegador, não deduzido: lado a lado com um campo ativo idêntico, os dois
 * eram indistinguíveis.
 *
 * É a mesma família do defeito que este arquivo já pegava no `.pn-sw`: o
 * atributo existe, o comportamento existe, e a tela não conta. Um controle que
 * PARECE ativo e não responde faz o dono achar que o clique dele se perdeu.
 */
describe('campo desabilitado precisa PARECER desabilitado (.pn-field:disabled)', () => {
  const base = corpoDaRegra('.gl .pn-field')
  const off = corpoDaRegra('.gl .pn-field:disabled')

  it('a regra existe', () => {
    expect(off).not.toBeNull()
  })

  it('e muda de verdade a aparência — não é uma regra vazia', () => {
    // Resultado, não presença: uma regra `:disabled {}` sem declaração passaria
    // num teste de existência e não mudaria um pixel.
    const mudou =
      prop(off ?? '', 'opacity') ?? prop(off ?? '', 'background') ?? prop(off ?? '', 'color')
    expect(mudou).toBeTruthy()
    expect(prop(off ?? '', 'background') ?? '').not.toBe(prop(base ?? '', 'background') ?? '')
  })

  it('e o cursor avisa que ele não aceita clique', () => {
    expect(prop(off ?? '', 'cursor')).toBe('not-allowed')
  })
})

describe('varredura: nada usado no painel pode faltar no CSS', () => {
  const dirPainel = join(RAIZ, 'components', 'painel')
  // app/painel/page.tsx entra junto porque é a RAIZ da tela: é lá que mora o
  // <div className="gl" data-theme=...> que abre o escopo de TODAS as regras
  // `.gl .pn-*`, e de lá saem 24 classes pn-* (pn-side, pn-top, pn-sheet…).
  // Varrer só components/painel deixava sem conferência justo o arquivo que
  // define o contêiner — uma classe órfã escrita ali passava batido.
  const arquivos = [
    ...readdirSync(dirPainel)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => join(dirPainel, f)),
    join(RAIZ, 'app', 'painel', 'page.tsx'),
  ]
  const jsx = arquivos
    .map((f) => semComentarios(readFileSync(f, 'utf8')))
    .join('\n')
    .replace(/^\s*\/\/.*$/gm, '')

  // Casamento EXATO, não substring: `CSS.includes('.pn-b')` casa DENTRO de
  // `.pn-btn`, então uma classe órfã chamada `pn-b` seria dada como definida e
  // a varredura inteira viraria teatro. O lookahead recusa qualquer caractere
  // que ainda faça parte do nome da classe; o que pode vir depois é o que
  // encerra um seletor (`.`, `:`, `,`, espaço, `{`, `[`, `>`…).
  const temRegraNoCss = (classe: string) => new RegExp(`\\.${classe}(?![\\w-])`).test(CSS)

  it('toda classe pn-* usada no JSX tem regra no CSS', () => {
    const usadas = new Set(jsx.match(/pn-[a-z0-9-]+/g) ?? [])
    const semRegra = [...usadas].filter((c) => !temRegraNoCss(c))
    expect(semRegra).toEqual([])
  })

  it('a checagem de classe definida não aceita prefixo de outra classe', () => {
    // Guarda da guarda: `pn-btn` existe no CSS, `pn-b` não. Se esta asserção
    // cair, a varredura voltou a ser substring e para de valer.
    expect(temRegraNoCss('pn-btn')).toBe(true)
    expect(temRegraNoCss('pn-b')).toBe(false)
  })

  // Só conta quem é citado SEM fallback: `var(--x, #ccc)` degrada sozinho, mas
  // `var(--x)` de token inexistente é inválido em tempo de computação e a
  // propriedade cai para a herdada — foi o que apagou a tinta do botão ativo
  // da duração da sprint, nesta mesma tela.
  it('todo token --gl-* usado sem fallback está definido', () => {
    const citados = new Set(
      [...`${CSS}\n${jsx}`.matchAll(/var\(\s*(--gl-[a-z0-9-]+)\s*\)/g)].map((m) => m[1])
    )
    const semDefinicao = [...citados].filter((t) => !new RegExp(`${t}\\s*:`).test(CSS))
    expect(semDefinicao).toEqual([])
  })
})

// POR QUE ESTE BLOCO EXISTE: nesta mesma tarefa eu mexi em --gl-on-accent
// "para melhorar a legibilidade do botão ativo" e, no tema claro, o contraste
// CAIU de 4.35:1 para 4.15:1 — eu tinha olhado, não medido. Olho não mede
// razão de contraste; conta mede. A conta agora roda no CI, nos dois temas.
describe('contraste do que fica em cima do accent (WCAG 2.1)', () => {
  /** Luminância relativa — WCAG 2.1, definição de relative luminance. */
  function luminancia(hex: string): number {
    const h = hex.replace('#', '')
    const canais = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    const [r, g, b] = canais.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function razaoDeContraste(a: string, b: string): number {
    const [claro, escuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
    return (claro + 0.05) / (escuro + 0.05)
  }

  /** Valor hex de um token dentro do bloco de um seletor. */
  function token(seletor: string, nome: string): string {
    const corpo = corpoDaRegra(seletor)
    expect(corpo, `bloco de tokens ${seletor} não encontrado`).not.toBeNull()
    const valor = prop(corpo ?? '', nome)
    expect(valor, `${nome} não definido em ${seletor}`).toMatch(/^#[0-9a-f]{6}$/i)
    return valor as string
  }

  // AA para texto normal. Os consumidores do token são rótulo de botão (13px),
  // número de bolota (9–10.5px) e miolo de interruptor — o menor deles é texto
  // pequeno, então vale a régua mais dura, não a de texto grande (3:1).
  const AA_TEXTO_NORMAL = 4.5

  // `.gl` é o bloco do tema claro; o escuro é o [data-theme='dark'] (o
  // @media prefers-color-scheme repete os mesmos valores).
  const temas: [string, string][] = [
    ['claro', '.gl'],
    ['escuro', ".gl[data-theme='dark']"],
  ]

  for (const [nome, seletor] of temas) {
    it(`no tema ${nome}, --gl-on-accent alcança ${AA_TEXTO_NORMAL}:1 sobre --gl-accent`, () => {
      const razao = razaoDeContraste(
        token(seletor, '--gl-on-accent'),
        token(seletor, '--gl-accent')
      )
      expect(razao).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL)
    })
  }

  // WCAG 1.4.11 (Non-text Contrast): componente de interface e gráfico que
  // CARREGA INFORMAÇÃO — bolota de status, trilho de progresso, borda de campo
  // em foco — tem piso 3:1, não 4.5:1: não há texto para ler ali. Os 4.5:1
  // acima continuam valendo para o que é texto de verdade.
  const AA_NAO_TEXTO = 3

  // As três superfícies em que qualquer coisa do painel pode pousar. Medir só
  // contra `--gl-surface` (#ffffff no claro) dá o resultado mais generoso dos
  // três e esconde o pior caso, que é `--gl-surface-2`.
  const SUPERFICIES = ['--gl-canvas', '--gl-surface', '--gl-surface-2']

  it('a tinta de cima do accent INVERTE por tema — decisão D63, não descuido', () => {
    // Os dois temas passam a ter valores DIFERENTES de --gl-on-accent e isso é
    // o certo: no claro o accent é verde ESCURO, então em cima dele vai tinta
    // CLARA; no escuro o accent é verde CLARO, então vai tinta ESCURA. Um
    // "vamos unificar para ficar consistente" quebra um dos dois — este teste
    // é quem impede. A asserção é sobre a RELAÇÃO (mais claro/mais escuro que
    // o próprio accent), não sobre o hex, para não travar a paleta em um tom.
    const claro = { on: token('.gl', '--gl-on-accent'), acc: token('.gl', '--gl-accent') }
    const escuro = {
      on: token(".gl[data-theme='dark']", '--gl-on-accent'),
      acc: token(".gl[data-theme='dark']", '--gl-accent'),
    }
    expect(claro.on).not.toBe(escuro.on)
    expect(luminancia(claro.on)).toBeGreaterThan(luminancia(claro.acc))
    expect(luminancia(escuro.on)).toBeLessThan(luminancia(escuro.acc))
  })

  for (const [nome, seletor] of temas) {
    it(`no tema ${nome}, --gl-accent serve de TEXTO sobre qualquer superfície`, () => {
      // --gl-accent não é só fundo: é `color` direto em StepDiagnosis.tsx e
      // StepSelectRepos.tsx, e vira `accentColor` de checkbox em StepTerms.tsx
      // e StepReady.tsx. Enquanto ele for tinta em algum lugar, vale a régua
      // de texto — a de 3:1 valeria se fosse só gráfico.
      for (const s of SUPERFICIES) {
        expect(
          razaoDeContraste(token(seletor, '--gl-accent'), token(seletor, s)),
          `--gl-accent sobre ${s} no tema ${nome}`
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL)
      }
    })

    it(`no tema ${nome}, --gl-accent-ink serve de TEXTO sobre qualquer superfície`, () => {
      // O derivado carrega 21 declarações de `color` no CSS e mais 23 em JSX
      // (rótulos, ícones, o "score" do diagnóstico). Ele tem que acompanhar o
      // accent: se o accent escurece e o ink fica onde estava, os dois papéis
      // colapsam num tom só e o anel de foco some de cima do botão primário.
      for (const s of SUPERFICIES) {
        expect(
          razaoDeContraste(token(seletor, '--gl-accent-ink'), token(seletor, s)),
          `--gl-accent-ink sobre ${s} no tema ${nome}`
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL)
      }
    })

    it(`no tema ${nome}, accent e accent-ink continuam sendo dois tons distintos`, () => {
      // `.gl :focus-visible` desenha o anel com --gl-accent-ink e `.wz-btn-primary`
      // pinta o fundo com --gl-accent. Se os dois valores empatarem, o anel de
      // foco do botão primário fica invisível — regressão de teclado que
      // nenhuma medição de texto pegaria.
      expect(token(seletor, '--gl-accent-ink')).not.toBe(token(seletor, '--gl-accent'))
    })

    it(`no tema ${nome}, o accent é visível como gráfico sem texto (WCAG 1.4.11)`, () => {
      // Bolota .gl-dot/.pn-live (6–8px), preenchimento .wz-progress-fill e
      // .pn-bar i, marcador .pn-track i.done: nenhum tem texto dentro, mas
      // todos informam estado. Piso 3:1 contra a superfície de trás.
      for (const s of SUPERFICIES) {
        expect(
          razaoDeContraste(token(seletor, '--gl-accent'), token(seletor, s)),
          `gráfico --gl-accent sobre ${s} no tema ${nome}`
        ).toBeGreaterThanOrEqual(AA_NAO_TEXTO)
      }
    })
  }

  it('--gl-accent-ink é legível sobre a lavagem --gl-accent-soft', () => {
    // O par mais escondido do arquivo, e o que eu quase deixei passar. Sete
    // regras pintam `background: var(--gl-accent-soft)` e `color:
    // var(--gl-accent-ink)` juntas (.gl-role, .wz-diag-score, .pn-verdict.ok,
    // .pn-tag.p2, .pn-tag.on, .pn-nav[aria-current], .pn-answered). Como
    // --gl-accent-soft é rgba() com 12–14% de alfa, o fundo REAL é a lavagem
    // achatada sobre a superfície de trás — e o pior caso é --gl-surface-2,
    // não --gl-surface. Medindo contra o branco dava 4.75:1 e eu teria dito
    // "passa"; contra --gl-surface-2 dava 4.34:1 e REPROVAVA. É a mesma
    // armadilha de olhar em vez de medir, uma camada mais fundo.
    const achata = (rgba: string, fundo: string) => {
      const m = rgba.match(/rgba?\(([^)]+)\)/)
      expect(m, `--gl-accent-soft não é uma cor rgba(): ${rgba}`).not.toBeNull()
      const [r, g, b, alfa = '1'] = m![1].split(',').map((x) => x.trim())
      const base = [0, 2, 4].map((i) => parseInt(fundo.replace('#', '').slice(i, i + 2), 16))
      const mistura = [r, g, b].map((c, i) =>
        Math.round(parseFloat(c) * parseFloat(alfa) + base[i] * (1 - parseFloat(alfa)))
      )
      return '#' + mistura.map((c) => c.toString(16).padStart(2, '0')).join('')
    }
    for (const [nome, seletor] of temas) {
      const ink = token(seletor, '--gl-accent-ink')
      const soft = prop(corpoDaRegra(seletor) ?? '', '--gl-accent-soft') ?? ''
      for (const s of SUPERFICIES) {
        const fundoReal = achata(soft, token(seletor, s))
        expect(
          razaoDeContraste(ink, fundoReal),
          `--gl-accent-ink sobre --gl-accent-soft achatado em ${s} (${fundoReal}) no tema ${nome}`
        ).toBeGreaterThanOrEqual(AA_TEXTO_NORMAL)
      }
    }
  })

  // Um literal só é "chumbado" DEPOIS de tirar os `var()`: `var(--gl-danger,
  // #c0392b)` é token com fallback, degrada sozinho e é uso legítimo — o resto
  // do arquivo já faz essa mesma distinção. Sem tirar, a guarda acusaria
  // TelaRegras.tsx:155, que está correto, e viraria ruído até alguém desligá-la.
  const semVar = (valor: string) => {
    let anterior: string
    let atual = valor
    do {
      anterior = atual
      atual = atual.replace(/var\([^()]*\)/g, '')
    } while (atual !== anterior)
    return atual
  }
  // As 148 cores nomeadas do CSS Color Module Level 4 (as 147 do X11 mais
  // `rebeccapurple`). É a lista REAL, não "as que eu lembrei": a versão com
  // cinco nomes deixou `crimson`, `navy` e `ivory` entrarem chumbadas por cima
  // de var(--gl-accent) com a suíte fechando verde. `transparent` e
  // `currentColor` ficam DE FORA de propósito — são palavras-chave do CSS, não
  // tinta escolhida à mão, e acusá-las seria falso-positivo.
  const CORES_NOMEADAS = `
  aliceblue antiquewhite aqua aquamarine azure beige
  bisque black blanchedalmond blue blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue
  cornsilk crimson cyan darkblue darkcyan darkgoldenrod
  darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
  darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray
  green greenyellow grey honeydew hotpink indianred
  indigo ivory khaki lavender lavenderblush lawngreen
  lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray
  lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
  lightslategray lightslategrey lightsteelblue lightyellow lime limegreen
  linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
  midnightblue mintcream mistyrose moccasin navajowhite navy
  oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple rebeccapurple
  red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan
  teal thistle tomato turquoise violet wheat
  white whitesmoke yellow yellowgreen
`
    .trim()
    .split(/\s+/)
  const NOME_DE_COR = new RegExp(`\\b(${CORES_NOMEADAS.join('|')})\\b`, 'i')

  // Notação funcional de cor. O `\d` obrigatório dentro dos parênteses NÃO é
  // capricho: `rgb(var(--gl-accent-rgb))` é token embrulhado e uso legítimo, e
  // depois do `semVar` sobra `rgb()` — sem dígito, não acusa. Com canal
  // literal (`rgb(255,255,255)`) sobra o número e acusa.
  const FUNCAO_DE_COR = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^)]*\d/i

  const ehChumbada = (cor: string | null) => {
    if (cor === null) return false
    const limpo = semVar(cor)
    return /#[0-9a-f]{3,8}\b/i.test(limpo) || FUNCAO_DE_COR.test(limpo) || NOME_DE_COR.test(limpo)
  }

  /**
   * O valor deste fundo vem de um token `--gl-*`? Vale em QUALQUER posição do
   * valor. Exigir o `var()` colado no `:` — como fazia o lado CSS — deixava 10
   * regras reais fora do alcance: `color-mix(in srgb, var(--gl-sev) 13%, …)` e
   * `radial-gradient(…, var(--gl-accent-soft), …)` pintam a MESMA tinta de
   * fundo e escondem o MESMO defeito. O `[,)]` no fim aceita as duas formas do
   * token, com e sem fallback.
   */
  const ehFundoTokenizado = (valor: string | null) =>
    valor !== null && /var\(\s*--gl-[a-z0-9-]+\s*[,)]/.test(valor)

  // O fundo pode chegar por três propriedades, e `background-image` sozinho
  // (sem `background`) pinta tanto quanto as outras duas.
  const PROPS_FUNDO_CSS = ['background', 'background-color', 'background-image']
  const PROPS_FUNDO_JSX = ['background', 'backgroundColor', 'backgroundImage']

  /** Regras do globals.css cujo fundo é tokenizado — o universo que a guarda vigia. */
  function regrasCssComFundoTokenizado(): { sel: string; corpo: string }[] {
    return todasAsRegras()
      .filter((r) => !r.sel.startsWith('@'))
      .filter((r) => PROPS_FUNDO_CSS.some((p) => ehFundoTokenizado(prop(r.corpo, p))))
  }

  /** Estilos inline cujo fundo é tokenizado — o mesmo universo, do lado do JSX. */
  function estilosInlineComFundoTokenizado(): { arquivo: string; linha: number; bloco: string }[] {
    return todosOsEstilosInline().filter((b) =>
      PROPS_FUNDO_JSX.some((p) => ehFundoTokenizado(valorInline(b.bloco, p)))
    )
  }

  /** Todo lugar, CSS ou JSX, que pinta cor literal sobre um fundo `--gl-*`. */
  function coresChumbadasSobreFundoToken(): [string, string | null][] {
    const doCss = regrasCssComFundoTokenizado()
      .map((r) => [`globals.css → ${r.sel}`, prop(r.corpo, 'color')] as [string, string | null])
      .filter(([, cor]) => ehChumbada(cor))
    const doJsx = estilosInlineComFundoTokenizado()
      .map(
        (b) => [`${b.arquivo}:${b.linha}`, valorInline(b.bloco, 'color')] as [string, string | null]
      )
      .filter(([, cor]) => ehChumbada(cor))
    return [...doCss, ...doJsx]
  }

  // Dívida que JÁ existia antes desta tarefa e que o dono mandou não mexer
  // agora. Fica listada aqui, com a conta, em vez de a guarda ser estreitada
  // para fingir que não vê: `.gl-sev` pinta `color: #fff` sobre --gl-sev e dá
  // 3.91:1 no claro (#e5484d) e 2.94:1 no escuro (#ff6166) — os dois REPROVAM
  // AA. O conserto é o mesmo padrão das outras quatro (um token --gl-on-sev,
  // tinta escura: #08090b dá 5.09:1 e 6.79:1), e é tarefa própria.
  const DIVIDA_CONHECIDA = ['globals.css → .gl-sev']

  it('nenhuma cor chumbada em cima de fundo tokenizado — no CSS E no JSX', () => {
    // A causa raiz de o botão primário do wizard reprovar desde sempre não foi
    // "o verde estava claro demais": foi `color: #fff` CHUMBADO na regra, fora
    // do alcance de qualquer token. Enquanto existir literal ali, trocar o
    // token não conserta e a próxima mudança de paleta reabre o buraco.
    //
    // A PRIMEIRA versão desta guarda só lia o globals.css, e por isso deixou
    // passar a QUARTA instância do mesmo padrão — o badge "Recomendado" do
    // plano Pro, que mora em estilo inline num .tsx (StepPlanSelection). Um
    // guarda que cobre um arquivo e ignora o resto do front dá a sensação de
    // proteção sem a proteção: o defeito voltou por onde ela não olhava.
    //
    // A régua é LARGA de propósito — qualquer `--gl-*` de fundo, não só o
    // accent. Medi antes de escolher a largura: o front tem 30 blocos de
    // estilo inline com fundo `var(--gl-*)`, 13 declaram `color` junto e 12 já
    // usavam token. A regra larga tinha UM infrator e zero falso-positivo.
    const novas = coresChumbadasSobreFundoToken().filter(
      ([onde]) => !DIVIDA_CONHECIDA.includes(onde)
    )
    expect(novas).toEqual([])
  })

  it('a dívida conhecida ainda é dívida — a lista não pode ficar velha', () => {
    // Uma lista de exceção sem esta asserção apodrece: alguém conserta o
    // .gl-sev, a entrada continua lá e passa a esconder a PRÓXIMA instância que
    // aparecer com o mesmo nome. Aqui a exceção só sobrevive enquanto o defeito
    // que ela descreve existir de fato.
    const detectadas = coresChumbadasSobreFundoToken().map(([onde]) => onde)
    for (const divida of DIVIDA_CONHECIDA) {
      expect(
        detectadas,
        `${divida} não é mais um problema — tire da lista DIVIDA_CONHECIDA`
      ).toContain(divida)
    }
  })

  it('a guarda contra cor chumbada não é teatro', () => {
    // Guarda da guarda, mesma ideia do `pn-btn`/`pn-b` da varredura acima. Se o
    // leitor de estilo inline quebrar e passar a devolver zero blocos, o teste
    // de cima fica VERDE para sempre sem conferir nada — que é exatamente o
    // modo de falha que deixou a quarta instância entrar.
    const blocos = todosOsEstilosInline()
    expect(blocos.length).toBeGreaterThan(20)

    // Caso negativo REAL: os dois interruptores inline do painel pintam o fundo
    // com var(--gl-accent) e nunca chumbaram cor. Têm que seguir invisíveis.
    const interruptores = blocos.filter(
      (b) =>
        /Tela(Config|Regras)\.tsx$/.test(b.arquivo) &&
        /var\(--gl-accent\)/.test(valorInline(b.bloco, 'background') ?? '')
    )
    expect(interruptores.length).toBe(2)
    expect(interruptores.filter((b) => ehChumbada(valorInline(b.bloco, 'color')))).toEqual([])

    // O detector separa literal de token, inclusive token COM fallback.
    expect(ehChumbada("'#08090b'")).toBe(true)
    expect(ehChumbada("'#fff'")).toBe(true)
    expect(ehChumbada("'var(--gl-on-accent)'")).toBe(false)
    expect(ehChumbada("'var(--gl-danger, #c0392b)'")).toBe(false)

    // E o leitor extrai o valor certo com ternário e com parênteses no meio,
    // que é a forma real dos estilos inline deste projeto.
    const amostra =
      "background: on ? 'var(--gl-accent)' : 'var(--gl-surface-2)', color: '#fff', boxShadow: '0 0 0 3px rgba(1, 2, 3, 0.4)'"
    expect(valorInline(amostra, 'background')).toBe(
      "on ? 'var(--gl-accent)' : 'var(--gl-surface-2)'"
    )
    expect(valorInline(amostra, 'color')).toBe("'#fff'")
    expect(valorInline(amostra, 'boxShadow')).toBe("'0 0 0 3px rgba(1, 2, 3, 0.4)'")
  })

  it('a guarda enxerga fundo tokenizado onde o var() NÃO está colado no valor', () => {
    // BURACO 1, provado pelo QA: o filtro do lado CSS exigia `background:
    // var(--gl-x)` colado. Fundo escrito como `color-mix(...)` ou como
    // gradiente pinta a MESMA tinta e esconde o MESMO defeito, mas ficava fora
    // do alcance — o QA pôs `color: #fff` em `.gl .pn-tag.p0`, que é
    // `background: color-mix(in srgb, var(--gl-sev) 13%, transparent)`, a mesma
    // classe de defeito do `.gl-sev`, e a suíte fechou 27/27 VERDE.
    expect(ehFundoTokenizado('color-mix(in srgb, var(--gl-sev) 13%, transparent)')).toBe(true)
    expect(
      ehFundoTokenizado(
        'radial-gradient(60% 50% at 50% 0%, var(--gl-accent-soft), transparent 70%)'
      )
    ).toBe(true)
    expect(ehFundoTokenizado('var(--gl-surface-2)')).toBe(true)
    expect(ehFundoTokenizado('var(--gl-danger, #c0392b)')).toBe(true)
    // E não pode virar peneira: fundo sem token nenhum segue fora do universo.
    expect(ehFundoTokenizado('#0a7a4c')).toBe(false)
    expect(ehFundoTokenizado('var(--wz-outra-familia)')).toBe(false)
    expect(ehFundoTokenizado(null)).toBe(false)
  })

  it('as regras reais escritas com color-mix/gradiente estão DENTRO do universo vigiado', () => {
    // Asserção sobre RESULTADO, não sobre a regex: são regras que existem hoje
    // no globals.css. Se alguma sair do universo, a guarda voltou a ser cega
    // justamente onde o QA furou.
    const vigiadas = regrasCssComFundoTokenizado().map((r) => r.sel)
    expect(vigiadas).toContain('.gl .pn-tag.p0') // color-mix sobre --gl-sev
    expect(vigiadas).toContain('.gl-viz::before') // radial-gradient sobre --gl-accent-soft
    expect(vigiadas).toContain('.gl .pn-kpi.act') // color-mix com DOIS tokens
  })

  it('o detector de cor chumbada conhece TODAS as sintaxes de cor do CSS', () => {
    // BURACO 2, provado pelo QA: `ehChumbada` só conhecia `#hex` e cinco nomes.
    // Com um .tsx real sobre `var(--gl-accent)`, TODAS estas passaram batido e
    // a suíte fechou 27/27 verde.
    for (const cor of [
      'rgb(255,255,255)',
      'rgba(255,255,255,0.9)',
      'hsl(0 0% 100%)',
      'hsla(0, 0%, 100%, 0.9)',
      'oklch(0.9 0 0)',
      'lab(90% 0 0)',
      'lch(90% 0 0)',
      'hwb(0 100% 0%)',
      'color(display-p3 1 1 1)',
      'crimson',
      'navy',
      'ivory',
    ]) {
      expect(ehChumbada(`'${cor}'`), `${cor} deveria ser acusada`).toBe(true)
    }
  })

  it('o detector conhece a lista REAL de cores nomeadas, não uma lembrada de cabeça', () => {
    // Amostra varrendo o alfabeto inteiro da lista do CSS Color Level 4. Uma
    // lista "das dez que eu lembrei" reprova aqui — que é o ponto.
    // A contagem é parte da asserção: a lista canônica tem 148 nomes (os 147 do
    // X11 mais `rebeccapurple`). Se alguém podar a lista para calar a guarda,
    // este número denuncia antes de a amostra abaixo ter chance de passar.
    expect(CORES_NOMEADAS.length).toBe(148)
    expect(new Set(CORES_NOMEADAS).size).toBe(148)
    for (const nome of [
      'aliceblue',
      'burlywood',
      'chartreuse',
      'darkgoldenrod',
      'firebrick',
      'gainsboro',
      'honeydew',
      'khaki',
      'lemonchiffon',
      'mediumvioletred',
      'navajowhite',
      'olivedrab',
      'papayawhip',
      'rebeccapurple',
      'sandybrown',
      'thistle',
      'wheat',
      'yellowgreen',
    ]) {
      expect(ehChumbada(`'${nome}'`), `${nome} é cor nomeada do CSS`).toBe(true)
    }
  })

  it('o detector NÃO acusa token nem palavra-chave que não é tinta escolhida à mão', () => {
    // Falso-positivo aqui é pior que buraco: uma guarda que grita em código
    // correto vira ruído e alguém a desliga. `transparent`, `inherit`,
    // `currentColor` e `none` são palavras-chave, não cor chumbada; e
    // `rgb(var(--x))` é token embrulhado — depois do semVar sobra `rgb()`.
    for (const valor of [
      'transparent',
      'inherit',
      'currentColor',
      'none',
      'unset',
      'var(--gl-on-accent)',
      'var(--gl-danger, #c0392b)',
      'rgb(var(--gl-accent-rgb))',
      "on ? 'var(--gl-accent)' : 'var(--gl-surface-2)'",
    ]) {
      expect(ehChumbada(`'${valor}'`), `${valor} é uso legítimo`).toBe(false)
    }
  })

  it('--gl-spot copia o token CERTO de cada tema', () => {
    // --gl-spot é o halo radial do fundo e nasceu como cópia LITERAL em rgba()
    // de outro token — e não é o mesmo token nos dois temas: no claro copia o
    // --gl-accent, no escuro copia o --gl-accent-ink. (Eu tinha assumido accent
    // nos dois; medi e era mentira. A asserção é a que a medição sustenta.)
    //
    // A primeira versão desta guarda aceitava bater com QUALQUER um dos dois,
    // por união — o que passaria calado se os papéis se invertessem por engano
    // numa refatoração. Agora cada tema cobra o seu, nomeado.
    const donoDoHalo: Record<string, string> = {
      claro: '--gl-accent',
      escuro: '--gl-accent-ink',
    }
    for (const [nome, seletor] of temas) {
      const esperado = token(seletor, donoDoHalo[nome])
      const rgbEsperado = [0, 2, 4].map((i) =>
        parseInt(esperado.replace('#', '').slice(i, i + 2), 16)
      )
      const spot = prop(corpoDaRegra(seletor) ?? '', '--gl-spot')
      const rgbDoSpot = (spot ?? '')
        .match(/rgba?\(([^)]+)\)/)?.[1]
        .split(',')
        .slice(0, 3)
        .map((n) => parseInt(n.trim(), 10))
      expect(
        rgbDoSpot,
        `--gl-spot no tema ${nome} vale ${spot} e deveria copiar ${donoDoHalo[nome]} (${esperado})`
      ).toEqual(rgbEsperado)
    }
  })

  it('a própria conta está certa (pares de referência do WCAG)', () => {
    // Sem isto, um erro na fórmula deixaria as duas asserções acima passando
    // por engano. Preto sobre branco é 21:1 e cinza igual a si mesmo é 1:1 —
    // os dois extremos fechados da escala.
    expect(razaoDeContraste('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(razaoDeContraste('#808080', '#808080')).toBeCloseTo(1, 5)
  })
})
