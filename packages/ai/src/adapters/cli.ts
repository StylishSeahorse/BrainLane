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
 * 1. TOOLS OFF. Claude Code can read files and run shell commands. Handing it
 *    an injected prompt with tools enabled turns "someone sent me a calendar
 *    invite" into arbitrary code execution. `--tools ""` disables all of them.
 *    This is not a tuning knob — do not remove it.
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
  private readonly variant: CliVariant;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;

  constructor(options: CliAdapterOptions) {
    this.command = options.command;
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
  private buildArgs(spec: PromptSpec): string[] {
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

    // Codex: `codex exec` is its documented non-interactive command. Kept
    // minimal deliberately — this variant is unverified, and every flag added
    // blind is a flag that can fail on a version we have not seen.
    const args = ['exec'];
    if (this.model) args.push('--model', this.model);
    return args;
  }

  private async spawnCli(spec: PromptSpec): Promise<string> {
    const args = this.buildArgs(spec);

    // Belt and braces: nothing should reach argv that fails the allowlist, so
    // if anything does, that is a bug and the request must not run.
    for (const arg of args) {
      if (arg !== '' && !arg.startsWith('--') && !SAFE_ARG.test(arg)) {
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
                `\`${this.command}\` is not installed, or not on this server's PATH.`,
              )
            : new AIUnavailableError(`Could not start \`${this.command}\`: ${error.message}`),
        );
      });

      child.on('close', (code) => {
        if (code === 0) return finish(null, stdout);

        // A non-zero exit with nothing on stdout usually means auth: the CLI
        // is installed but not signed in. Say that, rather than "exit code 1".
        const detail = (stderr || stdout).trim().slice(0, 400);
        finish(
          /not logged in|unauthor|authenticat|\/login/i.test(detail)
            ? new AIAuthError(`${this.command} is not signed in. Run \`${this.command}\` once to log in.`)
            : new AIUnavailableError(detail || `${this.command} exited with code ${code}.`),
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
    if (!text) throw new AIResponseError(`${this.command} returned no content.`);
    return text;
  }

  private async runStructured<T>(spec: PromptSpec): Promise<T> {
    // Structured output is requested in the prompt and recovered leniently,
    // rather than via a schema flag: a JSON schema on the command line would
    // put braces and quotes into argv, which the security model above forbids.
    const text = await this.runText({
      ...spec,
      system: `${spec.system}\n\nReply with a single JSON object and nothing else. No prose, no code fences.`,
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
