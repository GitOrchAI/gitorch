const fs = require('fs');
const ts_decisao = './apps/control-plane/src/services/decisao-do-vigia.ts';
let code_decisao = fs.readFileSync(ts_decisao, 'utf8');

code_decisao = code_decisao.replace(
  "        const reviews = (await ghGet(\n          `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/reviews?per_page=100`,\n          token\n        )) as ReviewDoGithub[]",
  "        const rawReviews = await ghGet(\n          `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/reviews?per_page=100`,\n          token\n        )\n        const reviews = Array.isArray(rawReviews) ? (rawReviews as ReviewDoGithub[]) : []"
);

code_decisao = code_decisao.replace(
  "    if (depsVigia.headSha) {",
  "    if (!depsVigia.headSha) {\n      onWarn(\n        `decidirAcaoNoPrOrfaoIntegrado: headSha ausente no PR #${depsVigia.numero}, ignorando busca de pareceres do QA.`\n      )\n    } else {"
);

fs.writeFileSync(ts_decisao, code_decisao);
