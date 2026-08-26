import { describe, it, expect } from 'vitest'
import { TASK_LABEL } from './sm-delegation.js'
import {
  CHAVE_DO_PEDIDO_DE_AVISO,
  decidirPedirOAviso,
  corpoDoPedidoDeAviso,
  jaExisteOPedido,
} from './instalar-aviso-de-publicacao.js'

const BASE = {
  repositorio: 'loureng/patinhas-3d-crafts',
  projectId: 'proj_1',
  declarado: 'publica-em-vm-propria' as const,
  jaInstalado: false,
  marcaAnterior: null,
}

describe('decidirPedirOAviso — quando o produto pede o aviso ao CD do cliente', () => {
  it('projeto que publica em VM própria e nunca avisou: pede', () => {
    const d = decidirPedirOAviso(BASE)
    expect(d.abrir).toBe(true)
    if (!d.abrir) return
    expect(d.chave).toBe(CHAVE_DO_PEDIDO_DE_AVISO)
  })

  it('a tarefa nasce com a etiqueta que o Scrum Master procura — senão nunca chega ao dev', () => {
    const d = decidirPedirOAviso(BASE)
    expect(d.abrir).toBe(true)
    if (!d.abrir) return
    // `gitorch:task` é o filtro exato de sm-delegation.ts. Sem ela a issue
    // nasce órfã no repositório do cliente e, como o pedido é deduplicado, o
    // produto nunca mais tenta.
    expect(d.etiquetas).toContain(TASK_LABEL)
  })

  it('serviço externo que não registra no GitHub: pede também', () => {
    const d = decidirPedirOAviso({ ...BASE, declarado: 'publica-em-servico-externo' })
    expect(d.abrir).toBe(true)
  })

  it('projeto que publica por workflow do GitHub: NÃO pede — dali o produto já lê sozinho', () => {
    const d = decidirPedirOAviso({ ...BASE, declarado: 'publica-por-workflow' })
    expect(d.abrir).toBe(false)
  })

  it('projeto que publica na mão: NÃO pede — não existe CD para instalar nada', () => {
    const d = decidirPedirOAviso({ ...BASE, declarado: 'publica-manualmente' })
    expect(d.abrir).toBe(false)
  })

  it('dono que ainda não disse como publica: NÃO pede — primeiro se pergunta, nunca se adivinha', () => {
    const d = decidirPedirOAviso({ ...BASE, declarado: null })
    expect(d.abrir).toBe(false)
  })

  it('o aviso JÁ chegou uma vez: nunca mais pede — está instalado e funcionando', () => {
    const d = decidirPedirOAviso({ ...BASE, jaInstalado: true })
    expect(d.abrir).toBe(false)
  })

  it('já pedimos antes: não pede de novo — senão vira uma issue por tique no repo do cliente', () => {
    const d = decidirPedirOAviso({ ...BASE, marcaAnterior: CHAVE_DO_PEDIDO_DE_AVISO })
    expect(d.abrir).toBe(false)
  })

  it('marca de OUTRA coisa não conta como pedido feito', () => {
    const d = decidirPedirOAviso({ ...BASE, marcaAnterior: 'gitorch:conserto:publicacao:abc' })
    expect(d.abrir).toBe(true)
  })
})

describe('corpoDoPedidoDeAviso — o que o dev assíncrono recebe', () => {
  const corpo = corpoDoPedidoDeAviso({
    repositorio: 'loureng/patinhas-3d-crafts',
    projectId: 'proj_1',
    endereco: 'https://gitorch.exemplo',
  })

  it('diz exatamente onde a chamada entra e o que ela manda', () => {
    expect(corpo).toContain('/api/projects/proj_1/publicado')
    expect(corpo).toMatch(/commit/i)
  })

  it('manda guardar a chave como SEGREDO do repositório, nunca no arquivo', () => {
    expect(corpo).toMatch(/segredo/i)
    expect(corpo).toContain('GITORCH_API_KEY')
  })

  it('NUNCA carrega valor de chave nenhuma dentro', () => {
    expect(corpo).not.toMatch(/gitorch_[0-9a-f]{8}/)
  })

  it('diz para NÃO mascarar a falha do deploy, e mostra como', () => {
    expect(corpo).toMatch(/quando o deploy falhar/i)
    expect(corpo).toContain('sucesso')
    // O exemplo tem que mostrar o caminho da falha, não só o do sucesso.
    expect(corpo).toContain('exit 1')
  })

  it('ensina a guardar o segredo em CADA ambiente — não só no GitHub Actions', () => {
    // Os dois cenários que este pedido atende publicam FORA do GitHub: uma
    // instrução que só serve para Actions empurraria o dev a colar a chave no
    // script, que é exatamente o vazamento que a regra existe para impedir.
    expect(corpo).toMatch(/VM sua|systemd|cron/i)
    expect(corpo).toMatch(/Render|Vercel|painel do serviço/i)
    expect(corpo).toMatch(/nunca.*versionado|fora da árvore do repositório/i)
  })

  it('carrega a marca de deduplicação, para a mesma tarefa não nascer duas vezes', () => {
    expect(corpo).toContain(CHAVE_DO_PEDIDO_DE_AVISO)
  })
})

describe('jaExisteOPedido — a rede que a marca no banco não cobre', () => {
  it('reconhece a tarefa pelo marcador no corpo, mesmo sem marca no banco', () => {
    const corpo = corpoDoPedidoDeAviso({
      repositorio: 'acme/api',
      projectId: 'p1',
      endereco: 'https://gitorch.exemplo',
    })
    expect(jaExisteOPedido([{ body: corpo }])).toBe(true)
  })

  it('outras tarefas abertas no repositório do cliente não são confundidas', () => {
    expect(
      jaExisteOPedido([
        { body: 'consertar o botão de login' },
        { body: '<!-- gitorch:conserto:publicacao:abc123 -->' },
        { body: null },
        {},
      ])
    ).toBe(false)
  })

  it('quadro vazio: não existe pedido nenhum', () => {
    expect(jaExisteOPedido([])).toBe(false)
  })
})
