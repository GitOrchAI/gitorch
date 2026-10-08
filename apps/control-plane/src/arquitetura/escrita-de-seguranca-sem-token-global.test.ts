import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Nenhuma escrita do aplicador de segurança pode sair com o token global do
// produto (`GITORCH_GITHUB_TOKEN`): a configuração usa a credencial que provou
// administração, e o pull request usa só a instalação do App. A prova de
// comportamento está nos testes do tique; este lê o código e fecha a porta para
// um chamador novo trazer o token global de volta por um atalho.

const raizDoSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

const ARQUIVOS_DA_ESCRITA = [
  'services/aplicador-de-seguranca-dos-projetos.ts',
  'services/escritor-de-seguranca.ts',
  'services/executores-de-seguranca.ts',
  'services/aplicar-melhoria-de-seguranca.ts',
  'services/sondagem-de-seguranca.ts',
  'services/leitor-de-seguranca.ts',
  'services/melhorias-de-seguranca.ts',
  'services/interruptores-de-seguranca.ts',
  'services/workflows-de-seguranca.ts',
  'services/alternativa-gratuita-de-seguranca.ts',
]

/** O código sem as linhas de comentário. */
const semComentarios = (texto: string): string =>
  texto
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n')

describe('a escrita do aplicador de segurança nunca usa o token global do produto', () => {
  it.each(ARQUIVOS_DA_ESCRITA)('%s não lê GITORCH_GITHUB_TOKEN', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raizDoSrc, arquivo), 'utf8'))
    expect(codigo).not.toContain('GITORCH_GITHUB_TOKEN')
  })

  it('no tique, a aplicação recebe as credenciais de ESCRITA (sem o token global), não as da leitura da nota', () => {
    const scheduler = readFileSync(join(raizDoSrc, 'plugins', 'scheduler.ts'), 'utf8')
    const chamada = scheduler.slice(
      scheduler.indexOf('await aplicarMelhoriasDeSegurancaDosProjetos({'),
      scheduler.indexOf(
        'fetchDeLeitura:',
        scheduler.indexOf('aplicarMelhoriasDeSegurancaDosProjetos({')
      )
    )
    expect(chamada).toContain('credenciais: credenciaisDeEscritaDaSeguranca')
    expect(chamada).toContain('tokenDoApp: instalacaoDoApp')

    const inicio = scheduler.indexOf('const credenciaisDeEscritaDaSeguranca = async')
    const fim = scheduler.indexOf('let erroDaMedicao', inicio)
    expect(inicio).toBeGreaterThan(0)
    expect(semComentarios(scheduler.slice(inicio, fim))).not.toContain('GITORCH_GITHUB_TOKEN')
  })
})
