// Base da API do GitOrch. Em produção (GitHub Pages) vem do build
// (NEXT_PUBLIC_API_URL); em dev local cai no control-plane padrão. Dinâmico,
// nunca hardcoded por ambiente.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : '')
