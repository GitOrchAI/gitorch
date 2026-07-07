import { diagnoseWorkspaceStructural, PoisonedFileError } from '@gitorch/cgc'

// Processo FILHO de isolamento do diagnóstico (mesmo protocolo de
// codegraph-child.ts — ver o comentário lá para o motivo do isolamento).
//   argv[2] = workspacePath; argv[3] = JSON de relPaths a excluir (opcional)
//   exit 0 → stdout é o JSON do StructuralDiagnosis (ou "null" se vazio)
//   exit 3 → stdout é "POISON:<relPath>" (pai re-tenta excluindo o culpado)
//   demais → crash/erro; pai desiste desta rodada
const workspacePath = process.argv[2]
if (!workspacePath) {
  process.exit(2)
}
const excludeFiles: string[] = process.argv[3] ? (JSON.parse(process.argv[3]) as string[]) : []

diagnoseWorkspaceStructural(workspacePath, { excludeFiles })
  .then((diagnosis) => {
    process.stdout.write(JSON.stringify(diagnosis))
    process.exit(0)
  })
  .catch((err) => {
    if (err instanceof PoisonedFileError) {
      process.stdout.write(`POISON:${err.relPath}`)
      process.exit(3)
    }
    process.exit(1)
  })
