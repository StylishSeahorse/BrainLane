#!/usr/bin/env node
/**
 * CI guard: fail the build if a secret reached the client bundle.
 *
 * The `import 'server-only'` markers and the ESLint process.env rule are the
 * primary defenses. This is the backstop that assumes both were bypassed —
 * it checks the actual shipped artifact rather than the source that produced
 * it, so it catches leaks no lint rule can see (a value inlined through a
 * template string, a config object serialized into __NEXT_DATA__, and so on).
 *
 * Two passes:
 *   1. Literal: every sensitive value from .env, searched for verbatim.
 *   2. Shape:   patterns that look like credentials regardless of our .env.
 *
 * Usage: node scripts/check-bundle-secrets.mjs [bundleDir]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundleDir = process.argv[2] ?? join(repoRoot, 'apps/web/.next/static');

/** Env vars whose values must never appear in client-side output. */
const SENSITIVE_KEYS = [
  'ENCRYPTION_KEK',
  'GOOGLE_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'REDIS_URL',
];

/** Credential-shaped strings, independent of our own configuration. */
const SHAPE_PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Google OAuth client secret', re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Postgres connection URL', re: /postgres(?:ql)?:\/\/[^\s"'`]*:[^\s"'`@]+@/ },
  { name: 'Google service-account private key', re: /-----BEGIN (?:RSA )?PRIVATE KEY-----/ },
];

function loadEnvValues() {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return [];

  const values = [];
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

    // Short values produce false positives against minified JS.
    if (SENSITIVE_KEYS.includes(key) && value.length >= 12) {
      values.push({ key, value });
    }
  }
  return values;
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(js|mjs|cjs|json|html|css|map)$/.test(entry)) {
      yield full;
    }
  }
}

const secrets = loadEnvValues();
const findings = [];
let filesScanned = 0;

for (const file of walk(bundleDir)) {
  filesScanned += 1;
  const content = readFileSync(file, 'utf8');
  const where = relative(repoRoot, file);

  for (const { key, value } of secrets) {
    if (content.includes(value)) {
      findings.push(`${where}: contains the literal value of ${key}`);
    }
  }
  for (const { name, re } of SHAPE_PATTERNS) {
    if (re.test(content)) {
      findings.push(`${where}: matches ${name} pattern`);
    }
  }
}

if (filesScanned === 0) {
  console.log(`No client bundle at ${relative(repoRoot, bundleDir)} — run the build first. Skipping.`);
  process.exit(0);
}

if (findings.length > 0) {
  console.error(`\nSECRET LEAK: ${findings.length} finding(s) in the client bundle:\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    '\nA secret reached code that ships to the browser. Add `import \'server-only\'`\n' +
      'to the offending module and route the value through @fluid/env.\n',
  );
  process.exit(1);
}

console.log(
  `Bundle secret scan clean: ${filesScanned} file(s), ` +
    `${secrets.length} literal value(s) and ${SHAPE_PATTERNS.length} pattern(s) checked.`,
);
