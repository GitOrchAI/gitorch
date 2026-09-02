import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  // GitHub Pages de projeto vive em /<repo>; domínio custom (js.org) vive na
  // raiz. Dinâmico por build — nunca fixo no código.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // O dev server do Next bloqueia origens != localhost (serve o HTML mas
  // recusa os assets/scripts — a página "abre" e nada funciona). Para testar
  // de outra máquina (ex.: staging via VPN), as origens permitidas vêm do
  // ambiente (.env.local, fora do git) — hostname de infra NUNCA no código.
  ...(process.env.NEXT_DEV_ALLOWED_ORIGINS
    ? { allowedDevOrigins: process.env.NEXT_DEV_ALLOWED_ORIGINS.split(',') }
    : {}),
}

export default nextConfig
