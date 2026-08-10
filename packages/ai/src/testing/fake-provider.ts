/**
 * A scriptable AI provider for tests.
 *
 * Lets the fallback and validation paths be exercised without a network call or
 * an API key — including the cases that matter most: a provider that times out,
 * one that returns malformed output, and one that has been fed an injected
 * instruction through a calendar invite.
 */
import type {
  AIProvider,
  AvoidanceHistory,
  Insight,
  PromptMessage,
  ScheduleSuggestion,
  SchedulingContext,
  Subtask,
  TaskBreakdownRequest,
} from '../provider';
import { AITimeoutError, AIUnavailableError } from '../provider';

export interface FakeProviderOptions {
  /** Fail every call with this error. */
  failWith?: 'timeout' | 'unavailable';
  /** Never resolve, so the caller's timeout is what ends the call. */
  hang?: boolean;
  /** Override the schedule suggestion, e.g. to return refs that do not exist. */
  scheduleSuggestion?: ScheduleSuggestion;
  breakdown?: Subtask[];
  insights?: Insight[];
}

export class FakeAIProvider implements AIProvider {
  readonly kind = 'LOCAL' as const;
  readonly model = 'fake-model';

  /** Everything the provider was asked, so tests can assert on redaction. */
  readonly received: {
    schedulingContexts: SchedulingContext[];
    breakdowns: TaskBreakdownRequest[];
    histories: AvoidanceHistory[];
  } = { schedulingContexts: [], breakdowns: [], histories: [] };

  constructor(private readonly options: FakeProviderOptions = {}) {}

  private async guard(): Promise<void> {
    if (this.options.hang) await new Promise(() => {});
    if (this.options.failWith === 'timeout') throw new AITimeoutError(1000);
    if (this.options.failWith === 'unavailable') throw new AIUnavailableError();
  }

  async generateScheduleSuggestion(context: SchedulingContext): Promise<ScheduleSuggestion> {
    this.received.schedulingContexts.push(context);
    await this.guard();

    if (this.options.scheduleSuggestion) return this.options.scheduleSuggestion;

    // Default: echo the tasks back, deadline-first.
    const ordered = [...context.taskRefs].sort(
      (a, b) => (a.deadlineInDays ?? 999) - (b.deadlineInDays ?? 999),
    );

    return {
      placements: ordered.map((task, index) => ({
        ref: task.ref,
        startsInHours: index * 2,
        durationMinutes: task.estimatedMinutes,
        rationale: `Scheduled by deadline order (position ${index + 1}).`,
      })),
    };
  }

  async breakdownTask(request: TaskBreakdownRequest): Promise<Subtask[]> {
    this.received.breakdowns.push(request);
    await this.guard();

    if (this.options.breakdown) return this.options.breakdown;

    return [
      { title: 'Open the document and write one sentence', estimatedMinutes: 5, isStarterStep: true },
      {
        title: 'Draft the main section',
        estimatedMinutes: Math.max(10, request.estimatedMinutes - 15),
        isStarterStep: false,
      },
      { title: 'Read it back and tidy up', estimatedMinutes: 10, isStarterStep: false },
    ];
  }

  async detectAvoidancePattern(history: AvoidanceHistory): Promise<Insight[]> {
    this.received.histories.push(history);
    await this.guard();

    if (this.options.insights) return this.options.insights;

    return history.tasks
      .filter((task) => task.rescheduleCount >= 3)
      .map((task) => ({
        ref: task.ref,
        observation: `This one has moved ${task.rescheduleCount} times.`,
        suggestion: 'Want to shrink it to a 10-minute version, or talk through what is in the way?',
        confidence: 'medium' as const,
      }));
  }

  async chatRespond(
    messages: PromptMessage[],
    _context: SchedulingContext,
  ): Promise<PromptMessage> {
    await this.guard();
    return { role: 'assistant', content: `Acknowledged ${messages.length} message(s).` };
  }

  async healthCheck(): Promise<boolean> {
    return !this.options.failWith && !this.options.hang;
  }
}
