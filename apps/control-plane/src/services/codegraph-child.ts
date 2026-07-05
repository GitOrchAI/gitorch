import { summarizeWorkspace, PoisonedFileError } from '@gitorch/cgc'

// Processo FILHO de isolamento do codegraph. O parser WASM do tree-sitter pode
// morrer com erro INCAPTURÁVEL ("memory access out of bounds" em finalizador,
// fora de qualquer try/catch) — visto em produção com repo de cliente. Rodando
// aqui, um repo problemático derruba só este processo; o control plane segue.
//
// Protocolo com o pai:
//   argv[2] = workspacePath; argv[3] = JSON de relPaths a excluir (opcional)
//   exit 0 → stdout é o resumo
//   exit 3 → stdout é "POISON:<relPath>" (pai re-tenta excluindo o culpado)
//   demais → crash/erro; pai desiste desta rodada
const workspacePath = process.argv[2]
if (!workspacePath) {
  process.exit(2)
}
const excludeFiles: string[] = process.argv[3] ? (JSON.parse(process.argv[3]) as string[]) : []

summarizeWorkspace(workspacePath, { excludeFiles })
  .then((summary) => {
    process.stdout.write(summary ?? '')
    process.exit(0)
  })
  .catch((err) => {
    if (err instanceof PoisonedFileError) {
      process.stdout.write(`POISON:${err.relPath}`)
      process.exit(3)
    }
    process.exit(1)
  })
