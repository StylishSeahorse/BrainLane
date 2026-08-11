import { describe, expect, it } from 'vitest';
import { CliAdapter } from './cli';
import { getProvider, PROVIDERS } from '../registry';

/**
 * These tests exist for one reason: this adapter spawns a local process on
 * behalf of a web request, and calendar text is attacker-controllable. The
 * properties below are the difference between "a model provider" and "remote
 * code execution with a settings page".
 */
describe('CLI provider registry entries', () => {
  it('pins the command in the registry, not in user settings', () => {
    for (const id of ['claude-code', 'codex']) {
      const provider = getProvider(id);
      expect(provider.protocol).toBe('cli');
      expect(provider.cli?.command).toBeTruthy();
      // A user-editable command would let a settings form choose which binary
      // the server executes.
      expect(provider.editableBaseUrl ?? false).toBe(false);
    }
  });

  it('asks for no API key, because the CLI is already signed in', () => {
    for (const id of ['claude-code', 'codex']) {
      expect(getProvider(id).requiresKey).toBe(false);
    }
  });

  it('marks the unverified integration as unverified', () => {
    expect(getProvider('codex').unverified).toBe(true);
    expect(getProvider('claude-code').unverified ?? false).toBe(false);
  });

  it('gives every CLI provider a command', () => {
    const cliProviders = PROVIDERS.filter((provider) => provider.protocol === 'cli');
    expect(cliProviders.length).toBeGreaterThan(0);
    for (const provider of cliProviders) {
      expect(provider.cli, provider.id).toBeDefined();
    }
  });
});

describe('argument construction', () => {
  /** Reach the private builder without loosening its visibility in the source. */
  const argsFor = (adapter: CliAdapter, reasoning: 'minimal' | 'normal' | 'deep' = 'normal') =>
    (
      adapter as unknown as {
        buildArgs(spec: { system: string; messages: []; reasoning: string }): string[];
      }
    ).buildArgs({ system: 'sys', messages: [], reasoning });

  it('disables all tools for Claude Code', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));

    // The single most important assertion in this file. Claude Code can read
    // files and run shell commands; an injected calendar invite must not be
    // able to reach either.
    const toolsIndex = args.indexOf('--tools');
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe('');
  });

  it('isolates the run from the user’s own Claude Code setup', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));

    for (const flag of ['--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence']) {
      expect(args, flag).toContain(flag);
    }
    expect(args).toContain('--print');
  });

  it('maps reasoning intent onto the CLI effort levels', () => {
    const adapter = new CliAdapter({ command: 'claude', variant: 'claude-code' });

    for (const [reasoning, effort] of [
      ['minimal', 'low'],
      ['normal', 'medium'],
      ['deep', 'high'],
    ] as const) {
      const args = argsFor(adapter, reasoning);
      expect(args[args.indexOf('--effort') + 1], reasoning).toBe(effort);
    }
  });

  it('omits --model when none is configured, deferring to the CLI', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));
    expect(args).not.toContain('--model');
  });

  it('passes an allowlisted model through', () => {
    const args = argsFor(
      new CliAdapter({ command: 'claude', variant: 'claude-code', model: 'claude-sonnet-4-6' }),
    );
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
  });

  it('never puts prompt text in argv', () => {
    const adapter = new CliAdapter({ command: 'claude', variant: 'claude-code' });
    const args = argsFor(adapter);

    // The system prompt was 'sys'; nothing resembling free text should appear.
    // Prompts travel over stdin, which also keeps task titles out of `ps`.
    expect(args).not.toContain('sys');
    for (const arg of args) {
      expect(arg === '' || arg.startsWith('--') || /^[A-Za-z0-9._:/-]+$/.test(arg), arg).toBe(true);
    }
  });

  it('uses codex exec for the Codex variant', () => {
    const args = argsFor(new CliAdapter({ command: 'codex', variant: 'codex' }));
    expect(args[0]).toBe('exec');
  });
});

describe('model name validation', () => {
  it('refuses shell metacharacters in the model name', () => {
    // Windows needs `shell: true` to launch a .cmd shim, so an argv value that
    // survives a shell is the whole attack. These must never be constructible.
    for (const model of [
      'sonnet; rm -rf /',
      'sonnet && curl evil.test',
      'sonnet`whoami`',
      'sonnet $(id)',
      'sonnet | tee /tmp/x',
      'sonnet\nrm -rf /',
      '--dangerously-skip-permissions',
    ]) {
      expect(
        () => new CliAdapter({ command: 'claude', variant: 'claude-code', model }),
        model,
      ).toThrow(/not allowed/i);
    }
  });

  it('accepts ordinary model names and aliases', () => {
    for (const model of ['sonnet', 'opus', 'claude-sonnet-4-6', 'gpt-5', 'openai/gpt-4.1']) {
      expect(
        () => new CliAdapter({ command: 'claude', variant: 'claude-code', model }),
        model,
      ).not.toThrow();
    }
  });
});

describe('missing binary', () => {
  it('reports a missing CLI as unavailable rather than crashing', async () => {
    const adapter = new CliAdapter({
      command: 'fluid-definitely-not-a-real-binary',
      variant: 'claude-code',
      timeoutMs: 15_000,
    });

    // healthCheck swallows the error and reports false, so a provider that is
    // not installed degrades to the deterministic scheduler.
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });
});
