import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  // GitHub Pages de projeto vive em /<repo>; domínio custom (js.org) vive na
  // raiz. Dinâmico por build — nunca fixo no código.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
  images: {
    unoptimized: true,
  },
}

export default nextConfig
