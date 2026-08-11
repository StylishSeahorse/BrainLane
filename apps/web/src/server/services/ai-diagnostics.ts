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
function commandExists(command: string, timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { shell: false, windowsHide: true });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);

    const settle = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };

    child.on('error', () => settle(false));
    child.on('close', (code) => settle(code === 0));
    // Nothing is read from stdout; draining prevents the pipe filling.
    child.stdout.resume();
    child.stderr.resume();
  });
}

export async function checkReadiness(userId: string): Promise<Readiness> {
  const setting = await prisma.aiSetting.findUnique({ where: { userId } });
  const definition: ProviderDefinition = getProvider(setting?.providerId);

  // --- Providers backed by a local CLI ------------------------------------
  if (definition.protocol === 'cli' && definition.cli) {
    const installed = await commandExists(definition.cli.command);

    if (!installed) {
      return {
        state: 'action-needed',
        summary: `\`${definition.cli.command}\` is not installed, or not on this server's PATH.`,
        ...(definition.signIn?.install ? { installUrl: definition.signIn.install } : {}),
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
