/**
 * Development seed.
 *
 * Creates one account with a week that actually exercises the interesting
 * paths: a task that has been rescheduled four times (avoidance detection), a
 * deadline that cannot comfortably be met, a protected lunch and a protected
 * hyperfocus block, an energy dip after 2pm, and an external meeting the
 * scheduler has to route around.
 *
 * Idempotent — safe to re-run.
 */
import { hashPassword } from '@fluid/crypto';
import { prisma } from './client';

const EMAIL = 'demo@fluid.local';
const PASSWORD = 'demo-password-1234';

function at(dayOffset: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

async function main(): Promise<void> {
  console.log('Seeding…');

  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: 'Demo',
      timeZone: 'UTC',
      passwordHash: await hashPassword(PASSWORD),
      preferences: { create: { bufferMinutes: 10, autoAcceptSeconds: 30 } },
      aiSetting: { create: {} },
      workingHours: {
        create: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '09:00',
          endTime: '17:00',
        })),
      },
      energyWindows: {
        create: [
          { dayOfWeek: null, startTime: '09:00', endTime: '14:00', level: 'HIGH' },
          // The classic post-lunch dip. Deep work scheduled here gets wasted.
          { dayOfWeek: null, startTime: '14:00', endTime: '17:00', level: 'LOW' },
        ],
      },
      protectedTimes: {
        create: [
          { kind: 'ROUTINE', label: 'Lunch', dayOfWeek: null, startTime: '12:30', endTime: '13:30' },
        ],
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: 'Quarterly report',
      description: 'The thing that keeps not happening.',
      color: '#c2410c',
      deadline: at(4, 17),
    },
  });

  const sideProject = await prisma.project.create({
    data: { userId: user.id, name: 'Admin', color: '#0369a1' },
  });

  await prisma.task.createMany({
    data: [
      {
        userId: user.id,
        projectId: project.id,
        title: 'Write the quarterly report',
        notes: 'Needs the Q3 numbers, a summary, and the forecast section.',
        status: 'READY',
        priority: 'HIGH',
        energy: 'HIGH',
        estimateMinutes: 180,
        deadline: at(4, 17),
        minChunkMinutes: 45,
        maxChunkMinutes: 90,
        // Four reschedules: this is the avoidance-detection case.
        rescheduleCount: 4,
        lastTouchedAt: at(-6, 10),
      },
      {
        userId: user.id,
        projectId: project.id,
        title: 'Pull Q3 numbers from the dashboard',
        status: 'READY',
        priority: 'HIGH',
        energy: 'MEDIUM',
        estimateMinutes: 45,
        deadline: at(2, 17),
      },
      {
        userId: user.id,
        projectId: sideProject.id,
        title: 'Reply to Dana about the invoice',
        status: 'READY',
        priority: 'URGENT',
        energy: 'LOW',
        estimateMinutes: 15,
        deadline: at(1, 12),
        isSplittable: false,
      },
      {
        userId: user.id,
        projectId: sideProject.id,
        title: 'Book the dentist',
        status: 'READY',
        priority: 'MEDIUM',
        energy: 'LOW',
        estimateMinutes: 15,
        isSplittable: false,
        rescheduleCount: 6,
        lastTouchedAt: at(-11, 9),
      },
      {
        userId: user.id,
        projectId: project.id,
        title: 'Rehearse the presentation',
        status: 'BACKLOG',
        priority: 'MEDIUM',
        energy: 'HIGH',
        estimateMinutes: 60,
        earliestStart: at(3, 9),
      },
    ],
  });

  console.log(`\nSeeded.\n  email:    ${EMAIL}\n  password: ${PASSWORD}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
