const fs = require('fs');
const content = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
console.log(content.includes('actions/upload-pages-artifact@v3'));
console.log(content.includes('id: deployment'));
