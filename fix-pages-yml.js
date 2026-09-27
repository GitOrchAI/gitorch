const fs = require('fs')

const path = '.github/workflows/pages.yml'
let yml = fs.readFileSync(path, 'utf8')

yml = yml.replace(
  "environment:\n      name: github-pages",
  "environment: ${{ github.event_name != 'pull_request' && 'github-pages' || '' }}"
)

fs.writeFileSync(path, yml)
