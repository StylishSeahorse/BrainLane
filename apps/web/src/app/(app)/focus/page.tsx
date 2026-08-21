import { prisma } from '@fluid/db';
import { startOfLocalDay } from '@fluid/core';
import { FlowMode, type FlowEntry } from '@/components/flow-mode';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Focus mode — the day as a sequence rather than a grid.
 *
 * Its own route, and deliberately outside the rhythm of the rest of the app:
 * no capacity meters, no backlog, no week. Those are planning tools, and
 * planning while working is just a socially acceptable way of not working.
 */
export default async function FocusPage() {
  const user = await requireUser();
  const caller = await getCaller();
  const timeZone = user.timeZone;

  const dayStart = startOfLocalDay(new Date(), timeZone);
  const dayEnd = startOfLocalDay(dayStart, timeZone, 1);

  const [{ blocks, events }, preferences] = await Promise.all([
    caller.plan.blocks({ from: dayStart, to: dayEnd }),
    prisma.userPreferences.findUnique({ where: { userId: user.id } }),
  ]);

  const entries: FlowEntry[] = [
    ...blocks.map((block) => ({
      id: block.id,
      taskId: block.task.id,
      title: block.task.title,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      isMeeting: false,
      // The task's status, not the block's — see `plan.blocks` for why those
      // two are allowed to disagree.
      isDone: block.task.status === 'DONE',
      startedAt: block.task.timerStartedAt,
      starterStep: block.task.starterStep,
      projectName: block.task.project?.name ?? null,
    })),
    // Only events that actually consume the time. A transparent "FYI" entry on
    // someone's calendar should not push their afternoon around.
    ...events
      .filter((event) => event.transparency === 'BUSY')
      .map((event) => ({
        id: event.id,
        taskId: null,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        isMeeting: true,
        isDone: event.endsAt <= new Date(),
        startedAt: null,
        starterStep: null,
        projectName: null,
      })),
  ];

  return (
    <FlowMode
      entries={entries}
      bufferMinutes={preferences?.bufferMinutes ?? 10}
      timeZone={timeZone}
      rhythm={{
        enabled: preferences?.pomodoroEnabled ?? true,
        workMinutes: preferences?.pomodoroWorkMinutes ?? 50,
        breakMinutes: preferences?.pomodoroBreakMinutes ?? 10,
      }}
    />
  );
}
