// A guarda extra do vigia: sem a proteção de senhas do GitHub e sem a
// alternativa gratuita (gitleaks) rodando no repositório, o GitOrch passa a
// exigir revisão humana antes de mesclar.
//
// A resposta sai da SONDAGEM do repositório (ver `sondagem-de-seguranca.ts`),
// lida do próprio GitHub e guardada por projeto por dia; antes, cada PR de cada
// passada relia a pasta de workflows e cada arquivo dela.

import { exigeRevisaoSemAlternativa } from './alternativa-gratuita-de-seguranca.js'
import {
  obterSondagem,
  recursoDeSegredosDisponivel,
  type CredencialDaSondagem,
  type PrismaDaSondagem,
  type SondagemDoRepositorio,
} from './sondagem-de-seguranca.js'
import { erroDeRedeSeguro } from './leitor-de-seguranca.js'

/**
 * `false` quando não há o que bloquear ou quando não deu para saber: uma
 * leitura que falha nunca trava o merge de ninguém.
 */
export function calcularExigeRevisaoDeSeguranca(sondagem: SondagemDoRepositorio | null): boolean {
  if (sondagem === null) return false
  const planoPermite = recursoDeSegredosDisponivel(sondagem)
  if (planoPermite) return false
  if (sondagem.workflows.estado === 'erro') return false
  const alternativaInstalada = sondagem.workflows.itens.some((w) => w.temGitleaks)
  return exigeRevisaoSemAlternativa({ planoPermite, alternativaInstalada })
}

/**
 * A guarda de UM projeto para a passada do vigia: a primeira pergunta resolve a
 * sondagem (cache do dia ou leitura nova) e todas as outras, de todos os PRs da
 * passada, reaproveitam a mesma promessa. Nunca lança.
 */
export function criarGuardaDeSegurancaDoVigia(deps: {
  prisma: PrismaDaSondagem
  projectId: string
  repositorio: string
  credenciais: readonly CredencialDaSondagem[]
  fetchImpl: typeof fetch
  agora: () => Date
  onWarn: (mensagem: string) => void
}): () => Promise<boolean> {
  let resolvida: Promise<boolean> | null = null
  return () => {
    resolvida ??= (async () => {
      try {
        const obtida = await obterSondagem({
          prisma: deps.prisma,
          projectId: deps.projectId,
          repositorio: deps.repositorio,
          credenciais: deps.credenciais,
          fetchImpl: deps.fetchImpl,
          agora: deps.agora(),
          exigirAdmin: false,
          onWarn: deps.onWarn,
        })
        return calcularExigeRevisaoDeSeguranca(obtida?.sondagem ?? null)
      } catch (erro) {
        deps.onWarn(
          `[exigir-revisao-de-seguranca] erro ao sondar ${deps.repositorio}: ${erroDeRedeSeguro(erro, '')}`
        )
        return false
      }
    })()
    return resolvida
  }
}
