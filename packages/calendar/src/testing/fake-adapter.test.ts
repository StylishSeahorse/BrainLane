/**
 * The fake runs the same contract suite every real provider will run.
 *
 * Two configurations, because the contract has to hold for a weak provider too:
 * the second mimics a plain CalDAV server (no push, no ETags, no delta sync),
 * which is where an abstraction shaped around Google would fall apart.
 */
import { describe, expect, it } from 'vitest';
import { supportsPush } from '../adapter';
import { PreconditionFailedError, type CalendarRef, type ConnectionRef } from '../types';
import { runAdapterContract } from './contract';
import { FakeCalendarAdapter } from './fake-adapter';

const connection: ConnectionRef = {
  id: 'conn-1',
  userId: 'user-1',
  provider: 'GOOGLE',
  credentials: { accessToken: 'valid-token' },
};

const calendar: CalendarRef = { id: 'cal-1', externalId: 'primary', timeZone: 'UTC' };

runAdapterContract('Fake (full capability)', () => {
  const adapter = new FakeCalendarAdapter();
  return {
    adapter,
    connection,
    calendar,
    seedRemote: (event) => adapter.seedRemoteEvent('primary', event),
    deleteRemote: (externalId) => adapter.deleteRemoteEvent('primary', externalId),
  };
});

runAdapterContract('Fake (CalDAV-like: no push, no etags, no delta)', () => {
  const adapter = new FakeCalendarAdapter({
    provider: 'CALDAV',
    capabilities: {
      push: false,
      etags: false,
      incrementalSync: false,
      deletionTombstones: false,
      recurrenceEditScopes: ['series'],
    },
  });
  return {
    adapter,
    connection: { ...connection, provider: 'CALDAV' },
    calendar,
    seedRemote: (event) => adapter.seedRemoteEvent('primary', event),
    deleteRemote: (externalId) => adapter.deleteRemoteEvent('primary', externalId),
  };
});

describe('capability-driven behaviour', () => {
  it('a push-capable adapter is narrowed by supportsPush', () => {
    expect(supportsPush(new FakeCalendarAdapter())).toBe(true);
    expect(supportsPush(new FakeCalendarAdapter({ capabilities: { push: false } }))).toBe(false);
  });

  it('an adapter without etags accepts a write that would otherwise conflict', async () => {
    const adapter = new FakeCalendarAdapter({ capabilities: { etags: false } });
    const created = await adapter.createEvent(connection, calendar, {
      iCalUid: 'x@fluid.local',
      title: 'Original',
      startsAt: new Date('2026-06-15T09:00:00Z'),
      endsAt: new Date('2026-06-15T10:00:00Z'),
      timeZone: 'UTC',
      transparency: 'BUSY',
    });

    // No ETag support means no precondition, so a stale write lands. This is
    // exactly the weaker guarantee the sync engine must expect from CalDAV,
    // and why last-write-wins is unsafe there.
    await expect(
      adapter.updateEvent(
        connection,
        calendar,
        { externalId: created.externalId, etag: 'stale' },
        { title: 'Updated' },
      ),
    ).resolves.toMatchObject({ title: 'Updated' });
  });

  it('an etag-capable adapter rejects the same stale write', async () => {
    const adapter = new FakeCalendarAdapter();
    const created = await adapter.createEvent(connection, calendar, {
      iCalUid: 'y@fluid.local',
      title: 'Original',
      startsAt: new Date('2026-06-15T09:00:00Z'),
      endsAt: new Date('2026-06-15T10:00:00Z'),
      timeZone: 'UTC',
      transparency: 'BUSY',
    });

    await expect(
      adapter.updateEvent(
        connection,
        calendar,
        { externalId: created.externalId, etag: 'stale' },
        { title: 'Updated' },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });
});

describe('cursor expiry', () => {
  it('raises SyncCursorInvalid so the engine can trigger a guarded resync', async () => {
    const adapter = new FakeCalendarAdapter();
    adapter.seedRemoteEvent('primary', { externalId: 'a' });

    const first = await adapter.pull(connection, calendar, undefined);
    adapter.expireCursor();

    await expect(adapter.pull(connection, calendar, first.nextCursor)).rejects.toThrow(
      /cursor/i,
    );
  });

  it('a full snapshot after expiry lists live events without any deletions', async () => {
    const adapter = new FakeCalendarAdapter();
    adapter.seedRemoteEvent('primary', { externalId: 'a' });
    adapter.seedRemoteEvent('primary', { externalId: 'b' });

    const snapshot = await adapter.pull(connection, calendar, undefined);

    expect(snapshot.isFullSnapshot).toBe(true);
    expect(snapshot.changes).toHaveLength(2);
    // Nothing in a snapshot may claim to be a deletion — that inference belongs
    // to the sync engine, under its circuit breaker, and nowhere else.
    expect(snapshot.changes.every((event) => !event.isDeleted)).toBe(true);
  });
});

describe('pagination', () => {
  it('reports hasMore and drains across pages without loss or duplication', async () => {
    const adapter = new FakeCalendarAdapter({ capabilities: { maxPageSize: 10 } });
    for (let index = 0; index < 25; index += 1) {
      adapter.seedRemoteEvent('primary', { externalId: `e${index}` });
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await adapter.pull(connection, calendar, cursor);
      for (const event of page.changes) seen.add(event.externalId);
      cursor = page.nextCursor;
      pages += 1;
      if (!page.hasMore) break;
    } while (pages < 10);

    expect(seen.size).toBe(25);
    expect(pages).toBeGreaterThan(1);
  });
});
