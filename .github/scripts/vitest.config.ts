import { defineConfig } from 'vitest/config'

// Sem um arquivo de configuração aqui, o vitest sobe a árvore de diretórios e
// adota o da raiz do repositório. Isso funciona na máquina de quem já instalou
// a raiz inteira e falha em qualquer lugar que instale só este diretório — que
// é exatamente o caso do trabalho de CI que roda estes testes.
//
// A raiz também exige cem por cento de cobertura, política que vale para o
// produto. Este diretório guarda a automação do repositório e nunca esteve sob
// ela: herdá-la por acidente reprovaria os testes por um motivo que ninguém
// escolheu.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
})
