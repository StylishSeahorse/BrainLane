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

  revalidatePath('/tasks');
  revalidatePath('/today');
  return {};
}

export async function completeTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.complete({ id: String(formData.get('id')) });
  revalidatePath('/tasks');
  revalidatePath('/today');
}

export async function deleteTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.delete({ id: String(formData.get('id')) });
  revalidatePath('/tasks');
}

export async function deferTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.defer({
    id: String(formData.get('id')),
    days: Number(formData.get('days') ?? 1),
  });
  revalidatePath('/tasks');
  revalidatePath('/today');
}

export async function breakdownTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.breakdown({
    id: String(formData.get('id')),
    granularity: (formData.get('granularity') as 'tiny' | 'normal') ?? 'tiny',
  });
  revalidatePath('/tasks');
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
  revalidatePath('/tasks');
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
  revalidatePath('/tasks');
  return {};
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function rebuildPlan(): Promise<void> {
  const caller = await getCaller();
  await caller.plan.build({ trigger: 'manual' });
  revalidatePath('/today');
  revalidatePath('/calendar');
}

export async function acceptPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.accept({
    planVersionId: String(formData.get('planVersionId')),
    auto: formData.get('auto') === 'true',
  });
  revalidatePath('/today');
  revalidatePath('/calendar');
}

export async function rejectPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.reject({ planVersionId: String(formData.get('planVersionId')) });
  revalidatePath('/today');
  revalidatePath('/calendar');
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
  revalidatePath('/calendar');
  revalidatePath('/activity');
}

export async function revertAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.revert({ id: String(formData.get('id')) });
  revalidatePath('/activity');
  revalidatePath('/calendar');
  revalidatePath('/today');
}

export async function confirmAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.confirm({ id: String(formData.get('id')) });
  revalidatePath('/activity');
  revalidatePath('/calendar');
  revalidatePath('/today');
}

export async function rejectAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.reject({ id: String(formData.get('id')) });
  revalidatePath('/activity');
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
  revalidatePath('/calendar');
  return {};
}

export async function disconnectCalendar(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.disconnect({ connectionId: String(formData.get('connectionId')) });
  revalidatePath('/settings');
  revalidatePath('/calendar');
}

export async function syncCalendars(): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.sync();
  revalidatePath('/settings');
  revalidatePath('/calendar');
  revalidatePath('/today');
}

export async function setCalendarSelected(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.setSelected({
    calendarId: String(formData.get('calendarId')),
    isSelected: formData.get('isSelected') === 'on',
  });
  revalidatePath('/settings');
  revalidatePath('/calendar');
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
