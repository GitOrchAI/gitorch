import { exportGraph, PoisonedFileError } from '@gitorch/cgc'

// Processo FILHO de isolamento do export do grafo 3D (F1 — Onda 3). Mesmo
// protocolo de codegraph-child.ts/diagnose-child.ts — o parser WASM do
// tree-sitter pode morrer com erro INCAPTURÁVEL; rodando aqui, um repo
// problemático derruba só este processo, o control plane segue vivo.
//   argv[2] = workspacePath; argv[3] = JSON de relPaths a excluir (opcional);
//   argv[4] = maxNodes (opcional, string numérica)
//   exit 0 → stdout é o JSON do GraphExportResult (ou "null" se vazio)
//   exit 3 → stdout é "POISON:<relPath>" (pai re-tenta excluindo o culpado)
//   demais → crash/erro; pai desiste desta rodada
const workspacePath = process.argv[2]
if (!workspacePath) {
  process.exit(2)
}
const excludeFiles: string[] = process.argv[3] ? (JSON.parse(process.argv[3]) as string[]) : []
const maxNodes = process.argv[4] ? Number(process.argv[4]) : undefined

exportGraph(workspacePath, { excludeFiles, ...(maxNodes !== undefined ? { maxNodes } : {}) })
  .then((graph) => {
    process.stdout.write(JSON.stringify(graph))
    process.exit(0)
  })
  .catch((err) => {
    if (err instanceof PoisonedFileError) {
      process.stdout.write(`POISON:${err.relPath}`)
      process.exit(3)
    }
    process.exit(1)
  })
