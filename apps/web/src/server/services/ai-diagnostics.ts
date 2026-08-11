/**
 * "Is this provider actually ready?" — answered without spending tokens.
 *
 * The failure people hit with subscription-backed providers is never subtle: the
 * CLI is missing, or it is installed but not signed in. Both have a one-line
 * fix, so the settings screen should name it rather than making someone infer it
 * from a failed request.
 */
import 'server-only';
import { spawn } from 'node:child_process';
import { getProvider, type ProviderDefinition } from '@fluid/ai';
import { resolveCommand } from '@fluid/ai/adapters/cli';
import { env } from '@fluid/env';
import { prisma } from '@fluid/db';

export type ReadinessState = 'ready' | 'action-needed' | 'unknown';

export interface Readiness {
  state: ReadinessState;
  summary: string;
  /** The exact command to run, when there is one. */
  command?: string;
  installUrl?: string;
}

/**
 * Does this command exist on PATH?
 *
 * Runs `<command> --version`, which every one of these CLIs supports and which
 * costs nothing. The command comes from the registry, never from user input.
 */
function run(
  command: string,
  args: string[],
  timeoutMs = 12_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let output = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, output });
    }, timeoutMs);

    const settle = (code: number) => {
      clearTimeout(timer);
      resolve({ code, output });
    };

    // Bounded: these commands print a line or two, but a wedged binary should
    // not be able to fill memory.
    const collect = (chunk: Buffer) => {
      if (output.length < 8_000) output += chunk.toString('utf8');
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => settle(-1));
    child.on('close', (code) => settle(code ?? -1));
  });
}

async function commandExists(command: string): Promise<boolean> {
  return (await run(command, ['--version'], 8_000)).code === 0;
}

export async function checkReadiness(userId: string): Promise<Readiness> {
  const setting = await prisma.aiSetting.findUnique({ where: { userId } });
  const definition: ProviderDefinition = getProvider(setting?.providerId);

  // --- Providers backed by a local CLI ------------------------------------
  if (definition.protocol === 'cli' && definition.cli) {
    // Resolve the same way the adapter does. Codex's Windows installer does not
    // put itself on PATH, so a bare name check would report a working install
    // as missing.
    const command = resolveCommand(definition.cli.command, definition.cli.variant);
    const installed = await commandExists(command);

    if (!installed) {
      return {
        state: 'action-needed',
        summary: `\`${definition.cli.command}\` is not installed, or not where this server can find it.`,
        ...(definition.signIn?.install ? { installUrl: definition.signIn.install } : {}),
      };
    }

    // Codex can answer "am I signed in?" for free. Spending tokens to discover
    // a login problem would be a poor trade.
    if (definition.cli.variant === 'codex') {
      const status = await run(command, ['login', 'status']);

      if (status.code === 0 && /logged in/i.test(status.output)) {
        return { state: 'ready', summary: status.output.trim().slice(0, 120) };
      }

      return {
        state: 'action-needed',
        summary: 'Codex is installed but not signed in.',
        ...(definition.signIn?.command ? { command: definition.signIn.command } : {}),
      };
    }

    return {
      state: 'unknown',
      summary:
        `\`${definition.cli.command}\` is installed. Whether it is signed in can only be ` +
        `confirmed by a real request — use Test connection.`,
      ...(definition.signIn?.command ? { command: definition.signIn.command } : {}),
    };
  }

  // --- Anthropic via browser sign-in --------------------------------------
  if (definition.id === 'anthropic-oauth') {
    // The SDK also reads an OAuth profile from disk, which this cannot see, so
    // an env var is proof of readiness but its absence proves nothing.
    if (env.ANTHROPIC_API_KEY) {
      return {
        state: 'ready',
        summary: 'Using credentials already present in this server’s environment.',
      };
    }

    return {
      state: 'unknown',
      summary:
        'Credentials come from the sign-in profile on this machine, which cannot be ' +
        'inspected from here. Use Test connection to confirm.',
      ...(definition.signIn?.command ? { command: definition.signIn.command } : {}),
      ...(definition.signIn?.install ? { installUrl: definition.signIn.install } : {}),
    };
  }

  // --- Key-based providers -------------------------------------------------
  if (definition.requiresKey) {
    const hasKey = Boolean(setting?.encryptedApiKey) || Boolean(env.ANTHROPIC_API_KEY && definition.id === 'anthropic');

    return hasKey
      ? { state: 'ready', summary: 'A key is stored for this provider.' }
      : { state: 'action-needed', summary: 'No API key saved yet for this provider.' };
  }

  return { state: 'ready', summary: 'No credentials needed.' };
}
