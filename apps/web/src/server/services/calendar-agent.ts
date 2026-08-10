/**
 * The calendar action executor.
 *
 * This is the companion the brief calls for: the AI never touches the calendar
 * itself. It proposes actions, `@fluid/core`'s validator rules on each one, and
 * only this module writes — through the repository, and eventually through the
 * sync adapters. There is deliberately no code path from a model response to a
 * provider adapter that does not pass through here.
 *
 * Everything that happens, and everything that was refused, lands in the
 * `AiAction` log with a plain-language reason and enough before-state to undo
 * that single action later. Reverting the third change from an hour ago must
 * not require unwinding the two after it.
 */
import 'server-only';
import {
  planActions,
  plan as runScheduler,
  scopeWindow,
  type ActionContext,
  type ActionScope,
  type AutonomyLevel,
  type CalendarAction,
  type SchedulableTask,
} from '@fluid/core';
import { prisma, type AiActionKind, type AiActionStatus } from '@fluid/db';

export interface ReflowResult {
  batchId: string;
  applied: number;
  proposed: number;
  blocked: number;
  autonomy: AutonomyLevel;
  scope: ActionScope;
  /** Seconds the undo stays open. 0 when the level does not use an undo window. */
  undoWindowSeconds: number;
}

/**
 * Recompute the schedule and act on the difference, within the user's
 * autonomy setting.
 *
 * The deterministic scheduler decides *what* the calendar should look like;
 * this turns that into discrete actions and submits each one to the gate. An
 * action the gate refuses is recorded and dropped — never retried, never
 * downgraded into something that would slip past.
 */
export async function reflow(userId: string, trigger: string): Promise<ReflowResult> {
  const now = new Date();
  const batchId = crypto.randomUUID();

  // Supersede any draft plan still awaiting a decision.
  //
  // `plan.build` and this function are two writers over the same table: the
  // former leaves PROPOSED blocks pending a yes/no, the latter produces the
  // authoritative schedule. Without this, running both stacks two copies of
  // every block — one proposed, one accepted — and the calendar shows the same
  // task twice at different times. The agent's plan wins; stale drafts go.
  await prisma.$transaction([
    prisma.planVersion.updateMany({
      where: { userId, status: 'PROPOSED' },
      data: { status: 'SUPERSEDED', respondedAt: now },
    }),
    prisma.scheduledBlock.deleteMany({
      where: { task: { userId }, state: 'PROPOSED', isPinned: false },
    }),
  ]);

  const [user, tasks, workingHours, energyWindows, protectedTimes, externalEvents, blocks] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { preferences: true },
      }),
      prisma.task.findMany({
        where: { userId, status: { in: ['READY', 'IN_PROGRESS'] }, completedAt: null },
        include: { blockedBy: true },
      }),
      prisma.workingHours.findMany({ where: { userId } }),
      prisma.energyWindow.findMany({ where: { userId } }),
      prisma.protectedTime.findMany({ where: { userId } }),
      prisma.event.findMany({
        where: {
          calendar: { userId, isSelected: true },
          origin: 'EXTERNAL',
          deletedAt: null,
          status: { not: 'CANCELLED' },
          transparency: 'BUSY',
          endsAt: { gt: now },
        },
      }),
      prisma.scheduledBlock.findMany({
        where: { task: { userId }, state: 'ACCEPTED', endsAt: { gt: now } },
        include: { task: { select: { title: true } } },
      }),
    ]);

  const autonomy: AutonomyLevel = user.preferences?.aiAutonomy ?? 'AUTO_WITH_UNDO';
  const scope: ActionScope = user.preferences?.aiActionScope ?? 'TODAY';
  const undoWindowSeconds = user.preferences?.undoWindowSeconds ?? 30;

  const context: ActionContext = {
    now,
    timeZone: user.timeZone,
    scope,
    workingHours,
    protectedTimes,
    external: externalEvents.map((event) => ({ start: event.startsAt, end: event.endsAt })),
    ownedBlocks: blocks.map((block) => ({
      blockId: block.id,
      taskId: block.taskId,
      start: block.startsAt,
      end: block.endsAt,
      isPinned: block.isPinned,
    })),
  };

  // --- What should the calendar look like? --------------------------------
  const schedulable: SchedulableTask[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    remainingMinutes: Math.max(5, task.estimateMinutes - task.actualMinutes),
    priority: task.priority,
    energy: task.energy,
    ...(task.deadline ? { deadline: task.deadline } : {}),
    ...(task.earliestStart ? { earliestStart: task.earliestStart } : {}),
    isSplittable: task.isSplittable,
    minChunkMinutes: task.minChunkMinutes,
    maxChunkMinutes: task.maxChunkMinutes,
    dependsOn: task.blockedBy.map((dependency) => dependency.prerequisiteId),
  }));

  const window = scopeWindow(context);

  const desired = runScheduler({
    now,
    timeZone: user.timeZone,
    horizonDays: scope === 'TODAY' ? 1 : 7,
    tasks: schedulable,
    busy: context.external,
    pinned: context.ownedBlocks
      .filter((block) => block.isPinned)
      .map((block) => ({
        taskId: block.taskId,
        blockId: block.blockId,
        start: block.start,
        end: block.end,
      })),
    workingHours,
    energyWindows,
    protectedTimes,
    preferences: {
      bufferMinutes: user.preferences?.bufferMinutes ?? 10,
      slotGranularityMinutes: 15,
    },
    previous: context.ownedBlocks
      .filter((block) => !block.isPinned)
      .map((block, index) => ({
        taskId: block.taskId,
        start: block.start,
        end: block.end,
        isPinned: false,
        chunkIndex: index + 1,
        chunkCount: 1,
      })),
  });

  // --- Turn the difference into discrete actions ---------------------------
  const actions: CalendarAction[] = [];
  const movable = context.ownedBlocks.filter(
    (block) => !block.isPinned && block.start >= window.start && block.end <= window.end,
  );
  const claimed = new Set<string>();

  for (const wanted of desired.blocks) {
    if (wanted.isPinned) continue;
    if (wanted.start < window.start || wanted.end > window.end) continue;

    // Prefer to move an existing block for this task rather than delete and
    // recreate: reusing the row keeps the calendar event's identity stable, so
    // the user's own calendar does not show a delete followed by an add.
    const existing = movable.find(
      (block) => block.taskId === wanted.taskId && !claimed.has(block.blockId),
    );

    if (!existing) {
      actions.push({
        type: 'CREATE_BLOCK',
        taskId: wanted.taskId,
        start: wanted.start,
        end: wanted.end,
        reason: `Scheduled to fit around your other commitments (${trigger.replace(/_/g, ' ')}).`,
      });
      continue;
    }

    claimed.add(existing.blockId);

    const sameStart = existing.start.getTime() === wanted.start.getTime();
    const sameEnd = existing.end.getTime() === wanted.end.getTime();
    if (sameStart && sameEnd) continue; // Nothing to do — stability preserved.

    if (sameStart) {
      actions.push({
        type: 'RESIZE_BLOCK',
        blockId: existing.blockId,
        end: wanted.end,
        reason: 'Length adjusted to match the time this still needs.',
      });
    } else {
      actions.push({
        type: 'MOVE_BLOCK',
        blockId: existing.blockId,
        start: wanted.start,
        end: wanted.end,
        reason: `Moved to keep the day workable (${trigger.replace(/_/g, ' ')}).`,
      });
    }
  }

  // A block the new plan no longer wants is proposed for removal — never
  // deleted outright, because deletion is a hard boundary in the validator.
  for (const block of movable) {
    if (claimed.has(block.blockId)) continue;
    actions.push({
      type: 'DELETE_BLOCK',
      blockId: block.blockId,
      reason: 'The new plan does not need this session any more.',
    });
  }

  // --- Gate, then apply ----------------------------------------------------
  const { outcomes, droppedForLimit } = planActions(actions, context, autonomy);

  let applied = 0;
  let proposed = 0;
  let blocked = 0;

  const undoExpiresAt =
    autonomy === 'AUTO_WITH_UNDO' ? new Date(now.getTime() + undoWindowSeconds * 1000) : null;

  for (const outcome of outcomes) {
    const kind = outcome.action.type as AiActionKind;
    const blockId = 'blockId' in outcome.action ? outcome.action.blockId : null;
    const taskId = 'taskId' in outcome.action ? outcome.action.taskId : null;

    const before =
      blockId != null
        ? blocks.find((candidate) => candidate.id === blockId)
        : undefined;

    const beforeState = before
      ? { startsAt: before.startsAt.toISOString(), endsAt: before.endsAt.toISOString() }
      : null;

    let status: AiActionStatus;

    if (outcome.disposition === 'BLOCKED') {
      status = 'BLOCKED';
      blocked += 1;
    } else if (outcome.disposition === 'PROPOSE') {
      status = 'PROPOSED';
      proposed += 1;
    } else {
      await applyAction(outcome.action, userId);
      status = 'APPLIED';
      applied += 1;
    }

    await prisma.aiAction.create({
      data: {
        userId,
        kind,
        status,
        blockId,
        taskId,
        reason: outcome.action.reason,
        explanation:
          outcome.verdict.decision === 'ALLOW' ? null : outcome.verdict.explanation,
        boundary: outcome.verdict.decision === 'ALLOW' ? null : outcome.verdict.boundary,
        beforeState: beforeState ?? undefined,
        afterState:
          status === 'APPLIED' && 'start' in outcome.action
            ? {
                startsAt: outcome.action.start.toISOString(),
                endsAt: outcome.action.end.toISOString(),
              }
            : undefined,
        batchId,
        scope,
        undoExpiresAt: status === 'APPLIED' ? undoExpiresAt : null,
      },
    });
  }

  if (droppedForLimit.length > 0) {
    // Recorded rather than silently discarded: hitting the cap is a fact about
    // the plan the user should be able to see.
    await prisma.aiAction.create({
      data: {
        userId,
        kind: 'MOVE_BLOCK',
        status: 'BLOCKED',
        reason: `${droppedForLimit.length} further change(s) were not attempted.`,
        explanation:
          'A single pass is capped so an automated replan cannot rewrite large stretches of ' +
          'your calendar at once. Run it again to continue.',
        boundary: 'RATE_LIMIT',
        batchId,
        scope,
      },
    });
  }

  return { batchId, applied, proposed, blocked, autonomy, scope, undoWindowSeconds };
}

/**
 * Write a single validated action.
 *
 * Private on purpose: it performs no checks of its own and must only ever be
 * reached with a verdict from the validator. Exporting it would create exactly
 * the bypass this module exists to prevent.
 */
async function applyAction(action: CalendarAction, userId: string): Promise<void> {
  switch (action.type) {
    case 'CREATE_BLOCK':
      await prisma.scheduledBlock.create({
        data: {
          taskId: action.taskId,
          startsAt: action.start,
          endsAt: action.end,
          state: 'ACCEPTED',
        },
      });
      return;

    case 'MOVE_BLOCK':
      // Scoped by userId so a stale or forged id cannot reach another account.
      await prisma.scheduledBlock.updateMany({
        where: { id: action.blockId, task: { userId } },
        data: { startsAt: action.start, endsAt: action.end },
      });
      return;

    case 'RESIZE_BLOCK':
      await prisma.scheduledBlock.updateMany({
        where: { id: action.blockId, task: { userId } },
        data: { endsAt: action.end },
      });
      return;

    case 'DELETE_BLOCK':
      // Unreachable: deletion always returns NEEDS_CONFIRMATION, so it is
      // never dispatched here automatically. Kept explicit so the switch stays
      // exhaustive and a future change has to think about it.
      throw new Error('Deletion requires explicit confirmation and is never applied automatically');
  }
}

/**
 * Undo one previously applied action, by id.
 *
 * Per-entry rather than a stack: the brief asks for a revert on each log line,
 * not just the most recent one, and "undo the thing I disagree with without
 * losing the four good changes after it" is the behaviour that actually
 * restores a sense of control.
 */
export async function revertAiAction(userId: string, actionId: string): Promise<void> {
  const action = await prisma.aiAction.findFirst({
    where: { id: actionId, userId, status: 'APPLIED' },
  });
  if (!action) return;

  const before = action.beforeState as { startsAt?: string; endsAt?: string } | null;

  if (action.kind === 'CREATE_BLOCK' && action.blockId) {
    await prisma.scheduledBlock.deleteMany({
      where: { id: action.blockId, task: { userId } },
    });
  } else if (before?.startsAt && before?.endsAt && action.blockId) {
    await prisma.scheduledBlock.updateMany({
      where: { id: action.blockId, task: { userId } },
      data: { startsAt: new Date(before.startsAt), endsAt: new Date(before.endsAt) },
    });
  }

  await prisma.aiAction.update({
    where: { id: action.id },
    data: { status: 'REVERTED', revertedAt: new Date() },
  });
}

/** Accept a proposal the AI was not permitted to apply on its own. */
export async function confirmAiAction(userId: string, actionId: string): Promise<void> {
  const action = await prisma.aiAction.findFirst({
    where: { id: actionId, userId, status: 'PROPOSED' },
  });
  if (!action || !action.blockId) return;

  // The user is the authority here, so this is the one path that may perform a
  // deletion — and only for a block the AI created, which the validator
  // already established when it recorded the proposal.
  if (action.kind === 'DELETE_BLOCK') {
    await prisma.scheduledBlock.deleteMany({
      where: { id: action.blockId, task: { userId } },
    });
  } else {
    const after = action.afterState as { startsAt?: string; endsAt?: string } | null;
    if (after?.startsAt && after?.endsAt) {
      await prisma.scheduledBlock.updateMany({
        where: { id: action.blockId, task: { userId } },
        data: { startsAt: new Date(after.startsAt), endsAt: new Date(after.endsAt) },
      });
    }
  }

  await prisma.aiAction.update({ where: { id: action.id }, data: { status: 'APPLIED' } });
}

export async function rejectAiAction(userId: string, actionId: string): Promise<void> {
  await prisma.aiAction.updateMany({
    where: { id: actionId, userId, status: 'PROPOSED' },
    data: { status: 'REJECTED' },
  });
}
