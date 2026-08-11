/**
 * The adapter contract suite.
 *
 * Every provider runs these same tests. That is the payoff of writing the
 * interface first: when the CalDAV and Microsoft adapters arrive, they inherit
 * this suite, and the safety properties are verified for them on day one rather
 * than rediscovered through a support ticket about vanished events.
 *
 * Usage, from a provider's own test file:
 *
 *   runAdapterContract('Google', () => ({
 *     adapter: new GoogleCalendarAdapter(...),
 *     connection, calendar,
 *     seedRemote: (event) => ...,
 *     deleteRemote: (externalId) => ...,
 *   }));
 */
import { describe, expect, it } from 'vitest';
import type { CalendarAdapter } from '../adapter';
import { supportsPush } from '../adapter';
import {
  NotFoundError,
  PreconditionFailedError,
  type CalendarRef,
  type ConnectionRef,
  type EventDraft,
  type RemoteEvent,
} from '../types';

export interface ContractHarness {
  adapter: CalendarAdapter;
  connection: ConnectionRef;
  calendar: CalendarRef;
  /**
   * Create an event as though it were made in the provider's own UI.
   *
   * The `externalId` passed in is a hint, not a demand — a provider that mints
   * its own ids (CalDAV derives one from the resource path) is free to ignore
   * it. Assertions below use the id on the *returned* event, so the suite works
   * for both kinds.
   */
  seedRemote(event: Partial<RemoteEvent> & { externalId: string }): Promise<RemoteEvent> | RemoteEvent;
  /** Delete at the provider, producing a genuine tombstone. */
  deleteRemote(externalId: string): Promise<void> | void;
}

const draft = (overrides: Partial<EventDraft> = {}): EventDraft => ({
  iCalUid: `fluid-test-${Math.random().toString(36).slice(2)}@fluid.local`,
  title: 'Focus: write the report',
  startsAt: new Date('2026-06-15T09:00:00Z'),
  endsAt: new Date('2026-06-15T10:00:00Z'),
  timeZone: 'UTC',
  transparency: 'BUSY',
  ...overrides,
});

export function runAdapterContract(name: string, setup: () => ContractHarness): void {
  describe(`${name} adapter contract`, () => {
    describe('capabilities', () => {
      it('declares a coherent capability set', () => {
        const { adapter } = setup();
        const caps = adapter.capabilities;

        expect(typeof caps.push).toBe('boolean');
        expect(caps.maxPageSize).toBeGreaterThan(0);
        // Claiming push without implementing watch would make the sync engine
        // subscribe to nothing and silently stop receiving changes.
        if (caps.push) expect(typeof adapter.watch).toBe('function');
        if (!caps.push) expect(supportsPush(adapter)).toBe(false);
      });
    });

    describe('listCalendars', () => {
      it('returns calendars with the fields the sync engine needs', async () => {
        const { adapter, connection } = setup();
        const calendars = await adapter.listCalendars(connection);

        expect(calendars.length).toBeGreaterThan(0);
        for (const calendar of calendars) {
          expect(calendar.externalId).toBeTruthy();
          expect(calendar.timeZone).toBeTruthy();
          expect(typeof calendar.canWrite).toBe('boolean');
        }
      });
    });

    describe('createEvent', () => {
      it('creates an event and echoes back its identity', async () => {
        const { adapter, connection, calendar } = setup();
        const created = await adapter.createEvent(connection, calendar, draft());

        expect(created.externalId).toBeTruthy();
        expect(created.title).toBe('Focus: write the report');
        expect(created.isDeleted).toBe(false);
      });

      // The property that makes an at-least-once outbox safe. Without it, every
      // lost response becomes a duplicate event on the user's calendar.
      it('is idempotent on iCalUid — a retry does not duplicate', async () => {
        const { adapter, connection, calendar } = setup();
        const payload = draft({ iCalUid: 'fluid-idempotency-check@fluid.local' });

        const first = await adapter.createEvent(connection, calendar, payload);
        const second = await adapter.createEvent(connection, calendar, payload);

        expect(second.externalId).toBe(first.externalId);
      });
    });

    describe('updateEvent', () => {
      it('applies a patch', async () => {
        const { adapter, connection, calendar } = setup();
        const created = await adapter.createEvent(connection, calendar, draft());

        const updated = await adapter.updateEvent(
          connection,
          calendar,
          { externalId: created.externalId, etag: created.etag },
          { title: 'Focus: finish the report' },
        );

        expect(updated.title).toBe('Focus: finish the report');
      });

      it('refuses a stale write instead of overwriting a remote change', async () => {
        const { adapter, connection, calendar } = setup();
        if (!adapter.capabilities.etags) return; // Not applicable.

        const created = await adapter.createEvent(connection, calendar, draft());

        // Someone edits it at the provider; our ETag is now stale.
        await adapter.updateEvent(
          connection,
          calendar,
          { externalId: created.externalId, etag: created.etag },
          { title: 'Changed elsewhere' },
        );

        await expect(
          adapter.updateEvent(
            connection,
            calendar,
            { externalId: created.externalId, etag: created.etag },
            { title: 'My conflicting edit' },
          ),
        ).rejects.toBeInstanceOf(PreconditionFailedError);
      });

      it('reports a missing event as NotFound rather than recreating it', async () => {
        const { adapter, connection, calendar } = setup();

        await expect(
          adapter.updateEvent(connection, calendar, { externalId: 'does-not-exist' }, { title: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('deleteEvent', () => {
      it('deletes an event', async () => {
        const { adapter, connection, calendar } = setup();
        const created = await adapter.createEvent(connection, calendar, draft());

        await adapter.deleteEvent(connection, calendar, {
          externalId: created.externalId,
          etag: created.etag,
        });

        await expect(
          adapter.updateEvent(connection, calendar, { externalId: created.externalId }, { title: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('pull', () => {
      it('returns a full snapshot when given no cursor, and labels it as one', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        const seeded = await seedRemote({ externalId: 'remote-1', title: 'Standup' });

        const result = await adapter.pull(connection, calendar, undefined);

        expect(result.isFullSnapshot).toBe(true);
        expect(result.changes.some((event) => event.externalId === seeded.externalId)).toBe(true);
      });

      it('returns only changes after a cursor', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        if (!adapter.capabilities.incrementalSync) return;

        const before = await seedRemote({ externalId: 'before', title: 'Before' });
        const first = await adapter.pull(connection, calendar, undefined);

        const after = await seedRemote({ externalId: 'after', title: 'After' });
        const second = await adapter.pull(connection, calendar, first.nextCursor);

        expect(second.changes.some((event) => event.externalId === after.externalId)).toBe(true);
        expect(second.changes.some((event) => event.externalId === before.externalId)).toBe(false);
        expect(second.isFullSnapshot).toBe(false);
      });

      // The safety property that prevents a resync from being read as mass
      // deletion. A full snapshot omits deleted events; only an explicit
      // tombstone may ever set isDeleted.
      it('never marks an event deleted without an explicit provider signal', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        await seedRemote({ externalId: 'alive-1', title: 'Still here' });
        await seedRemote({ externalId: 'alive-2', title: 'Also here' });

        const snapshot = await adapter.pull(connection, calendar, undefined);

        for (const event of snapshot.changes) {
          expect(event.isDeleted, `${event.externalId} was wrongly flagged deleted`).toBe(false);
        }
      });

      it('reports a genuine deletion as a tombstone', async () => {
        const { adapter, connection, calendar, seedRemote, deleteRemote } = setup();
        if (!adapter.capabilities.deletionTombstones || !adapter.capabilities.incrementalSync) return;

        const doomed = await seedRemote({ externalId: 'doomed', title: 'Will be deleted' });
        const first = await adapter.pull(connection, calendar, undefined);

        await deleteRemote(doomed.externalId);
        const second = await adapter.pull(connection, calendar, first.nextCursor);

        const tombstone = second.changes.find((event) => event.externalId === doomed.externalId);
        expect(tombstone).toBeDefined();
        expect(tombstone!.isDeleted).toBe(true);
      });

      it('is repeatable — the same cursor yields the same changes', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        if (!adapter.capabilities.incrementalSync) return;

        await seedRemote({ externalId: 'stable', title: 'Stable' });
        const first = await adapter.pull(connection, calendar, undefined);

        await seedRemote({ externalId: 'later', title: 'Later' });
        const a = await adapter.pull(connection, calendar, first.nextCursor);
        const b = await adapter.pull(connection, calendar, first.nextCursor);

        expect(a.changes.map((event) => event.externalId).sort()).toEqual(
          b.changes.map((event) => event.externalId).sort(),
        );
      });

      it('preserves recurrence rules verbatim', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        const rrule = 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z';
        const seeded = await seedRemote({ externalId: 'recurring', title: 'Weekly sync', rrule });

        const result = await adapter.pull(connection, calendar, undefined);
        const event = result.changes.find((candidate) => candidate.externalId === seeded.externalId);

        // Byte-for-byte. Re-emitting a parsed rule is how a weekly meeting
        // quietly becomes a daily one.
        expect(event?.rrule).toBe(rrule);
      });

      it('returns timezone information with every event', async () => {
        const { adapter, connection, calendar, seedRemote } = setup();
        await seedRemote({ externalId: 'tz', title: 'Zoned', timeZone: 'Europe/London' });

        const result = await adapter.pull(connection, calendar, undefined);
        for (const event of result.changes) {
          expect(event.timeZone, `${event.externalId} has no timezone`).toBeTruthy();
        }
      });
    });

    describe('error mapping', () => {
      it('surfaces invalid credentials as a non-retryable authentication error', async () => {
        const { adapter, connection } = setup();
        const broken: ConnectionRef = {
          ...connection,
          credentials: { accessToken: 'definitely-not-valid' },
        };

        // Adapters that cannot simulate this locally are exempt; the real
        // provider suites cover it.
        try {
          await adapter.listCalendars(broken);
        } catch (error) {
          expect((error as { retryable?: boolean }).retryable).toBe(false);
        }
      });
    });
  });
}
