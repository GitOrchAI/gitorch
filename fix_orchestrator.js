const fs = require('fs');
const file2 = 'packages/agents/src/orchestrator.test.ts';
let content2 = fs.readFileSync(file2, 'utf8');

content2 = content2.replace(/antigravity/g, "codex");

fs.writeFileSync(file2, content2);
