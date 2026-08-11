/**
 * The CalDAV adapter, exercised against a scripted server.
 *
 * It runs the shared adapter contract — the same suite the in-memory fake runs
 * — so the safety properties that matter (no deletion without a tombstone,
 * idempotent creates, refused stale writes) are verified here rather than
 * assumed. The rest are CalDAV's own hazards, which the contract cannot know
 * about.
 */
import { describe, expect, it } from 'vitest';
import { UnsafeEndpointError } from '@fluid/net';
import { runAdapterContract } from '../../testing/contract';
import {
  AuthenticationError,
  NotFoundError,
  ReadOnlyCalendarError,
  type CalendarRef,
  type ConnectionRef,
  type EventDraft,
  type RemoteEvent,
} from '../../types';
import { CalDavAdapter } from './index';
import { CALENDAR, FakeCalDavServer, icsFixture, ORIGIN, type FakeCalDavOptions } from './fake-server';

const NOW = new Date('2026-06-01T00:00:00Z');

const connection: ConnectionRef = {
  id: 'conn-1',
  userId: 'user-1',
  provider: 'CALDAV',
  credentials: { serverUrl: `${ORIGIN}/`, username: 'alice', password: 'secret' },
};

const calendar: CalendarRef = {
  id: 'cal-1',
  externalId: `${ORIGIN}${CALENDAR}`,
  timeZone: 'Europe/London',
};

function setup(options: FakeCalDavOptions = {}) {
  const server = new FakeCalDavServer(options);
  const adapter = new CalDavAdapter({ transport: server.transport, now: () => NOW });
  return { server, adapter, connection, calendar };
}

const draft = (overrides: Partial<EventDraft> = {}): EventDraft => ({
  iCalUid: 'fluid-block-1@fluid.local',
  title: 'Focus: write the report',
  startsAt: new Date('2026-06-15T09:00:00Z'),
  endsAt: new Date('2026-06-15T10:00:00Z'),
  timeZone: 'Europe/London',
  transparency: 'BUSY',
  ...overrides,
});

// ---------------------------------------------------------------------------
// The shared contract
// ---------------------------------------------------------------------------

runAdapterContract('CalDAV', () => {
  const { server, adapter } = setup();

  return {
    adapter,
    connection,
    calendar,
    seedRemote: (event) => {
      const zoned = event.timeZone && event.timeZone !== 'UTC';
      const url = server.seed(
        event.externalId,
        icsFixture({
          uid: `${event.externalId}@other-client.test`,
          ...(event.title ? { summary: event.title } : {}),
          ...(event.rrule ? { rrule: event.rrule } : {}),
          ...(zoned
            ? { timeZone: event.timeZone!, start: '20260615T090000', end: '20260615T093000' }
            : {}),
        }),
      );

      // The server mints the id, not the caller: on CalDAV an event's identity
      // is the path it was stored at.
      return { ...(event as RemoteEvent), externalId: url };
    },
    deleteRemote: (externalId) => server.remove(externalId),
  };
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('walks origin to principal to calendar home', async () => {
    const { adapter, server } = setup();
    await adapter.listCalendars(connection);

    const bodies = server.requests.map((request) => request.body ?? '');
    expect(bodies.some((body) => body.includes('current-user-principal'))).toBe(true);
    expect(bodies.some((body) => body.includes('calendar-home-set'))).toBe(true);
  });

  it('reads name, zone and write access off the collection', async () => {
    const { adapter } = setup();
    const [work] = await adapter.listCalendars(connection);

    expect(work?.name).toBe('Work');
    // Taken from the collection's own default VTIMEZONE, not guessed.
    expect(work?.timeZone).toBe('Europe/London');
    expect(work?.canWrite).toBe(true);
    expect(work?.externalId.endsWith('/')).toBe(true);
  });

  it('hides collections that hold no events', async () => {
    // A CalDAV home usually contains task lists too. Offering someone their
    // reminders list as somewhere to schedule deep work is a confusing failure.
    const { adapter } = setup();
    const calendars = await adapter.listCalendars(connection);

    expect(calendars).toHaveLength(1);
    expect(calendars.map((entry) => entry.name)).not.toContain('Reminders');
  });

  it('reports bad credentials as non-retryable', async () => {
    const { adapter } = setup({ password: 'something-else' });

    await expect(adapter.listCalendars(connection)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(adapter.verifyConnection(connection)).resolves.toBe(false);
  });

  it('refuses a connection with nothing configured', async () => {
    const { adapter } = setup();
    const empty: ConnectionRef = { ...connection, credentials: {} };

    await expect(adapter.listCalendars(empty)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

// ---------------------------------------------------------------------------
// Pulling
// ---------------------------------------------------------------------------

describe('pull', () => {
  it('takes the sync token before reading, never after', async () => {
    // The ordering is the whole safety property. A token taken after the query
    // would sit *ahead* of anything changed during it, and those changes would
    // never be seen again. Doing work twice is recoverable; skipping a change
    // permanently is not.
    const { adapter, server } = setup();
    server.seed('a', icsFixture({ uid: 'a@test' }));

    await adapter.pull(connection, calendar, undefined);

    const tokenAt = server.requests.findIndex((request) =>
      (request.body ?? '').includes('<d:sync-token/>'),
    );
    const queryAt = server.requests.findIndex((request) =>
      (request.body ?? '').includes('calendar-query'),
    );

    expect(tokenAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeLessThan(queryAt);
  });

  it('says which window a snapshot covers', async () => {
    // A calendar-query is always time-bounded, so its result is a complete
    // snapshot of a window rather than of the calendar. Without saying so, the
    // sync engine would read every event outside the window as missing and
    // tombstone the lot.
    const { adapter, server } = setup();
    server.seed('a', icsFixture({ uid: 'a@test' }));

    const result = await adapter.pull(connection, calendar, undefined);

    expect(result.isFullSnapshot).toBe(true);
    expect(result.snapshotWindow).toBeDefined();
    expect(result.snapshotWindow!.from.getTime()).toBeLessThan(NOW.getTime());
    expect(result.snapshotWindow!.to.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('turns a 404 in a sync report into a tombstone', async () => {
    const { adapter, server } = setup();
    const url = server.seed('doomed', icsFixture({ uid: 'doomed@test' }));

    const first = await adapter.pull(connection, calendar, undefined);
    server.remove(url);
    const second = await adapter.pull(connection, calendar, first.nextCursor);

    const tombstone = second.changes.find((event) => event.externalId === url);
    expect(tombstone?.isDeleted).toBe(true);
  });

  it('asks for a fresh snapshot when the server rejects the token', async () => {
    const { adapter } = setup({ rejectSyncToken: true });

    const result = await adapter.pull(connection, calendar, 'https://caldav.test/sync/1');

    expect(result.fullResyncRequired).toBe(true);
    // Critically, it returns no changes at all. A rejected cursor must never
    // look like "everything disappeared".
    expect(result.changes).toEqual([]);
  });

  it('falls back to snapshots on a server that has no sync-collection', async () => {
    const { adapter } = setup({ noSyncSupport: true });

    const result = await adapter.pull(connection, calendar, 'anything');

    expect(result.fullResyncRequired).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it('ignores the collection’s own entry in a sync report', async () => {
    const { adapter, server } = setup();
    const first = await adapter.pull(connection, calendar, undefined);
    server.seed('a', icsFixture({ uid: 'a@test' }));

    const second = await adapter.pull(connection, calendar, first.nextCursor);

    expect(second.changes.every((event) => event.externalId !== `${ORIGIN}${CALENDAR}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe('writes', () => {
  it('creates with If-None-Match, so a retry cannot duplicate', async () => {
    const { adapter, server } = setup();
    await adapter.createEvent(connection, calendar, draft());

    const put = server.requests.find((request) => request.method === 'PUT');
    expect(put?.headers?.['if-none-match']).toBe('*');
  });

  it('adopts the existing event when a create is retried', async () => {
    // The outbox delivers at least once, so this is the normal path after a
    // response is lost — not an edge case.
    const { adapter } = setup();
    const first = await adapter.createEvent(connection, calendar, draft());
    const second = await adapter.createEvent(connection, calendar, draft());

    expect(second.externalId).toBe(first.externalId);
  });

  it('adopts an event another client stored under a different filename', async () => {
    // A UID may exist only once per collection, so a server refuses the write
    // with `no-uid-conflict` rather than letting a duplicate through. Finding
    // and adopting the existing copy is the only outcome that leaves the user
    // with one event instead of two.
    const { adapter, server } = setup();
    const uid = 'fluid-block-9@fluid.local';
    const url = server.seed('some-other-name', icsFixture({ uid }));

    const created = await adapter.createEvent(connection, calendar, draft({ iCalUid: uid }));

    expect(created.externalId).toBe(url);
  });

  it('sends the caller’s ETag as the precondition, not a freshly read one', async () => {
    const { adapter, server } = setup();
    const created = await adapter.createEvent(connection, calendar, draft());

    await adapter.updateEvent(
      connection,
      calendar,
      { externalId: created.externalId, etag: created.etag },
      { title: 'Changed by someone else' },
    );

    const put = server.requests.filter((request) => request.method === 'PUT').at(-1);
    expect(put?.headers?.['if-match']).toBe(created.etag);
  });

  it('keeps attendees and alarms through an update', async () => {
    const { adapter, server } = setup();
    const url = server.seed(
      'meeting',
      icsFixture({
        uid: 'meeting@test',
        extraLines: [
          'ATTENDEE;CN=Bo:mailto:bo@example.test',
          'BEGIN:VALARM',
          'TRIGGER:-PT15M',
          'ACTION:DISPLAY',
          'END:VALARM',
        ],
      }),
    );

    await adapter.updateEvent(connection, calendar, { externalId: url }, { title: 'Renamed' });

    const stored = server.body(url) ?? '';
    expect(stored).toContain('SUMMARY:Renamed');
    expect(stored).toContain('ATTENDEE;CN=Bo:mailto:bo@example.test');
    expect(stored).toContain('BEGIN:VALARM');
  });

  it('refuses to edit one occurrence of a repeating event', async () => {
    // Editing a single occurrence over CalDAV means rewriting the resource that
    // holds the whole series. Refusing is the documented behaviour of
    // `recurrenceEditScopes`, and far better than a silent series rewrite.
    const { adapter } = setup();

    await expect(
      adapter.updateEvent(
        connection,
        calendar,
        { externalId: `${ORIGIN}${CALENDAR}x.ics#20260622T090000Z` },
        { title: 'Just this week' },
      ),
    ).rejects.toBeInstanceOf(ReadOnlyCalendarError);
  });

  it('refuses an instance-scoped edit of a series', async () => {
    const { adapter, server } = setup();
    const url = server.seed('weekly', icsFixture({ uid: 'weekly@test', rrule: 'RRULE:FREQ=WEEKLY' }));

    await expect(
      adapter.updateEvent(connection, calendar, { externalId: url, scope: 'instance' }, { title: 'x' }),
    ).rejects.toThrow(/scope/i);
  });

  it('deletes with a precondition and then reports the event as gone', async () => {
    const { adapter } = setup();
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

// ---------------------------------------------------------------------------
// The endpoint itself
// ---------------------------------------------------------------------------

describe('server address safety', () => {
  it('refuses to reach the cloud metadata service', async () => {
    // No injected transport: this is the real SSRF-guarded one. A CalDAV server
    // address is the most dangerous input in the product — it is a text field
    // that decides where our server makes a request.
    const adapter = new CalDavAdapter();

    await expect(
      adapter.listCalendars({
        ...connection,
        credentials: {
          serverUrl: 'http://169.254.169.254/latest/meta-data/',
          username: 'a',
          password: 'b',
        },
      }),
    ).rejects.toBeInstanceOf(UnsafeEndpointError);
  });

  it('refuses a private network address', async () => {
    const adapter = new CalDavAdapter();

    await expect(
      adapter.listCalendars({
        ...connection,
        credentials: { serverUrl: 'https://192.168.1.10/dav/', username: 'a', password: 'b' },
      }),
    ).rejects.toBeInstanceOf(UnsafeEndpointError);
  });

  it('refuses plain http, which would put the password on the wire', async () => {
    const adapter = new CalDavAdapter();

    await expect(
      adapter.listCalendars({
        ...connection,
        credentials: { serverUrl: 'http://calendar.example.test/dav/', username: 'a', password: 'b' },
      }),
    ).rejects.toBeInstanceOf(UnsafeEndpointError);
  });
});
