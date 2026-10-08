// Um GitHub de mentira COM ESTADO para a aplicação das melhorias de segurança:
// guarda as configurações do repositório, os ramos, os arquivos e os pull
// requests, responde como a API respondeu quando foi lida (204 sem corpo,
// 404 "Not Found", 403 "Upgrade to GitHub Pro"...) e REGISTRA toda requisição
// (método, caminho, corpo, credencial). Os testes conferem o registro: o que
// não pode escrever não tem nenhuma requisição de escrita nele.
//
// Nada daqui é código de produção: fica em `src/test/`.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RequisicaoRegistrada {
  metodo: string
  /** Caminho com a query, sem o host. */
  caminho: string
  corpo: unknown
  autorizacao: string | null
  /** Instante (ms) em que a requisição chegou, no relógio do teste. */
  em: number
}

export interface RespostaForcada {
  status: number
  mensagem: string
  cabecalhos?: Record<string, string>
}

export interface ConfiguracaoDoRepositorioFalso {
  privado?: boolean
  branchPadrao?: string
  /** A credencial vê `permissions.admin` e `security_and_analysis` (padrão: sim). */
  admin?: boolean
  segredos?: 'enabled' | 'disabled'
  bloqueioDePush?: 'enabled' | 'disabled'
  /** Só repositório privado: GitHub Advanced Security. */
  advancedSecurity?: 'enabled' | 'disabled'
  alertasDeDependencias?: boolean
  atualizacoesDeSeguranca?: boolean
  varreduraDeCodigo?: 'configured' | 'not-configured' | 'indisponivel'
  linguagens?: Record<string, number>
  permissaoDoWorkflow?: 'read' | 'write' | 'indisponivel'
  podeAprovarPrs?: boolean
  /** Caminho → conteúdo, na branch padrão. */
  arquivos?: Record<string, string>
  /** Respostas forçadas por "MÉTODO /rota-relativa-ao-repositório" (sem query). */
  forcar?: Record<string, RespostaForcada>
  /** A credencial só é aceita nas rotas de administração se for esta. */
  tokenDeAdmin?: string
  /** Toda rota responde 403 de limite de taxa. */
  limiteDeTaxa?: boolean
}

interface Ramo {
  sha: string
  arquivos: Record<string, string>
}

export interface PullFalso {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  title: string
  body: string
  head: string
  base: string
  /** Quem abriu: o App do produto, por padrão. */
  autor: { login: string; type: string }
}

export function shaDoTexto(texto: string): string {
  return createHash('sha1').update(texto).digest('hex')
}

const DOC = 'https://docs.github.com/rest'

interface Resposta {
  status: number
  corpo: unknown
  cabecalhos?: Record<string, string>
}

const json = (status: number, corpo: unknown, cabecalhos?: Record<string, string>): Resposta => ({
  status,
  corpo,
  ...(cabecalhos ? { cabecalhos } : {}),
})
const semCorpo = (status = 204): Resposta => ({ status, corpo: null })
const naoEncontrado = (mensagem = 'Not Found'): Resposta =>
  json(404, { message: mensagem, documentation_url: DOC, status: '404' })

export class GitHubDeMelhoriasFalso {
  readonly registro: RequisicaoRegistrada[] = []
  readonly pulls: PullFalso[] = []
  private readonly ramos = new Map<string, Ramo>()
  private relogio: () => number = () => Date.now()

  constructor(
    readonly repositorio: string,
    readonly config: ConfiguracaoDoRepositorioFalso = {}
  ) {
    const padrao = config.branchPadrao ?? 'main'
    this.ramos.set(padrao, {
      sha: shaDoTexto(`${repositorio}@${padrao}@0`),
      arquivos: { ...(config.arquivos ?? {}) },
    })
  }

  usarRelogio(relogio: () => number): void {
    this.relogio = relogio
  }

  get branchPadrao(): string {
    return this.config.branchPadrao ?? 'main'
  }

  /** O que está na branch padrão agora. */
  arquivoNaPadrao(caminho: string): string | undefined {
    return this.ramos.get(this.branchPadrao)?.arquivos[caminho]
  }

  arquivoNoRamo(ramo: string, caminho: string): string | undefined {
    return this.ramos.get(ramo)?.arquivos[caminho]
  }

  /** Muda o texto de um arquivo na branch padrão, como se alguém tivesse commitado. */
  definirArquivoNaPadrao(caminho: string, texto: string): void {
    const padrao = this.ramos.get(this.branchPadrao)
    if (!padrao) throw new Error('branch padrão ausente')
    padrao.arquivos[caminho] = texto
    padrao.sha = shaDoTexto(`${padrao.sha}+${caminho}`)
  }

  temRamo(ramo: string): boolean {
    return this.ramos.has(ramo)
  }

  /** Só as requisições que escrevem. */
  escritas(): RequisicaoRegistrada[] {
    return this.registro.filter((r) => !['GET', 'HEAD'].includes(r.metodo))
  }

  /** Simula o dono mesclando o PR: o ramo vira a branch padrão. */
  mesclarPull(numero: number): void {
    const pull = this.pulls.find((p) => p.number === numero)
    if (!pull) throw new Error(`PR ${numero} não existe`)
    const ramo = this.ramos.get(pull.head)
    const padrao = this.ramos.get(this.branchPadrao)
    if (!ramo || !padrao) throw new Error('ramo ausente')
    padrao.arquivos = { ...ramo.arquivos }
    pull.state = 'closed'
    pull.merged = true
  }

  fecharPullSemMesclar(numero: number): void {
    const pull = this.pulls.find((p) => p.number === numero)
    if (!pull) throw new Error(`PR ${numero} não existe`)
    pull.state = 'closed'
  }

  // ------------------------------------------------------------------ atendimento

  atender(
    metodo: string,
    caminhoComQuery: string,
    corpo: unknown,
    autorizacao: string | null
  ): Resposta {
    this.registro.push({
      metodo,
      caminho: caminhoComQuery,
      corpo,
      autorizacao,
      em: this.relogio(),
    })
    const url = new URL(caminhoComQuery, 'https://api.github.com')
    const achou = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!achou || `${achou[1]}/${achou[2]}`.toLowerCase() !== this.repositorio.toLowerCase()) {
      return naoEncontrado()
    }
    const rota = achou[3] ?? ''
    if (this.config.limiteDeTaxa) {
      return json(
        403,
        { message: 'API rate limit exceeded', documentation_url: `${DOC}/overview/rate-limits` },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        }
      )
    }
    const forcada = this.config.forcar?.[`${metodo} ${rota}`]
    if (forcada) {
      return json(
        forcada.status,
        { message: forcada.mensagem, documentation_url: DOC, status: String(forcada.status) },
        forcada.cabecalhos
      )
    }
    const ehAdmin = this.config.admin !== false
    const tokenOk =
      this.config.tokenDeAdmin === undefined || autorizacao === `Bearer ${this.config.tokenDeAdmin}`
    const podeAdministrar = ehAdmin && tokenOk
    const recusaAdmin = (): Resposta =>
      json(403, { message: 'Resource not accessible by integration', status: '403' })

    const c = this.config
    const privado = c.privado === true

    if (rota === '' && metodo === 'GET') return json(200, this.corpoDoRepositorio(podeAdministrar))
    if (rota === '' && metodo === 'PATCH') {
      if (!podeAdministrar) return recusaAdmin()
      const sa = (corpo as { security_and_analysis?: Record<string, { status?: string }> } | null)
        ?.security_and_analysis
      if (privado && c.advancedSecurity !== 'enabled') {
        return json(422, {
          message: 'Advanced security must be enabled for this repository to use secret scanning.',
          status: '422',
        })
      }
      if (sa?.['secret_scanning']?.status) {
        c.segredos = sa['secret_scanning'].status === 'enabled' ? 'enabled' : 'disabled'
      }
      if (sa?.['secret_scanning_push_protection']?.status) {
        c.bloqueioDePush =
          sa['secret_scanning_push_protection'].status === 'enabled' ? 'enabled' : 'disabled'
      }
      return json(200, this.corpoDoRepositorio(true))
    }

    if (rota === '/vulnerability-alerts') {
      if (!podeAdministrar) return recusaAdmin()
      if (metodo === 'GET') {
        return c.alertasDeDependencias
          ? semCorpo()
          : naoEncontrado('Vulnerability alerts are disabled.')
      }
      if (metodo === 'PUT') {
        c.alertasDeDependencias = true
        return semCorpo()
      }
      if (metodo === 'DELETE') {
        c.alertasDeDependencias = false
        c.atualizacoesDeSeguranca = false
        return semCorpo()
      }
    }
    if (rota === '/automated-security-fixes') {
      if (!podeAdministrar) return recusaAdmin()
      if (metodo === 'GET') {
        return json(200, { enabled: c.atualizacoesDeSeguranca === true, paused: false })
      }
      if (metodo === 'PUT') {
        if (!c.alertasDeDependencias) {
          return json(422, { message: 'Vulnerability alerts must be enabled.', status: '422' })
        }
        c.atualizacoesDeSeguranca = true
        return semCorpo()
      }
      if (metodo === 'DELETE') {
        c.atualizacoesDeSeguranca = false
        return semCorpo()
      }
    }
    if (rota === '/code-scanning/default-setup') {
      if (!podeAdministrar) return recusaAdmin()
      if (c.varreduraDeCodigo === 'indisponivel' || (privado && c.advancedSecurity !== 'enabled')) {
        return json(403, {
          message: 'Advanced Security must be enabled for this repository to use code scanning.',
          status: '403',
        })
      }
      if (metodo === 'GET') {
        return json(200, {
          state: c.varreduraDeCodigo ?? 'not-configured',
          languages: [],
          query_suite: 'default',
          updated_at: null,
        })
      }
      if (metodo === 'PATCH') {
        const estado = (corpo as { state?: string } | null)?.state
        if (estado !== 'configured' && estado !== 'not-configured') {
          return json(422, { message: 'Invalid state', status: '422' })
        }
        c.varreduraDeCodigo = estado
        return json(202, {
          run_id: 1,
          run_url: `https://api.github.com/repos/${this.repositorio}/actions/runs/1`,
        })
      }
    }
    if (rota === '/languages' && metodo === 'GET') {
      return json(200, c.linguagens ?? {})
    }
    if (rota === '/actions/permissions/workflow') {
      if (c.permissaoDoWorkflow === 'indisponivel' || !podeAdministrar) return recusaAdmin()
      if (metodo === 'GET') {
        return json(200, {
          default_workflow_permissions: c.permissaoDoWorkflow ?? 'read',
          can_approve_pull_request_reviews: c.podeAprovarPrs === true,
        })
      }
      if (metodo === 'PUT') {
        const dados = corpo as {
          default_workflow_permissions?: 'read' | 'write'
          can_approve_pull_request_reviews?: boolean
        } | null
        if (dados?.default_workflow_permissions) {
          c.permissaoDoWorkflow = dados.default_workflow_permissions
        }
        if (typeof dados?.can_approve_pull_request_reviews === 'boolean') {
          c.podeAprovarPrs = dados.can_approve_pull_request_reviews
        }
        return semCorpo()
      }
    }

    const padrao = this.ramos.get(this.branchPadrao)
    if (!padrao) return naoEncontrado()

    if (rota === '/contents/.github/workflows' && metodo === 'GET') {
      const ref = url.searchParams.get('ref') ?? this.branchPadrao
      const ramo = this.ramos.get(ref)
      if (!ramo) return naoEncontrado('No commit found for the ref ' + ref)
      const lista = Object.keys(ramo.arquivos).filter((p) => /^\.github\/workflows\/[^/]+$/.test(p))
      if (lista.length === 0) return naoEncontrado()
      return json(
        200,
        lista.map((path) => ({
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: shaDoTexto(ramo.arquivos[path] ?? ''),
          download_url: `https://raw.githubusercontent.com/${this.repositorio}/${ref}/${path}`,
        }))
      )
    }
    const conteudo = /^\/contents\/(.+)$/.exec(rota)
    if (conteudo) {
      const caminho = decodeURIComponent(conteudo[1] ?? '')
      if (metodo === 'GET') {
        const ref = url.searchParams.get('ref') ?? this.branchPadrao
        const ramo = this.ramos.get(ref)
        const texto = ramo?.arquivos[caminho]
        if (texto === undefined) return naoEncontrado()
        return json(200, {
          type: 'file',
          encoding: 'base64',
          path: caminho,
          name: caminho.split('/').pop(),
          sha: shaDoTexto(texto),
          size: Buffer.byteLength(texto),
          content: Buffer.from(texto).toString('base64'),
        })
      }
      if (metodo === 'PUT' || metodo === 'DELETE') {
        const dados = corpo as {
          branch?: string
          content?: string
          sha?: string
          message?: string
        } | null
        const nomeDoRamo = dados?.branch ?? this.branchPadrao
        const ramo = this.ramos.get(nomeDoRamo)
        if (!ramo) return naoEncontrado('Branch not found')
        const atual = ramo.arquivos[caminho]
        if (metodo === 'PUT') {
          if (atual !== undefined && dados?.sha !== shaDoTexto(atual)) {
            return json(422, { message: `Invalid request. "sha" wasn't supplied.`, status: '422' })
          }
          if (atual === undefined && dados?.sha) {
            return json(422, { message: 'sha does not match', status: '422' })
          }
          ramo.arquivos[caminho] = Buffer.from(dados?.content ?? '', 'base64').toString('utf8')
        } else {
          if (atual === undefined) return naoEncontrado()
          if (dados?.sha !== shaDoTexto(atual)) {
            return json(409, { message: 'sha does not match', status: '409' })
          }
          delete ramo.arquivos[caminho]
        }
        ramo.sha = shaDoTexto(`${ramo.sha}+${caminho}+${metodo}`)
        return json(metodo === 'PUT' && atual === undefined ? 201 : 200, {
          content: metodo === 'PUT' ? { sha: shaDoTexto(ramo.arquivos[caminho] ?? '') } : null,
          commit: { sha: ramo.sha },
        })
      }
    }

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rota)
    if (ref && metodo === 'GET') {
      const ramo = this.ramos.get(decodeURIComponent(ref[1] ?? ''))
      if (!ramo) return naoEncontrado()
      return json(200, {
        ref: `refs/heads/${ref[1]}`,
        object: { type: 'commit', sha: ramo.sha },
      })
    }
    if (rota === '/git/refs' && metodo === 'POST') {
      const dados = corpo as { ref?: string; sha?: string } | null
      const nome = /^refs\/heads\/(.+)$/.exec(dados?.ref ?? '')?.[1]
      if (!nome) return json(422, { message: 'Reference invalid', status: '422' })
      if (this.ramos.has(nome)) {
        return json(422, { message: 'Reference already exists', status: '422' })
      }
      const origem = [...this.ramos.values()].find((r) => r.sha === dados?.sha)
      if (!origem) return json(422, { message: 'Object does not exist', status: '422' })
      this.ramos.set(nome, { sha: origem.sha, arquivos: { ...origem.arquivos } })
      return json(201, { ref: dados?.ref, object: { sha: origem.sha } })
    }
    const apagarRef = /^\/git\/refs\/heads\/(.+)$/.exec(rota)
    if (apagarRef && metodo === 'DELETE') {
      const nome = decodeURIComponent(apagarRef[1] ?? '')
      if (!this.ramos.has(nome))
        return json(422, { message: 'Reference does not exist', status: '422' })
      this.ramos.delete(nome)
      return semCorpo()
    }

    if (rota === '/pulls' && metodo === 'GET') {
      const head = url.searchParams.get('head') ?? ''
      const estado = url.searchParams.get('state') ?? 'open'
      const ramo = head.includes(':') ? head.split(':').slice(1).join(':') : head
      const lista = this.pulls.filter(
        (p) => (!head || p.head === ramo) && (estado === 'all' || p.state === estado)
      )
      return json(
        200,
        lista.map((p) => this.corpoDoPull(p))
      )
    }
    if (rota === '/pulls' && metodo === 'POST') {
      const dados = corpo as { title?: string; body?: string; head?: string; base?: string } | null
      if (!dados?.head || !dados.base || !this.ramos.has(dados.head)) {
        return json(422, { message: 'Validation Failed', status: '422' })
      }
      const pull: PullFalso = {
        number: this.pulls.length + 1,
        state: 'open',
        merged: false,
        title: dados.title ?? '',
        body: dados.body ?? '',
        head: dados.head,
        base: dados.base,
        autor: { login: 'gitorch-ai[bot]', type: 'Bot' },
      }
      this.pulls.push(pull)
      return json(201, this.corpoDoPull(pull))
    }
    const umPull = /^\/pulls\/(\d+)$/.exec(rota)
    if (umPull) {
      const pull = this.pulls.find((p) => p.number === Number(umPull[1]))
      if (!pull) return naoEncontrado()
      if (metodo === 'GET') return json(200, this.corpoDoPull(pull))
      if (metodo === 'PATCH') {
        const estado = (corpo as { state?: string } | null)?.state
        if (estado === 'closed') pull.state = 'closed'
        return json(200, this.corpoDoPull(pull))
      }
    }

    return naoEncontrado()
  }

  private corpoDoPull(p: PullFalso): Record<string, unknown> {
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      title: p.title,
      body: p.body,
      html_url: `https://github.com/${this.repositorio}/pull/${p.number}`,
      head: { ref: p.head },
      base: { ref: p.base },
      user: { login: p.autor.login, type: p.autor.type },
    }
  }

  private corpoDoRepositorio(admin: boolean): Record<string, unknown> {
    const c = this.config
    const privado = c.privado === true
    return {
      full_name: this.repositorio,
      private: privado,
      visibility: privado ? 'private' : 'public',
      default_branch: this.branchPadrao,
      ...(admin && c.admin !== false
        ? { permissions: { admin: true, push: true, pull: true } }
        : {}),
      ...(admin && c.admin !== false
        ? {
            security_and_analysis: {
              ...(privado
                ? { advanced_security: { status: c.advancedSecurity ?? 'disabled' } }
                : {}),
              secret_scanning: { status: c.segredos ?? 'disabled' },
              secret_scanning_push_protection: { status: c.bloqueioDePush ?? 'disabled' },
            },
          }
        : {}),
    }
  }

  // ------------------------------------------------------------------ entradas

  /** Como `fetch`, para os testes sem rede. */
  readonly fetchFalso = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const corpoTexto = typeof init?.body === 'string' ? init.body : null
    const resposta = this.atender(
      (init?.method ?? 'GET').toUpperCase(),
      `${url.pathname}${url.search}`,
      corpoTexto === null ? null : (JSON.parse(corpoTexto) as unknown),
      new Headers(init?.headers).get('authorization')
    )
    return new Response(resposta.corpo === null ? null : JSON.stringify(resposta.corpo), {
      status: resposta.status,
      headers: { 'content-type': 'application/json', ...(resposta.cabecalhos ?? {}) },
    })
  }) as typeof fetch

  /** Para ficar atrás de um servidor HTTP local (teste de integração). */
  async atenderHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pedacos: Buffer[] = []
    for await (const pedaco of req) pedacos.push(pedaco as Buffer)
    const texto = Buffer.concat(pedacos).toString('utf8')
    const resto = (req.url ?? '').replace(/^\/api/, '')
    const resposta = this.atender(
      (req.method ?? 'GET').toUpperCase(),
      resto,
      texto === '' ? null : (JSON.parse(texto) as unknown),
      (req.headers['authorization'] as string | undefined) ?? null
    )
    res.writeHead(resposta.status, {
      'content-type': 'application/json',
      ...(resposta.cabecalhos ?? {}),
    })
    res.end(resposta.corpo === null ? undefined : JSON.stringify(resposta.corpo))
  }
}
