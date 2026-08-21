'use server';

/**
 * Server actions — the mutation surface for the UI.
 *
 * Each one runs the same tRPC procedure the HTTP API exposes, then revalidates.
 * Actions return a plain `{ error }` shape rather than throwing, because a
 * thrown error in a form is a blank screen, and a blank screen is where an
 * ADHD user loses the thread of what they were doing.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@fluid/db';
import { fakeVerify, hashPassword, validatePasswordLength, verifyPassword } from '@fluid/crypto';
import { z } from 'zod';
import { getCaller } from '@/server/caller';
import { createSession, destroySession, getCurrentUser } from '@/server/auth/session';

export type ActionState = { error?: string } | undefined;

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('That does not look like an email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signUp(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check your details.' };

  const lengthProblem = validatePasswordLength(parsed.data.password);
  if (lengthProblem) return { error: lengthProblem };

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    // Deliberately vague: confirming which addresses are registered turns the
    // signup form into an account-enumeration oracle.
    return { error: 'That address cannot be used. Try signing in instead.' };
  }

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      timeZone: 'UTC',
      preferences: { create: {} },
      aiSetting: { create: {} },
      workingHours: {
        create: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '09:00',
          endTime: '17:00',
        })),
      },
    },
  });

  await prisma.auditLog.create({
    data: { userId: user.id, action: 'user.signup' },
  });

  await createSession(user.id);
  redirect('/today');
}

export async function signIn(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'Check your email and password.' };

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Burn equivalent CPU when the account does not exist, so response timing
  // does not reveal which addresses are registered.
  if (!user?.passwordHash) {
    await fakeVerify();
    return { error: 'Those details did not match.' };
  }

  const ok = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!ok) {
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'user.signin.failed' },
    });
    return { error: 'Those details did not match.' };
  }

  await prisma.auditLog.create({ data: { userId: user.id, action: 'user.signin' } });
  await createSession(user.id);
  redirect('/today');
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/login');
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTask(_state: ActionState, formData: FormData): Promise<ActionState> {
  const caller = await getCaller();
  const deadlineRaw = String(formData.get('deadline') ?? '').trim();

  try {
    await caller.task.create({
      title: String(formData.get('title') ?? ''),
      notes: String(formData.get('notes') ?? '') || undefined,
      projectId: String(formData.get('projectId') ?? '') || null,
      priority: (formData.get('priority') as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT') ?? 'MEDIUM',
      energy: (formData.get('energy') as 'LOW' | 'MEDIUM' | 'HIGH') ?? 'MEDIUM',
      estimateMinutes: Number(formData.get('estimateMinutes') ?? 30),
      deadline: deadlineRaw ? new Date(deadlineRaw) : null,
      isSplittable: formData.get('isSplittable') !== 'off',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that task.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  return {};
}

export async function completeTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.complete({ id: String(formData.get('id')) });
  revalidatePath('/projects');
  revalidatePath('/today');
}

/** The `FormData` shape, for buttons that submit fields rather than an id. */
export async function uncompleteTaskAction(formData: FormData): Promise<{ error?: string }> {
  return uncompleteTask(String(formData.get('id')));
}

/** Reverses `completeTask`, including the side effects completing it had. */
export async function uncompleteTask(taskId: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.uncomplete({ id: taskId });
  } catch (error) {
    return { error: messageFrom(error, 'Could not bring that task back.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  return {};
}

export interface TaskEdit {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  energy: 'LOW' | 'MEDIUM' | 'HIGH';
  estimateMinutes: number;
  /** `datetime-local` string, or empty to clear the deadline. */
  deadline: string;
  isSplittable: boolean;
}

export async function updateTaskDetails(input: TaskEdit): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.update({
      id: input.id,
      title: input.title,
      notes: input.notes.trim() || undefined,
      projectId: input.projectId,
      priority: input.priority,
      energy: input.energy,
      estimateMinutes: input.estimateMinutes,
      deadline: input.deadline ? new Date(input.deadline) : null,
      isSplittable: input.isSplittable,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save those changes.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  return {};
}

export async function deleteTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.delete({ id: String(formData.get('id')) });
  revalidatePath('/projects');
}

export async function deferTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.defer({
    id: String(formData.get('id')),
    days: Number(formData.get('days') ?? 1),
  });
  revalidatePath('/projects');
  revalidatePath('/today');
}

export async function breakdownTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.breakdown({
    id: String(formData.get('id')),
    granularity: (formData.get('granularity') as 'tiny' | 'normal') ?? 'tiny',
  });
  revalidatePath('/projects');
  revalidatePath('/today');
}

export async function acknowledgeAvoidance(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.acknowledgeAvoidance({ id: String(formData.get('id')) });
  revalidatePath('/today');
}

export async function logTime(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.logTime({
    id: String(formData.get('id')),
    minutes: Number(formData.get('minutes') ?? 5),
  });
  revalidatePath('/today');
  revalidatePath('/projects');
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();
  try {
    await caller.project.create({
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? '') || undefined,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not create that project.') };
  }
  revalidatePath('/projects');
  return {};
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function rebuildPlan(): Promise<void> {
  const caller = await getCaller();
  await caller.plan.build({ trigger: 'manual' });
  revalidatePath('/today');
  revalidatePath('/week');
}

export async function acceptPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.accept({
    planVersionId: String(formData.get('planVersionId')),
    auto: formData.get('auto') === 'true',
  });
  revalidatePath('/today');
  revalidatePath('/week');
}

export async function rejectPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.reject({ planVersionId: String(formData.get('planVersionId')) });
  revalidatePath('/today');
  revalidatePath('/week');
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function updateAccessibility(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      highContrast: formData.get('highContrast') === 'on',
      reducedMotion: formData.get('reducedMotion') === 'on',
      dyslexiaFont: formData.get('dyslexiaFont') === 'on',
      largeText: formData.get('largeText') === 'on',
    },
    update: {
      highContrast: formData.get('highContrast') === 'on',
      reducedMotion: formData.get('reducedMotion') === 'on',
      dyslexiaFont: formData.get('dyslexiaFont') === 'on',
      largeText: formData.get('largeText') === 'on',
    },
  });

  revalidatePath('/', 'layout');
}

function messageFrom(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    // tRPC serializes Zod issues as JSON; show the first human sentence.
    try {
      const issues = JSON.parse(message) as Array<{ message?: string }>;
      if (Array.isArray(issues) && issues[0]?.message) return issues[0].message;
    } catch {
      if (message && message.length < 200) return message;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// AI calendar agent (§3.6)
// ---------------------------------------------------------------------------

export async function reflowSchedule(): Promise<void> {
  const caller = await getCaller();
  await caller.agent.reflow({ trigger: 'manual' });
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/review');
}

export async function revertAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.revert({ id: String(formData.get('id')) });
  revalidatePath('/review');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function confirmAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.confirm({ id: String(formData.get('id')) });
  revalidatePath('/review');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function rejectAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.reject({ id: String(formData.get('id')) });
  revalidatePath('/review');
}

export async function setAutonomy(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.setAutonomy({
    level: formData.get('level') as 'FULL_AUTO' | 'AUTO_WITH_UNDO' | 'PROPOSE_THEN_CONFIRM',
    scope: formData.get('scope') as 'TODAY' | 'THIS_WEEK',
    undoWindowSeconds: Number(formData.get('undoWindowSeconds') ?? 30),
  });
  revalidatePath('/settings');
}

// ---------------------------------------------------------------------------
// AI provider configuration
// ---------------------------------------------------------------------------

export async function saveAiSettings(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.ai.save({
      providerId: String(formData.get('providerId') ?? 'anthropic'),
      model: String(formData.get('model') ?? '').trim() || undefined,
      baseUrl: String(formData.get('baseUrl') ?? '').trim() || undefined,
      apiKey: String(formData.get('apiKey') ?? '').trim() || undefined,
      clearKey: formData.get('clearKey') === 'on',
      allowScheduling: formData.get('allowScheduling') === 'on',
      allowTaskBreakdown: formData.get('allowTaskBreakdown') === 'on',
      allowAvoidanceCheck: formData.get('allowAvoidanceCheck') === 'on',
      allowChat: formData.get('allowChat') === 'on',
      shareTaskText: formData.get('shareTaskText') === 'on',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save those AI settings.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function testAiConnection(): Promise<{ ok: boolean; message: string }> {
  const caller = await getCaller();
  return caller.ai.test();
}

export async function listAiModels(): Promise<string[]> {
  const caller = await getCaller();
  const result = await caller.ai.models();
  return result.models;
}

// ---------------------------------------------------------------------------
// Calendar connections
// ---------------------------------------------------------------------------

export async function connectCalendar(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.calendar.connect({
      serverUrl: String(formData.get('serverUrl') ?? '').trim(),
      username: String(formData.get('username') ?? '').trim(),
      password: String(formData.get('password') ?? ''),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not connect to that calendar server.') };
  }

  // Pull straight away, so the first thing someone sees after connecting is
  // their actual calendar rather than an empty week and a question about
  // whether it worked.
  try {
    await caller.calendar.sync();
  } catch {
    // A failed first sync is not a failed connection — the connection page
    // shows what happened, and Sync now retries it.
  }

  revalidatePath('/settings');
  revalidatePath('/week');
  return {};
}

export async function disconnectCalendar(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.disconnect({ connectionId: String(formData.get('connectionId')) });
  revalidatePath('/settings');
  revalidatePath('/week');
}

export async function syncCalendars(): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.sync();
  revalidatePath('/settings');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function setCalendarSelected(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.setSelected({
    calendarId: String(formData.get('calendarId')),
    isSelected: formData.get('isSelected') === 'on',
  });
  revalidatePath('/settings');
  revalidatePath('/week');
}

export async function setCalendarWriteTarget(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.setWriteTarget({ calendarId: String(formData.get('calendarId')) });
  revalidatePath('/settings');
}

export async function resumeCalendarSync(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.resume({ connectionId: String(formData.get('connectionId')) });
  revalidatePath('/settings');
}

// ---------------------------------------------------------------------------
// Dragging a block on the calendar grid
// ---------------------------------------------------------------------------

export async function moveScheduledBlock(input: {
  blockId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.plan.moveBlock(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that block.') };
  }

  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// Task timers
// ---------------------------------------------------------------------------

export async function startTaskTimer(
  taskId: string,
): Promise<{ startedAt?: Date; switchedFrom?: string | null; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.startTimer({ id: taskId });
    revalidatePath('/projects');
    revalidatePath('/today');
    return { startedAt: result.startedAt, switchedFrom: result.switchedFrom };
  } catch (error) {
    return { error: messageFrom(error, 'Could not start the timer.') };
  }
}

export async function stopTaskTimer(taskId: string): Promise<{ minutes?: number; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.stopTimer({ id: taskId });
    revalidatePath('/projects');
    revalidatePath('/today');
    return { minutes: result.minutes };
  } catch (error) {
    return { error: messageFrom(error, 'Could not stop the timer.') };
  }
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export async function createRoutine(input: {
  label: string;
  startTime: string;
  endTime: string;
  days: number[];
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.routine.create(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that routine.') };
  }

  revalidatePath('/week');
  return {};
}

export async function deleteRoutine(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.routine.delete({ groupId: String(formData.get('groupId')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that routine.') };
  }

  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// The day's rituals
// ---------------------------------------------------------------------------

export async function shutdownDay(input: {
  day: string;
  reflection: string;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.shutdown({
      day: new Date(input.day),
      ...(input.reflection.trim() ? { reflection: input.reflection.trim() } : {}),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not close the day.') };
  }

  revalidatePath('/today');
  return {};
}

export async function reopenDay(day: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.reopen({ day: new Date(day) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not reopen the day.') };
  }

  revalidatePath('/today');
  return {};
}

/** Push an unfinished task to tomorrow. Counts as a deferral, deliberately. */
export async function rolloverTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.defer({ id: String(formData.get('id')), days: 1 });
  revalidatePath('/today');
}

export async function archiveTask(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.archive({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that to the backlog.') };
  }

  revalidatePath('/today');
  revalidatePath('/projects');
  return {};
}

export async function unarchiveTask(id: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.unarchive({ id });
  } catch (error) {
    return { error: messageFrom(error, 'Could not bring that back.') };
  }

  revalidatePath('/today');
  revalidatePath('/projects');
  return {};
}

export async function setTaskBucket(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();
  const raw = String(formData.get('bucket'));

  try {
    await caller.task.setBucket({
      id: String(formData.get('id')),
      bucket: raw === '' ? null : (raw as 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY'),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that.') };
  }

  revalidatePath('/projects');
  return {};
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export async function createObjective(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.objective.create({
      title: String(formData.get('title') ?? ''),
      notes: String(formData.get('notes') ?? '') || undefined,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function setObjectiveAchieved(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.setAchieved({
      id: String(formData.get('id')),
      achieved: formData.get('achieved') === 'true',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not update that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function deleteObjective(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.delete({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function rollObjectiveForward(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.rollForward({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not carry that forward.') };
  }

  revalidatePath('/review');
  return {};
}

// ---------------------------------------------------------------------------
// Braindump
// ---------------------------------------------------------------------------

export interface BraindumpDraft {
  title: string;
  source: string;
  hints: string[];
  estimateMinutes?: number;
  bucket?: 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueInDays?: number;
}

/** What this kind of task has actually taken, from the user's own history. */
export async function suggestEstimate(title: string): Promise<{
  sampleCount: number;
  suggestion: { medianMinutes: number; averageMinutes: number } | null;
}> {
  const caller = await getCaller();
  const result = await caller.task.estimateSuggestion({ title });
  return { sampleCount: result.sampleCount, suggestion: result.suggestion };
}

export async function parseBraindumpText(text: string): Promise<BraindumpDraft[]> {
  const caller = await getCaller();
  return caller.task.parseBraindump({ text });
}

export async function commitBraindump(
  items: BraindumpDraft[],
): Promise<{ count?: number; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.commitBraindump({
      items: items.map((item) => ({
        title: item.title,
        estimateMinutes: item.estimateMinutes ?? 30,
        bucket: item.bucket ?? null,
        priority: item.priority ?? 'MEDIUM',
        dueInDays: item.dueInDays ?? null,
      })),
    });
    revalidatePath('/projects');
    revalidatePath('/today');
    return { count: result.count };
  } catch (error) {
    return { error: messageFrom(error, 'Could not create those tasks.') };
  }
}

// ---------------------------------------------------------------------------
// The week board
// ---------------------------------------------------------------------------

/**
 * Put a task on a day, move it between days, or return it to the backlog.
 *
 * `day` is a plain `YYYY-MM-DD` string rather than a Date: the board is a
 * client component, the columns are already keyed by local date, and sending
 * an instant would invite the browser's timezone to disagree with the user's.
 */
export async function commitTaskToDay(input: {
  taskId: string;
  day: string | null;
  position?: number;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.board.commit({
      taskId: input.taskId,
      day: input.day ? localDateToInstant(input.day) : null,
      // Passed through rather than defaulted: omitting it means "append",
      // which is a different instruction to "put it first".
      ...(input.position !== undefined ? { position: input.position } : {}),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that task.') };
  }

  revalidatePath('/week');
  revalidatePath('/today');
  return {};
}

export async function reorderBoardDay(input: {
  day: string;
  orderedIds: string[];
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.board.reorder({
      day: localDateToInstant(input.day),
      orderedIds: input.orderedIds,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not reorder that day.') };
  }

  revalidatePath('/week');
  return {};
}

export async function rolloverDay(formData: FormData): Promise<{ error?: string }> {
  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  if (!from || !to) return { error: 'Missing day.' };

  const caller = await getCaller();

  try {
    const result = await caller.board.rollover({
      from: localDateToInstant(from),
      to: localDateToInstant(to),
    });
    revalidatePath('/week');
    revalidatePath('/today');
    return result.moved === 0 ? { error: 'Nothing left to move.' } : {};
  } catch (error) {
    return { error: messageFrom(error, 'Could not move those tasks.') };
  }
}

/**
 * `YYYY-MM-DD` to the instant the server should treat as that local day.
 *
 * Noon, not midnight. The procedures normalise to local midnight themselves,
 * and probing from the middle of the day means a DST transition cannot land
 * the result on the day before.
 */
function localDateToInstant(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new Error('Bad date.');
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/** Record that the morning plan was completed, so the prompt stops asking. */
export async function markDayPlanned(day: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.markPlanned({ day: localDateToInstant(day) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save your plan.') };
  }

  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export async function createArea(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.area.create({
      name: String(formData.get('name') ?? ''),
      color: String(formData.get('color') ?? '') || null,
      // An unchecked checkbox is simply absent from the form data, so the
      // presence of the key *is* the answer.
      countsTowardCapacity: formData.get('countsTowardCapacity') !== null,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function updateArea(input: {
  id: string;
  name?: string;
  color?: string | null;
  countsTowardCapacity?: boolean;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.update(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not save that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function deleteArea(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.delete({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function assignTaskArea(
  taskId: string,
  areaId: string | null,
): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.assign({ taskId, areaId });
  } catch (error) {
    return { error: messageFrom(error, 'Could not change that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

/**
 * An area change moves the capacity arithmetic, so every screen that reports
 * on a day is stale afterwards — not just the one the edit happened on.
 */
function revalidateAreaSurfaces(): void {
  revalidatePath('/settings');
  revalidatePath('/projects');
  revalidatePath('/week');
  revalidatePath('/today');
  revalidatePath('/review');
}

// ---------------------------------------------------------------------------
// Focus rhythm
// ---------------------------------------------------------------------------

/**
 * Save the break cadence.
 *
 * Clamped to the same bounds the form advertises rather than trusted: a form
 * post is an API call, and `min`/`max` attributes are a hint to the browser,
 * not a constraint on the request.
 */
export async function updateFocusRhythm(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const clamp = (value: FormDataEntryValue | null, min: number, max: number, fallback: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };

  const values = {
    pomodoroEnabled: formData.get('pomodoroEnabled') === 'on',
    pomodoroWorkMinutes: clamp(formData.get('pomodoroWorkMinutes'), 10, 180, 50),
    pomodoroBreakMinutes: clamp(formData.get('pomodoroBreakMinutes'), 1, 60, 10),
  };

  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...values },
    update: values,
  });

  revalidatePath('/settings');
  revalidatePath('/focus');
}
