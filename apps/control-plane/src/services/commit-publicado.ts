import * as fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Versão que está no ar: qual commit o processo serve e desde quando. Só LÊ o
// que foi publicado; nunca inventa valor quando não sabe.
//
// Duas fontes de commit, nessa ordem:
//  1. Variável de ambiente `GITORCH_PUBLISHED_COMMIT` (override explícito).
//  2. Arquivo `commit-publicado.txt` ao lado do `dist/index.js`, escrito por
//     quem publica logo depois do build. Preferido a reler `.git` em runtime
//     (exigiria o binário git e o diretório certo) e a gravar no `.env`
//     (que carrega segredo).
//
// A rota é pública, então o conteúdo só é aceito se tiver formato de sha
// (7 a 40 hexadecimais); qualquer outra coisa vira `desconhecido`.
// "No ar desde" é a data de modificação do arquivo quando o commit veio dele;
// nos demais casos, o instante em que o processo subiu.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Caminho padrão do arquivo (`dist/services/` -> `dist/commit-publicado.txt`). */
export const CAMINHO_PADRAO_DO_ARQUIVO = path.join(__dirname, '..', 'commit-publicado.txt')

export const DESCONHECIDO = 'desconhecido'

const FORMATO_DE_SHA = /^[0-9a-f]{7,40}$/i

const INICIO_DO_PROCESSO = new Date(Date.now() - process.uptime() * 1000).toISOString()

export interface VersaoNoAr {
  commit: string
  noArDesde: string
}

const cache = new Map<string, VersaoNoAr>()

function comoSha(bruto: string | undefined): string | undefined {
  const valor = bruto?.trim()
  return valor !== undefined && FORMATO_DE_SHA.test(valor) ? valor.toLowerCase() : undefined
}

function lerDoArquivo(arquivo: string): VersaoNoAr {
  try {
    const commit = comoSha(fs.readFileSync(arquivo, 'utf8'))
    if (commit === undefined) return { commit: DESCONHECIDO, noArDesde: INICIO_DO_PROCESSO }
    return { commit, noArDesde: fs.statSync(arquivo).mtime.toISOString() }
  } catch {
    // Arquivo ausente (desenvolvimento, ou antes da primeira publicação): legítimo.
    return { commit: DESCONHECIDO, noArDesde: INICIO_DO_PROCESSO }
  }
}

/** Nunca lança. A variável de ambiente vence o arquivo. */
export function lerVersaoNoAr(args?: { arquivo?: string }): VersaoNoAr {
  const doAmbiente = process.env['GITORCH_PUBLISHED_COMMIT']?.trim()
  if (doAmbiente) {
    return { commit: comoSha(doAmbiente) ?? DESCONHECIDO, noArDesde: INICIO_DO_PROCESSO }
  }
  const arquivo = args?.arquivo ?? CAMINHO_PADRAO_DO_ARQUIVO
  const guardado = cache.get(arquivo)
  if (guardado) return guardado
  const lido = lerDoArquivo(arquivo)
  cache.set(arquivo, lido)
  return lido
}

/** Só para testes: força a releitura do arquivo na próxima chamada. */
export function limparCacheDaVersaoNoAr(): void {
  cache.clear()
}
