import * as fs from 'node:fs'

// Ponte público↔privado: o control-plane (repo público) não contém as
// versões pinadas dos motores nem a referência dos pacotes nativos
// (cadence/cgc/memória) — isso vive no manifesto de versões do repo privado
// gitorch-cloud (infra/manifest.json). Este serviço só LÊ esse manifesto de
// um path configurável; nunca assume onde ele está nem embute segredo algum.
// Quem usa (bootstrap do ambiente de missão, próximas tasks da W1) recebe
// tipos estáveis (EngineVersion/ResourcesRef) sem depender do formato bruto.

export interface EngineVersion {
  name: 'claude' | 'codex' | 'antigravity'
  version: string
  npm?: string
  binary?: string
  sha256?: Record<string, string>
}

export interface ResourcesRef {
  repo: string
  commit: string
  packages: Record<string, string>
}

interface RawEngineNpm {
  npm: string
  version: string
}

interface RawEngineBinary {
  binary: string
  version: string
  sha256?: Record<string, string>
  sizeBytes?: number
}

export interface VersionManifest {
  schemaVersion: number
  engines: {
    claude: RawEngineNpm
    codex: RawEngineNpm
    antigravity: RawEngineBinary
  }
  resources: ResourcesRef
}

const SUPPORTED_SCHEMA_VERSION = 1

/** Cache em memória por path — o manifesto não muda durante o processo vivo. */
const manifestCache = new Map<string, VersionManifest>()

/**
 * Carrega e valida o manifesto de versões do repo privado.
 *
 * O path vem do argumento explícito ou de GITORCH_MANIFEST_PATH. Sem
 * nenhum dos dois, ou com arquivo ausente/JSON inválido/schemaVersion
 * incompatível, lança um erro claro — nunca falha silenciosamente nem
 * inventa um manifesto vazio.
 */
export function loadManifest(path?: string): VersionManifest {
  const manifestPath = path ?? process.env['GITORCH_MANIFEST_PATH']
  if (!manifestPath) {
    throw new Error(
      'GITORCH_MANIFEST_PATH não configurado: o ambiente precisa do manifesto de versões do repo privado (gitorch-cloud/infra/manifest.json). Configure a variável de ambiente GITORCH_MANIFEST_PATH ou passe o path explicitamente.'
    )
  }

  const cached = manifestCache.get(manifestPath)
  if (cached) return cached

  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (err) {
    throw new Error(
      `Manifesto de versões não encontrado em ${manifestPath}: ${(err as Error).message}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Manifesto de versões em ${manifestPath} não é um JSON válido: ${(err as Error).message}`
    )
  }

  const manifest = parsed as VersionManifest
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Manifesto de versões em ${manifestPath} tem schemaVersion ${String(manifest.schemaVersion)}; esperado ${SUPPORTED_SCHEMA_VERSION}`
    )
  }

  manifestCache.set(manifestPath, manifest)
  return manifest
}

/** Versões pinadas dos 3 motores (Claude, Codex, Antigravity). */
export function getEngineVersions(manifest: VersionManifest): EngineVersion[] {
  const { claude, codex, antigravity } = manifest.engines
  return [
    { name: 'claude', version: claude.version, npm: claude.npm },
    { name: 'codex', version: codex.version, npm: codex.npm },
    {
      name: 'antigravity',
      version: antigravity.version,
      binary: antigravity.binary,
      // exactOptionalPropertyTypes: só inclui a chave quando o manifesto trouxer
      // sha256 de fato — `sha256: undefined` explícito violaria o tipo opcional.
      ...(antigravity.sha256 !== undefined ? { sha256: antigravity.sha256 } : {}),
    },
  ]
}

/** Referência dos recursos nativos do monorepo público (cadence/cgc/memória). */
export function getResourcesRef(manifest: VersionManifest): ResourcesRef {
  return manifest.resources
}

/** Só para testes: força a releitura do manifesto na próxima chamada. */
export function clearManifestCache(): void {
  manifestCache.clear()
}
