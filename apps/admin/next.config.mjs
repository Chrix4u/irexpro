import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const browserSecurityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "base-uri 'self'; object-src 'none'; frame-ancestors 'self'",
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];

const nextConfig = {
  // CI-only portable runtime output; existing runtime build remains unchanged.
  ...(process.env.IREXPRO_HOSTED_STANDALONE === '1' ? {
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@irexpro/types', '@irexpro/api-client'],
  // Keep this initial CSP deliberately narrow. Resource-loading directives
  // belong in a separately validated policy because broker, payment, realtime,
  // analytics, and future admin integrations may need explicit origins.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: browserSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;
