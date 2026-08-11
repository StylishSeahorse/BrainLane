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

  it('carries no unverified caveat now that both are exercised end to end', () => {
    for (const id of ['claude-code', 'codex']) {
      expect(getProvider(id).unverified ?? false, id).toBe(false);
    }
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

  it('sandboxes the Codex variant read-only', () => {
    const args = argsFor(new CliAdapter({ command: 'codex', variant: 'codex' }));

    expect(args[0]).toBe('exec');
    // Codex offers no way to disable tools outright, so read-only is the
    // strongest available restriction. Losing it would let an injected
    // calendar invite write to the filesystem.
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('keeps the Codex run isolated and parseable', () => {
    const args = argsFor(new CliAdapter({ command: 'codex', variant: 'codex' }));

    // Runs in a temp dir, so without this Codex refuses to start at all.
    expect(args).toContain('--skip-git-repo-check');
    // No session files, none of the user's own config.
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    // ANSI escapes would corrupt parsing.
    expect(args[args.indexOf('--color') + 1]).toBe('never');
  });
});

describe('model name validation', () => {
  it('refuses shell metacharacters in the model name', () => {
    // Two separate hazards. Shell metacharacters are defence in depth (the
    // process is spawned without a shell), but a leading `-` is live: the CLI
    // would read it as a flag, and `--dangerously-skip-permissions` would undo
    // the tools restriction. Neither must be constructible.
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

describe('subscription sign-in metadata', () => {
  it('tells the user which official command signs them in', () => {
    // The app deliberately runs no OAuth flow of its own — neither vendor
    // publishes a client that lets a third party spend a consumer
    // subscription. Naming the official command is the honest substitute.
    const expected: Record<string, string> = {
      'claude-code': 'claude',
      codex: 'codex login',
      'anthropic-oauth': 'ant auth login',
    };

    for (const [id, command] of Object.entries(expected)) {
      const provider = getProvider(id);
      expect(provider.signIn?.command, id).toBe(command);
      expect(provider.signIn?.detail.length, id).toBeGreaterThan(20);
    }
  });

  it('never asks a sign-in provider for an API key', () => {
    for (const id of ['claude-code', 'codex', 'anthropic-oauth']) {
      expect(getProvider(id).requiresKey, id).toBe(false);
    }
  });

  it('keeps the key-based Anthropic entry distinct from the sign-in one', () => {
    // Both talk to Anthropic, but only one wants a key — collapsing them would
    // force a key on someone who signed in through a browser.
    expect(getProvider('anthropic').requiresKey).toBe(true);
    expect(getProvider('anthropic').signIn).toBeUndefined();
    expect(getProvider('anthropic-oauth').protocol).toBe('anthropic');
  });
});
