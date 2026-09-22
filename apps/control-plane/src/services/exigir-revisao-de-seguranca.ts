import { exigeRevisaoSemAlternativa } from './alternativa-gratuita-de-seguranca.js'

export async function calcularExigeRevisaoDeSeguranca(deps: {
  planoPermite: boolean
  wingId: string
  ghGet: (path: string) => Promise<unknown>
  onWarn: (message: string) => void
}): Promise<boolean> {
  if (deps.planoPermite) {
    return false
  }

  let files: Array<{ name: string; path: string }>
  try {
    const response = await deps.ghGet(`/repos/${deps.wingId}/contents/.github/workflows`)
    if (!Array.isArray(response)) {
      deps.onWarn(`[calcularExigeRevisaoDeSeguranca] retorno inesperado: não é array`)
      return false
    }
    files = response as Array<{ name: string; path: string }>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('404')) {
      // .github/workflows not found implies no alternative workflow
      return exigeRevisaoSemAlternativa({
        planoPermite: deps.planoPermite,
        alternativaInstalada: false,
      })
    }
    deps.onWarn(`[calcularExigeRevisaoDeSeguranca] erro na API: ${message}`)
    return false
  }

  let alternativaInstalada = false
  for (const file of files) {
    if (file.name.endsWith('.yml') || file.name.endsWith('.yaml')) {
      try {
        const fileData = (await deps.ghGet(`/repos/${deps.wingId}/contents/${file.path}`)) as {
          content?: string
        }
        if (fileData.content) {
          const text = Buffer.from(fileData.content, 'base64').toString('utf-8')
          if (text.includes('gitleaks')) {
            alternativaInstalada = true
            break
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.onWarn(`[calcularExigeRevisaoDeSeguranca] falha lendo ${file.name}: ${message}`)
        return false
      }
    }
  }

  return exigeRevisaoSemAlternativa({ planoPermite: deps.planoPermite, alternativaInstalada })
}
