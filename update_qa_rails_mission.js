const fs = require('fs')

const filepath = 'apps/control-plane/src/services/qa-rails-mission.ts'
let content = fs.readFileSync(filepath, 'utf8')

// The block starts around line 695. Let's find exactly what to replace.
const searchBlock = `    // O LEGADO: reprovação escrita ANTES de o produto passar a aceitar job
    // \`skipped\` como parte de um CI verde. Ela não tem — nem podia ter — a
    // marca do portão, porque a marca nasceu depois; e o corpo de uma
    // reprovação de CÓDIGO é idêntico ao de uma do portão, então ler o texto
    // não distingue as duas. A evidência é outra: mesmo commit, e verde pela
    // régua de HOJE. Uma vez só, e nunca depois do corte — senão isto viraria
    // segunda chance permanente, que é a trava que ninguém pode afrouxar.
    let legadoMereceUmaChance = false
    if (
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      reviewMarcadaNesteHead &&
      !reprovadoPeloPortaoComCiVerdeAgora &&
      !foiAprovacao &&
      p.head?.sha
    ) {
      const decisao = decidirSobreLegado({
        numero: p.number,
        headAtual: p.head.sha,
        headJulgado: reviewMarcadaNesteHead.commit_id ?? null,
        reprovadaEm: dataDaReview(reviewMarcadaNesteHead),
        ciHoje: await (async () => {
          try {
            const checks = (await gh(
              'GET',
              \`/repos/\${options.repository}/commits/\${p.head?.sha}/check-runs\`
            )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
            return estadoDoCi(checks.check_runs ?? [])
          } catch {
            // Não saber o estado é "não sei", e "não sei" nunca destrava.
            return 'unknown' as const
          }
        })(),
        delegada: veredito.delegado,
        jaRejulgada: temMarcaDeRejulgamentoDeLegado(reviewMarcadaNesteHead),
      })
      legadoMereceUmaChance = decisao.acao === 'rejulgar'
      if (legadoMereceUmaChance) {
        options.onWarn?.(
          \`[qa] PR #\${p.number}: \${decisao.motivo} — dando o rejulgamento único do legado\`
        )
      }
    }`

const replaceBlock = `    // O LEGADO: reprovação escrita ANTES de o produto passar a aceitar job
    // \`skipped\` como parte de um CI verde. Ela não tem — nem podia ter — a
    // marca do portão, porque a marca nasceu depois; e o corpo de uma
    // reprovação de CÓDIGO é idêntico ao de uma do portão, então ler o texto
    // não distingue as duas. A evidência é outra: mesmo commit, e verde pela
    // régua de HOJE. Uma vez só, e nunca depois do corte — senão isto viraria
    // segunda chance permanente, que é a trava que ninguém pode afrouxar.
    let legadoMereceUmaChance = false
    let legadoMereceExplicacao = false
    if (
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      reviewMarcadaNesteHead &&
      !reprovadoPeloPortaoComCiVerdeAgora &&
      !foiAprovacao &&
      p.head?.sha
    ) {
      const { estado, culpado } = await (async () => {
          try {
            const checks = (await gh(
              'GET',
              \`/repos/\${options.repository}/commits/\${p.head?.sha}/check-runs\`
            )) as { check_runs?: Array<{ id?: number; name?: string; conclusion?: string; status?: string }> }
            const checkRuns = checks.check_runs ?? []

            const investigado = await investigarEstadoDoCi(checkRuns, async (jobId) => {
              const job = (await gh('GET', \`/repos/\${options.repository}/actions/jobs/\${jobId}\`)) as {
                steps?: Array<{ name?: string; conclusion?: string; completed_at?: string }>
              }
              return (job.steps ?? []).map((s) => ({
                name: s.name ?? '',
                conclusion: s.conclusion ?? null,
                completedAt: s.completed_at ?? null,
              }))
            }).catch(() => ({ estado: estadoDoCi(checkRuns), culpado: { encontrado: false as const } }))
            return investigado
          } catch {
            return { estado: 'unknown' as const, culpado: { encontrado: false as const } }
          }
      })()
      const decisao = decidirSobreLegado({
        numero: p.number,
        headAtual: p.head.sha,
        headJulgado: reviewMarcadaNesteHead.commit_id ?? null,
        reprovadaEm: dataDaReview(reviewMarcadaNesteHead),
        ciHoje: estado,
        culpadoDoCancelamento: culpado,
        delegada: veredito.delegado,
        jaRejulgada: temMarcaDeRejulgamentoDeLegado(reviewMarcadaNesteHead),
      })
      legadoMereceUmaChance = decisao.acao === 'rejulgar'
      legadoMereceExplicacao = decisao.acao === 'explicar-falha'

      if (legadoMereceUmaChance) {
        options.onWarn?.(
          \`[qa] PR #\${p.number}: \${decisao.motivo} — dando o rejulgamento único do legado\`
        )
      } else if (legadoMereceExplicacao) {
        options.onWarn?.(
          \`[qa] PR #\${p.number}: \${decisao.motivo} — reescrevendo o parecer para explicar a falha de cancelamento\`
        )
      }
    }`

content = content.replace(searchBlock, replaceBlock)

if (content.includes('legadoMereceExplicacao')) {
  console.log('Successfully replaced block.')

  // Also we need to make sure `deveRejulgar` is updated to include `legadoMereceExplicacao`
  const deveRejulgarSearchBlock = `    const deveRejulgar =
      veredito.delegado &&
      (tarefaFoiRevinculada ||
        (aindaPodeTentarMesclar &&
          (foiAprovacao ||
            parecerSobPremissaErrada ||
            reprovadoPeloPortaoComCiVerdeAgora ||
            legadoMereceUmaChance ||
            entregaVaziaAindaNaoCobrada)))`

  const deveRejulgarReplaceBlock = `    const deveRejulgar =
      veredito.delegado &&
      (tarefaFoiRevinculada ||
        (aindaPodeTentarMesclar &&
          (foiAprovacao ||
            parecerSobPremissaErrada ||
            reprovadoPeloPortaoComCiVerdeAgora ||
            legadoMereceUmaChance ||
            legadoMereceExplicacao ||
            entregaVaziaAindaNaoCobrada)))`

  content = content.replace(deveRejulgarSearchBlock, deveRejulgarReplaceBlock)

  // also update `retomandoAprovacaoMesmoCommit`? Wait, if we are just re-judging to explain,
  // we are in the exact same state as "legadoMereceUmaChance".
  const retomandoAprovacaoSearchBlock = `    retomandoAprovacaoMesmoCommit = Boolean(
      reviewMarcadaNesteHead &&
      (foiAprovacao || reprovadoPeloPortaoComCiVerdeAgora || legadoMereceUmaChance)
    )
    retomouLegado = legadoMereceUmaChance`

  const retomandoAprovacaoReplaceBlock = `    retomandoAprovacaoMesmoCommit = Boolean(
      reviewMarcadaNesteHead &&
      (foiAprovacao || reprovadoPeloPortaoComCiVerdeAgora || legadoMereceUmaChance || legadoMereceExplicacao)
    )
    retomouLegado = legadoMereceUmaChance || legadoMereceExplicacao`

  content = content.replace(retomandoAprovacaoSearchBlock, retomandoAprovacaoReplaceBlock)

  fs.writeFileSync(filepath, content)
} else {
  console.log('Failed to find block to replace.')
}
