/**
 * Local agent CLIs as model providers — Claude Code and Codex.
 *
 * These are a genuinely different shape from the HTTP providers: the binary is
 * already installed and already authenticated, so there is no key to manage and
 * no endpoint to reach. Someone paying for a Claude or ChatGPT subscription can
 * use it here without paying a second time for API access.
 *
 * Both vendors support this: `claude -p` is documented headless mode, and
 * `codex exec` is the documented non-interactive command.
 *
 * ---------------------------------------------------------------------------
 * SECURITY — read before changing anything here
 * ---------------------------------------------------------------------------
 *
 * Spawning a local process on behalf of a web request is the highest-risk thing
 * in this codebase, and calendar text is attacker-controllable: anyone who can
 * send the user a meeting invite can put text into the prompt. Three rules keep
 * that from becoming code execution on the user's machine.
 *
 * 1. TOOLS LOCKED DOWN. Both CLIs can read files and run shell commands.
 *    Handing either an injected prompt with tools enabled turns "someone sent
 *    me a calendar invite" into code execution. Neither flag is a tuning knob.
 *
 *    Claude Code: `--tools ""` removes tool access entirely.
 *    Codex:       `--sandbox read-only` is the tightest setting it offers.
 *
 *    These are NOT equivalent, and the difference is worth knowing: Codex can
 *    still run read-only shell commands, so the Codex path is a weaker
 *    guarantee than the Claude Code one. It cannot modify the filesystem, but
 *    it can look at it. Anyone treating them as interchangeable is wrong.
 *
 * 2. THE COMMAND IS NEVER USER INPUT. It comes from the fixed registry. A
 *    user-supplied binary path would be a remote-code-execution feature with a
 *    settings page.
 *
 * 3. NO FREE TEXT IN ARGV. Prompts go over stdin; every argv element is either
 *    a literal flag or a value checked against a strict allowlist, and no
 *    value may begin with `-` (a model named `--dangerously-skip-permissions`
 *    would otherwise be read as a flag and undo rule 1). The process is spawned
 *    with no shell at all. stdin also keeps task titles out of the process
 *    list, where any other user on the machine could read them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AIAuthError,
  AIResponseError,
  AITimeoutError,
  AIUnavailableError,
  type AIProvider,
  type AvoidanceHistory,
  type Insight,
  type PromptMessage,
  type PromptSpec,
  type ScheduleSuggestion,
  type SchedulingContext,
  type Subtask,
  type TaskBreakdownRequest,
} from '../provider';
import { avoidancePrompt, breakdownPrompt, chatPrompt, schedulingPrompt } from '../prompts/index';

export type CliVariant = 'claude-code' | 'codex';

/** Generous: a local agent is slower than an HTTP call, and cold starts happen. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Refuse to buffer more than this from the child. */
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * Anything reaching argv must match this.
 *
 * Deliberately narrow — model names and effort levels only. No spaces, quotes,
 * semicolons, backticks or dollar signs, so the value is inert even if a shell
 * parses it.
 *
 * The leading character is constrained separately below. A value may not start
 * with `-`, because a model name like `--dangerously-skip-permissions` is
 * shell-safe but would be read by the CLI as a *flag* — argument injection,
 * and in this case a route back to the tool access that `--tools ""` removes.
 */
const SAFE_ARG = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$/;

const EFFORT_BY_REASONING = {
  minimal: 'low',
  normal: 'medium',
  deep: 'high',
} as const;

/**
 * Where these CLIs land when they are not on PATH.
 *
 * Codex's Windows installer puts `codex.exe` under LOCALAPPDATA and does not
 * add it to PATH, so a perfectly working install looks missing to a bare
 * `spawn('codex')`. Checking a handful of known locations turns "not installed"
 * into "found it".
 *
 * These are fixed paths built from the OS's own directories — still nothing
 * user-supplied, so rule 2 in the security note holds.
 */
function knownInstallPaths(variant: CliVariant): string[] {
  const home = homedir();
  const localAppData = join(home, 'AppData', 'Local');

  if (variant === 'codex') {
    return [
      join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      join(home, '.codex', 'bin', 'codex'),
      join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ];
  }

  return [
    join(home, '.local', 'bin', 'claude.exe'),
    join(home, '.local', 'bin', 'claude'),
    join(localAppData, 'Programs', 'claude', 'claude.exe'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

/**
 * Resolve to a known install location if one exists, else the bare name.
 *
 * Known locations win because they are the official installers' own paths and
 * can be confirmed to exist; the bare name is the fallback that lets PATH do
 * the work — which covers npm-installed copies and version managers. The two
 * only disagree if a machine has both, which is rare and resolves toward the
 * vendor's installer.
 */
export function resolveCommand(command: string, variant: CliVariant): string {
  // Only substitute when the caller asked for this variant's own binary.
  // Without this the known-paths lookup keys off the variant alone, so any
  // command name at all would resolve to the installed CLI — which would make
  // a typo silently launch the real thing.
  const expected = variant === 'codex' ? 'codex' : 'claude';
  if (command !== expected) return command;

  for (const candidate of knownInstallPaths(variant)) {
    if (existsSync(candidate)) return candidate;
  }
  return command;
}

export interface CliAdapterOptions {
  /** Fixed by the registry. Never user input. */
  command: string;
  variant: CliVariant;
  /** Optional; when absent the CLI uses whatever it is configured to use. */
  model?: string | undefined;
  timeoutMs?: number;
  /** Working directory for the child. Defaults to the OS temp dir. */
  cwd?: string | undefined;
}

interface ClaudeCodeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
}

export class CliAdapter implements AIProvider {
  readonly kind = 'LOCAL' as const;
  readonly model: string;

  private readonly command: string;
  /** Bare name, used in anything a human reads. */
  private readonly displayName: string;
  private readonly variant: CliVariant;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;

  constructor(options: CliAdapterOptions) {
    this.command = resolveCommand(options.command, options.variant);
    this.displayName = options.command;
    this.variant = options.variant;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = options.cwd;

    const model = options.model?.trim() ?? '';
    if (model && !SAFE_ARG.test(model)) {
      throw new AIResponseError(
        'That model name contains characters that are not allowed for a local CLI provider.',
      );
    }
    this.model = model;
  }

  // -------------------------------------------------------------------------
  // Feature methods
  // -------------------------------------------------------------------------

  async generateScheduleSuggestion(context: SchedulingContext): Promise<ScheduleSuggestion> {
    const parsed = await this.runStructured<ScheduleSuggestion>(schedulingPrompt(context));
    if (!Array.isArray(parsed?.placements)) {
      throw new AIResponseError('Schedule suggestion did not contain a placements array');
    }
    return parsed;
  }

  async breakdownTask(request: TaskBreakdownRequest): Promise<Subtask[]> {
    const parsed = await this.runStructured<{ subtasks: Subtask[] }>(breakdownPrompt(request));
    if (!Array.isArray(parsed?.subtasks)) {
      throw new AIResponseError('Task breakdown did not contain a subtasks array');
    }

    return parsed.subtasks
      .filter((subtask) => typeof subtask?.title === 'string' && subtask.title.trim())
      .map((subtask) => ({
        title: subtask.title.trim().slice(0, 200),
        estimatedMinutes: clampMinutes(subtask.estimatedMinutes),
        isStarterStep: Boolean(subtask.isStarterStep),
      }));
  }

  async detectAvoidancePattern(history: AvoidanceHistory): Promise<Insight[]> {
    const parsed = await this.runStructured<{ insights: Insight[] }>(avoidancePrompt(history));
    if (!Array.isArray(parsed?.insights)) return [];

    return parsed.insights.filter(
      (insight) => typeof insight?.ref === 'string' && typeof insight?.observation === 'string',
    );
  }

  async chatRespond(messages: PromptMessage[], context: SchedulingContext): Promise<PromptMessage> {
    const text = await this.runText(chatPrompt(messages, context));
    return { role: 'assistant', content: text };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const text = await this.runText({
        system: 'You are a connectivity probe.',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxOutputTokens: 16,
        reasoning: 'minimal',
      });
      return text.length > 0;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Process handling
  // -------------------------------------------------------------------------

  /**
   * Build argv.
   *
   * Every element is a literal flag or an allowlisted value; the prompt itself
   * never appears here. See the security note at the top of the file.
   */
  private buildArgs(spec: PromptSpec, outputFile?: string): string[] {
    const effort = EFFORT_BY_REASONING[spec.reasoning ?? 'normal'];

    if (this.variant === 'claude-code') {
      const args = [
        '--print',
        '--output-format',
        'json',
        // Tools off. The single most important argument in this file.
        '--tools',
        '',
        // Nothing from the user's own setup should influence a request made on
        // their behalf by a web app.
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--effort',
        effort,
      ];

      if (this.model) args.push('--model', this.model);
      return args;
    }

    // Codex, verified against codex-cli 0.130.
    const args = [
      'exec',
      // The counterpart to Claude Code's `--tools ""`. Codex has no way to turn
      // tools off outright, so read-only is the tightest setting available: the
      // model can still run shell commands, but cannot write to the filesystem.
      // Worth stating plainly — this is a weaker guarantee than the Claude Code
      // path, not an equivalent one.
      '--sandbox',
      'read-only',
      // We run in a temp directory, and Codex refuses to start outside a git
      // repo without this.
      '--skip-git-repo-check',
      // Leave nothing behind: no session files, and none of the user's own
      // config. Auth still resolves, which is the point.
      '--ephemeral',
      '--ignore-user-config',
      // Without this the output carries ANSI escapes, which corrupt parsing.
      '--color',
      'never',
    ];

    if (outputFile) args.push('--output-last-message', outputFile);
    if (this.model) args.push('--model', this.model);
    return args;
  }

  private async spawnCli(spec: PromptSpec): Promise<string> {
    // Codex writes its final answer to a file. Scraping stdout instead is not
    // viable: a single run emits hundreds of kilobytes of progress logs and
    // model-catalogue chatter, with the actual answer buried in it.
    const outputFile =
      this.variant === 'codex' ? join(tmpdir(), `fluid-codex-${randomUUID()}.txt`) : undefined;

    try {
      const stdout = await this.spawnProcess(spec, outputFile);

      if (outputFile) {
        const answer = await readFile(outputFile, 'utf8').catch(() => '');
        if (answer.trim()) return answer;
        // Fall through to stdout if the file is missing or empty, so a version
        // that drops the flag degrades instead of failing outright.
      }

      return stdout;
    } finally {
      if (outputFile) await unlink(outputFile).catch(() => {});
    }
  }

  private async spawnProcess(spec: PromptSpec, outputFile: string | undefined): Promise<string> {
    const args = this.buildArgs(spec, outputFile);

    // Belt and braces: nothing should reach argv that fails the allowlist, so
    // if anything does, that is a bug and the request must not run.
    //
    // The one exemption is the output path, which is an absolute filename we
    // built ourselves from `tmpdir()` and a UUID. It cannot satisfy the
    // allowlist (drive letters and backslashes on Windows) and no part of it
    // comes from the user, so it is compared by identity rather than pattern.
    for (const arg of args) {
      if (arg === '' || arg === outputFile || arg.startsWith('--')) continue;
      if (!SAFE_ARG.test(arg)) {
        throw new AIResponseError('Refusing to launch the CLI with an unexpected argument.');
      }
    }

    // System prompt and user turns are combined into a single stdin payload so
    // no free text touches argv.
    const stdin = [
      spec.system,
      '',
      ...spec.messages.map((message) =>
        message.role === 'assistant' ? `Assistant: ${message.content}` : message.content,
      ),
    ].join('\n');

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.command, args, {
        // No shell, on any platform. Both CLIs ship as real executables, and
        // Windows' CreateProcess appends `.exe` when resolving a bare name, so
        // a shell buys nothing here and would make every argv element a
        // quoting question. An install that is only a `.cmd` shim will fail to
        // spawn and be reported as "not on PATH" — the right trade: a clear,
        // actionable failure instead of an injection surface.
        shell: false,
        cwd: this.cwd,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(new AITimeoutError(this.timeoutMs));
      }, this.timeoutMs);

      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new AIResponseError('The CLI returned more output than expected.'));
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(
          error.code === 'ENOENT'
            ? new AIUnavailableError(
                `\`${this.displayName}\` is not installed, or not on this server's PATH.`,
              )
            : new AIUnavailableError(`Could not start \`${this.displayName}\`: ${error.message}`),
        );
      });

      child.on('close', (code) => {
        if (code === 0) return finish(null, stdout);

        // A non-zero exit with nothing on stdout usually means auth: the CLI
        // is installed but not signed in. Say that, rather than "exit code 1".
        const detail = (stderr || stdout).trim().slice(0, 400);
        finish(
          /not logged in|unauthor|authenticat|\/login/i.test(detail)
            ? new AIAuthError(`${this.displayName} is not signed in. Run \`${this.displayName}\` once to log in.`)
            : new AIUnavailableError(detail || `${this.displayName} exited with code ${code}.`),
        );
      });

      child.stdin.on('error', () => {
        // The child can exit before stdin is fully written; `close` reports it.
      });
      child.stdin.end(stdin);
    });
  }

  private async runText(spec: PromptSpec): Promise<string> {
    const raw = await this.spawnCli(spec);

    if (this.variant === 'claude-code') {
      let payload: ClaudeCodeResult;
      try {
        payload = JSON.parse(raw) as ClaudeCodeResult;
      } catch {
        throw new AIResponseError('Claude Code returned output that could not be parsed.');
      }

      // `is_error` is the real signal — `subtype` still reads "success" on a
      // failed run, and `result` carries the human-readable reason.
      if (payload.is_error) {
        const message = payload.result?.trim() || 'Claude Code reported an error.';
        throw /not logged in|\/login/i.test(message) ? new AIAuthError(message) : new AIResponseError(message);
      }

      const text = payload.result?.trim();
      if (!text) throw new AIResponseError('Claude Code returned no content.');
      return text;
    }

    const text = raw.trim();
    if (!text) throw new AIResponseError(`${this.displayName} returned no content.`);
    return text;
  }

  private async runStructured<T>(spec: PromptSpec): Promise<T> {
    // The schema goes in the prompt, not on the command line — a JSON schema in
    // argv would mean braces and quotes there, which the security model forbids.
    //
    // Naming the exact properties is not optional. Asked only for "a single
    // JSON object", these models return well-formed JSON with their own field
    // names (`steps`/`label`/`estimate_minutes` instead of
    // `subtasks`/`title`/`estimatedMinutes`), which parses fine and then fails
    // every downstream check. The HTTP adapters get this enforcement from the
    // provider; here it has to be asked for explicitly.
    const schemaHint = spec.outputSchema
      ? `\n\nThe object must match this JSON Schema exactly, using these exact property names:\n${JSON.stringify(spec.outputSchema)}`
      : '';

    const text = await this.runText({
      ...spec,
      system:
        `${spec.system}\n\nReply with a single JSON object and nothing else. ` +
        `No prose, no code fences.${schemaHint}`,
    });

    try {
      return JSON.parse(extractJson(text)) as T;
    } catch {
      throw new AIResponseError('CLI response was not valid JSON');
    }
  }
}

/** Recover a JSON object from a reply that may be wrapped in prose or a fence. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) return candidate.slice(start, end + 1);

  return candidate;
}

function clampMinutes(value: unknown): number {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 15;
  return Math.min(480, Math.max(5, minutes));
}
