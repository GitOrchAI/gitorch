const fs = require('fs');

const p = 'apps/web/src/app/invites/claim/page.tsx';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  /const \[projectData, setProjectData\] = useState<any>\(null\)/g,
  `const [projectData, setProjectData] = useState<{ projects?: { name: string }[], owner?: { githubLogin: string } } | null>(null)`
);

fs.writeFileSync(p, code);
