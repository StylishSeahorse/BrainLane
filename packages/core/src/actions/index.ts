/**
 * Calendar action validation — the gate every autonomous AI change goes through.
 *
 * The brief's requirement is that the AI can act on the calendar directly, not
 * merely advise. That is a real capability increase, so the guardrails have to
 * be real too: this module is what stands between "the model proposed
 * something" and "the user's calendar changed".
 *
 * It is deliberately pure. Given a proposed action and a snapshot of the
 * user's world, it returns one of three verdicts and never touches anything —
 * so every boundary in the brief is testable exhaustively, offline, in
 * milliseconds. Execution lives in the app layer and may only proceed on a
 * verdict produced here.
 *
 * The three verdicts:
 *
 *   ALLOW               Safe to apply, subject to the autonomy level.
 *   NEEDS_CONFIRMATION  A hard boundary from the brief. The AI may propose it
 *                       but never perform it unattended, no matter how much
 *                       autonomy the user has granted.
 *   REFUSE              Not available at any autonomy level. Protected time,
 *                       events the AI does not own, and blocks the user pinned
 *                       by hand are simply not the AI's to touch.
 *
 * REFUSE is not a stricter NEEDS_CONFIRMATION. Confirmation means "ask the
 * user"; refusal means the action is outside the AI's authority entirely, and
 * offering it as a prompt would train people to click through the one dialog
 * that should never appear.
 */
import {
  buildAvailability,
  expandProtectedTimes,
} from '../scheduler/availability';
import { mergeIntervals, overlaps } from '../scheduler/intervals';
import type { Interval, ProtectedTimeRule, WorkingHoursRule } from '../scheduler/types';
import { DAY_MS, startOfLocalDay } from '../time/zoned';

/** How much freedom the user has granted the AI. Their choice, not ours. */
export type AutonomyLevel =
  /** Act immediately; tell the user afterwards. */
  | 'FULL_AUTO'
  /** Act immediately, but keep a one-tap undo open for a while. */
  | 'AUTO_WITH_UNDO'
  /** Draft it; nothing is written until the user says yes. */
  | 'PROPOSE_THEN_CONFIRM';

/**
 * How much of the calendar one pass may rewrite.
 *
 * A cap exists so a single bad plan cannot quietly restructure a month. The
 * blast radius of an automated change should be something a person can hold in
 * their head and check.
 */
export type ActionScope = 'TODAY' | 'THIS_WEEK';

/** Default ceiling on actions per pass, independent of scope. */
export const MAX_ACTIONS_PER_PASS = 20;

/** A block the AI created and therefore may manage. */
export interface OwnedBlock {
  blockId: string;
  taskId: string;
  start: Date;
  end: Date;
  /** The user moved this by hand. Their decision outranks the scheduler's. */
  isPinned: boolean;
}

export type CalendarAction =
  | { type: 'CREATE_BLOCK'; taskId: string; start: Date; end: Date; reason: string }
  | { type: 'MOVE_BLOCK'; blockId: string; start: Date; end: Date; reason: string }
  | { type: 'RESIZE_BLOCK'; blockId: string; end: Date; reason: string }
  | { type: 'DELETE_BLOCK'; blockId: string; reason: string };

export type Boundary =
  /** Targets something the AI did not create. */
  | 'NOT_OWNED'
  /** The user pinned this block by hand. */
  | 'PINNED'
  /** Overlaps protected or hyperfocus time. */
  | 'PROTECTED_TIME'
  /** Falls outside the window this pass is allowed to touch. */
  | 'OUTSIDE_SCOPE'
  /** Would land outside the user's declared working hours. */
  | 'OUTSIDE_WORKING_HOURS'
  /** Would sit on top of an existing commitment. */
  | 'DOUBLE_BOOKING'
  /** Outright deletion, as opposed to moving. */
  | 'DELETION'
  /** Nonsensical or zero-length time range. */
  | 'INVALID_RANGE';

export type ActionVerdict =
  | { decision: 'ALLOW' }
  | { decision: 'NEEDS_CONFIRMATION'; boundary: Boundary; explanation: string }
  | { decision: 'REFUSE'; boundary: Boundary; explanation: string };

export interface ActionContext {
  now: Date;
  timeZone: string;
  scope: ActionScope;
  workingHours: WorkingHoursRule[];
  protectedTimes: ProtectedTimeRule[];
  /**
   * Busy time the AI does not own — external meetings, and anything on a
   * calendar it did not create. Read-only by definition.
   */
  external: Interval[];
  /** Blocks the AI created, and may therefore manage. */
  ownedBlocks: OwnedBlock[];
}

/** The window a pass of the given scope is permitted to touch. */
export function scopeWindow(context: Pick<ActionContext, 'now' | 'timeZone' | 'scope'>): Interval {
  const start = startOfLocalDay(context.now, context.timeZone);
  const days = context.scope === 'TODAY' ? 1 : 7;
  return { start, end: new Date(start.getTime() + days * DAY_MS) };
}

/** The interval an action would occupy after it is applied, if any. */
function targetInterval(action: CalendarAction, block?: OwnedBlock): Interval | null {
  switch (action.type) {
    case 'CREATE_BLOCK':
      return { start: action.start, end: action.end };
    case 'MOVE_BLOCK':
      return { start: action.start, end: action.end };
    case 'RESIZE_BLOCK':
      return block ? { start: block.start, end: action.end } : null;
    case 'DELETE_BLOCK':
      return block ? { start: block.start, end: block.end } : null;
  }
}

/**
 * Decide whether a single action may be applied.
 *
 * Check order matters and is not arbitrary: authority questions ("is this
 * yours to touch?") come before safety questions ("is this a good idea?"). An
 * action targeting someone else's meeting is refused on ownership grounds
 * rather than being reported as a double-booking, so the explanation the user
 * reads names the real reason.
 */
export function validateAction(action: CalendarAction, context: ActionContext): ActionVerdict {
  const blocksById = new Map(context.ownedBlocks.map((block) => [block.blockId, block]));

  // --- 1. Ownership ---------------------------------------------------------
  if (action.type !== 'CREATE_BLOCK') {
    const block = blocksById.get(action.blockId);

    if (!block) {
      return {
        decision: 'REFUSE',
        boundary: 'NOT_OWNED',
        explanation:
          'This is not a block Fluid created, so it is read-only. Meetings and events from ' +
          'other people are never rearranged automatically.',
      };
    }

    if (block.isPinned) {
      return {
        decision: 'REFUSE',
        boundary: 'PINNED',
        explanation: 'You placed this block yourself, so it stays where you put it.',
      };
    }
  }

  const block = action.type === 'CREATE_BLOCK' ? undefined : blocksById.get(action.blockId);
  const interval = targetInterval(action, block);

  if (!interval || interval.end <= interval.start) {
    return {
      decision: 'REFUSE',
      boundary: 'INVALID_RANGE',
      explanation: 'That change would leave the block with no length.',
    };
  }

  // --- 2. Blast radius ------------------------------------------------------
  const window = scopeWindow(context);
  const current = block ? { start: block.start, end: block.end } : interval;

  // Both where it is now and where it would end up must be inside the window,
  // so a "reflow today" pass cannot reach into next week in either direction.
  if (
    interval.start < window.start ||
    interval.end > window.end ||
    current.start < window.start ||
    current.end > window.end
  ) {
    return {
      decision: 'REFUSE',
      boundary: 'OUTSIDE_SCOPE',
      explanation:
        context.scope === 'TODAY'
          ? 'This pass is only allowed to rearrange today.'
          : 'This pass is only allowed to rearrange this week.',
    };
  }

  // --- 3. Protected time ----------------------------------------------------
  // Inviolable at every autonomy level. Hyperfocus needs protecting *from* the
  // scheduler, which is the whole reason the category exists.
  const protectedIntervals = expandProtectedTimes(context.protectedTimes, window, context.timeZone);

  if (action.type !== 'DELETE_BLOCK' && protectedIntervals.some((p) => overlaps(p, interval))) {
    return {
      decision: 'REFUSE',
      boundary: 'PROTECTED_TIME',
      explanation: 'That lands on protected time, which is never scheduled over.',
    };
  }

  // --- 4. Hard boundaries: allowed, but only with a person in the loop ------
  if (action.type === 'DELETE_BLOCK') {
    return {
      decision: 'NEEDS_CONFIRMATION',
      boundary: 'DELETION',
      explanation:
        'Removing work from the calendar entirely is always your call. Moving it is not — ' +
        'that happens automatically.',
    };
  }

  const availability = buildAvailability({
    now: window.start,
    timeZone: context.timeZone,
    horizonDays: context.scope === 'TODAY' ? 1 : 7,
    workingHours: context.workingHours,
    protectedTimes: [],
    busy: [],
  });

  const insideWorkingHours = availability.workable.some(
    (slot) => slot.start <= interval.start && interval.end <= slot.end,
  );

  if (!insideWorkingHours) {
    return {
      decision: 'NEEDS_CONFIRMATION',
      boundary: 'OUTSIDE_WORKING_HOURS',
      explanation: 'That falls outside your working hours, so it needs your say-so.',
    };
  }

  const occupied = mergeIntervals([
    ...context.external,
    // Every other block we own also occupies time; only the block being moved
    // is exempt from colliding with itself.
    ...context.ownedBlocks
      .filter((candidate) => candidate.blockId !== block?.blockId)
      .map((candidate) => ({ start: candidate.start, end: candidate.end })),
  ]);

  if (occupied.some((busy) => overlaps(busy, interval))) {
    return {
      decision: 'NEEDS_CONFIRMATION',
      boundary: 'DOUBLE_BOOKING',
      explanation: 'That would sit on top of something already booked.',
    };
  }

  return { decision: 'ALLOW' };
}

/** What will actually happen to an action, once autonomy is taken into account. */
export type Disposition =
  /** Apply now, tell the user afterwards. */
  | 'EXECUTE'
  /** Apply now, keep an undo open. */
  | 'EXECUTE_WITH_UNDO'
  /** Write nothing; show it and wait. */
  | 'PROPOSE'
  /** Not happening. */
  | 'BLOCKED';

export interface ActionOutcome {
  action: CalendarAction;
  verdict: ActionVerdict;
  disposition: Disposition;
}

function dispositionFor(verdict: ActionVerdict, autonomy: AutonomyLevel): Disposition {
  if (verdict.decision === 'REFUSE') return 'BLOCKED';

  // A hard boundary always goes to the user, whatever autonomy was granted.
  // This is the line "full auto" does not cross — without it, the setting
  // would quietly mean "delete my events without asking".
  if (verdict.decision === 'NEEDS_CONFIRMATION') return 'PROPOSE';

  switch (autonomy) {
    case 'FULL_AUTO':
      return 'EXECUTE';
    case 'AUTO_WITH_UNDO':
      return 'EXECUTE_WITH_UNDO';
    case 'PROPOSE_THEN_CONFIRM':
      return 'PROPOSE';
  }
}

export interface PlanActionsResult {
  outcomes: ActionOutcome[];
  /** Dropped because the per-pass cap was reached, not because they were unsafe. */
  droppedForLimit: CalendarAction[];
}

/**
 * Validate a batch of proposed actions.
 *
 * Actions are checked against a context that is *not* updated as the batch
 * proceeds — each is judged against the world as it stands now. That is the
 * conservative reading: a batch where action 3 only becomes legal because
 * actions 1 and 2 already landed is exactly the kind of compounding change
 * that should be re-planned and shown afresh, not waved through.
 */
export function planActions(
  actions: CalendarAction[],
  context: ActionContext,
  autonomy: AutonomyLevel,
  maxActions: number = MAX_ACTIONS_PER_PASS,
): PlanActionsResult {
  const allowed = actions.slice(0, Math.max(0, maxActions));
  const droppedForLimit = actions.slice(allowed.length);

  const outcomes = allowed.map((action) => {
    const verdict = validateAction(action, context);
    return { action, verdict, disposition: dispositionFor(verdict, autonomy) };
  });

  return { outcomes, droppedForLimit };
}
