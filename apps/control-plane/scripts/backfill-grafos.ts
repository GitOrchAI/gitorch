import { PrismaClient } from '@prisma/client'
import { atualizarGrafoDeVinculos } from '../src/services/grafo-de-vinculos.js'

async function main() {
  const GITHUB_TOKEN = process.env['GITHUB_TOKEN']
  if (!GITHUB_TOKEN) {
    console.error('PARA: GITHUB_TOKEN vazio')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const alvos = ['GitOrchAI/gitorch', 'loureng/patinhas-3d-crafts', 'GitOrchAI/padrao-executores']
    const projects = await prisma.project.findMany({
      where: { wingId: { in: alvos } },
    })

    if (projects.length === 0) {
      console.log('Nenhum projeto encontrado entre os alvos.')
      return
    }

    let sucessos = 0
    let erros = 0

    for (const proj of projects) {
      const [owner = '', repo = ''] = proj.wingId.split('/')
      console.log(`Buscando itens abertos para ${proj.wingId}...`)

      // Apenas pegamos alguns dos itens de pr e issue já registrados que não estão fechados.
      // O estado é JSON. Para simplificar no script, pegaremos todos e processaremos ignorando se o json "estado.status" é open explicitamente caso a consulta json no prisma dê problema.
      const itens = await prisma.repoItem.findMany({
        where: {
          projectId: proj.id,
          tipo: { in: ['issue', 'pr'] },
        },
      })

      for (const item of itens) {
        try {
          // Checa se já não existe grafo com sucesso recente (podemos pular, mas faremos overwrite como manda o script de backfill).
          console.log(`Processando item #${item.numero} (${item.tipo}) em ${proj.wingId}`)
          await atualizarGrafoDeVinculos({
            prisma: prisma as never,
            githubToken: GITHUB_TOKEN,
            owner,
            repo,
            numero: item.numero,
            tipo: item.tipo as 'issue' | 'pr',
            repoItemId: item.id,
          })
          sucessos++
        } catch (e) {
          console.error(`Erro ao processar item #${item.numero} de ${proj.wingId}:`, e)
          erros++
        }
      }
    }

    console.log('')
    console.log('=== RESULTADO BACKFILL GRAFOS ===')
    console.log(`Sucessos: ${sucessos}`)
    console.log(`Erros:    ${erros}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(console.error)
