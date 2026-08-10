import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship raw TypeScript, so Next compiles them itself.
  transpilePackages: [
    '@fluid/ai',
    '@fluid/calendar',
    '@fluid/core',
    '@fluid/crypto',
    '@fluid/db',
    '@fluid/env',
  ],
  // Native/binary deps must not be bundled — they're required at runtime.
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2'],
  experimental: {
    // Server Actions receive user input; keep the body bound small.
    serverActions: { bodySizeLimit: '1mb' },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            // No external origins at all: this app loads nothing it did not
            // build, which makes a stray script tag a load failure rather than
            // a data-exfiltration path.
            //
            // 'unsafe-eval' is added in development only. Next's dev-mode hot
            // reload (react-refresh) evaluates code as strings to patch modules
            // in place, and the CSP blocks that outright — the fix is a dev-only
            // relaxation, not a global one. The production bundle never calls
            // eval, so the deployed CSP stays as tight as before.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
