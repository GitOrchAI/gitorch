const fs = require('fs')
const path = 'apps/control-plane/src/services/exigir-revisao-de-seguranca.test.ts'
let content = fs.readFileSync(path, 'utf8')

// The CI error is:
// Replace `·content:·Buffer.from('uses:·gitleaks/action@v1\nrun:·gitleaks·detect').toString('base64')` with `⏎··········content:·Buffer.from('uses:·gitleaks/action@v1\nrun:·gitleaks·detect').toString('base64'),⏎·······`
// Replace `⏎··········{·name:·'ci.yml',·path:·'.github/workflows/ci.yml'·},⏎········` with `{·name:·'ci.yml',·path:·'.github/workflows/ci.yml'·}`

fs.writeFileSync(path, content)
