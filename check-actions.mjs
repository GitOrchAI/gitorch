async function checkActions() {
  const repo = 'loureng/gitorch';
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NodeJS/fetch' }
    });
    if (!response.ok) return;
    const data = await response.json();
    for (const run of data.workflow_runs) {
      console.log(`\nWorkflow: ${run.name}`);
      console.log(`Run ID: ${run.id}`);
      console.log(`Status: ${run.status}`);
      console.log(`Conclusion: ${run.conclusion || 'Rodando...'}`);
      console.log(`Branch: ${run.head_branch}`);
      console.log(`Commit: ${run.head_commit.message}`);
    }
  } catch (err) {}
}
checkActions();
