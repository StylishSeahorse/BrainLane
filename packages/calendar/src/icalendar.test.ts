import { describe, expect, it } from 'vitest';
import {
  escapeText,
  parseCalendarObject,
  parseIcsDuration,
  patchCalendarObject,
  serializeAppBlock,
  unescapeText,
} from './icalendar';

const options = { href: 'https://cal.test/c/1.ics', defaultTimeZone: 'Europe/London' };

function ics(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(
    '\r\n',
  );
}

describe('parsing', () => {
  it('reads a plain UTC event', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000Z', 'DTEND:20260615T100000Z', 'SUMMARY:Standup'),
      options,
    );

    expect(event?.title).toBe('Standup');
    expect(event?.startsAt.toISOString()).toBe('2026-06-15T09:00:00.000Z');
    expect(event?.endsAt.toISOString()).toBe('2026-06-15T10:00:00.000Z');
    expect(event?.isAllDay).toBe(false);
    expect(event?.isDeleted).toBe(false);
  });

  it('resolves a TZID through the zone, not a fixed offset', () => {
    // The same wall-clock time in the same zone is a different instant in
    // summer and winter. Getting this wrong is the classic calendar bug: a
    // 9am block that silently becomes 8am for half the year.
    const summer = parseCalendarObject(
      ics('UID:a@test', 'DTSTART;TZID=Europe/London:20260615T090000', 'DTEND;TZID=Europe/London:20260615T100000'),
      options,
    )[0];
    const winter = parseCalendarObject(
      ics('UID:b@test', 'DTSTART;TZID=Europe/London:20261215T090000', 'DTEND;TZID=Europe/London:20261215T100000'),
      options,
    )[0];

    expect(summer?.startsAt.toISOString()).toBe('2026-06-15T08:00:00.000Z'); // BST
    expect(winter?.startsAt.toISOString()).toBe('2026-12-15T09:00:00.000Z'); // GMT
    expect(summer?.timeZone).toBe('Europe/London');
  });

  it('interprets a floating time in the calendar’s own zone', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000', 'DTEND:20260615T100000'),
      options,
    );

    expect(event?.startsAt.toISOString()).toBe('2026-06-15T08:00:00.000Z');
  });

  it('treats VALUE=DATE as all-day and gives it a day’s length', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART;VALUE=DATE:20260615', 'SUMMARY:Leave'),
      options,
    );

    expect(event?.isAllDay).toBe(true);
    expect(event!.endsAt.getTime() - event!.startsAt.getTime()).toBe(86_400_000);
  });

  it('accepts DURATION in place of DTEND', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000Z', 'DURATION:PT1H30M'),
      options,
    );

    expect(event!.endsAt.toISOString()).toBe('2026-06-15T10:30:00.000Z');
  });

  it('keeps the recurrence rule byte-for-byte', () => {
    const rrule = 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z';
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000Z', 'DTEND:20260615T100000Z', rrule),
      options,
    );

    // Verbatim, because re-emitting a parsed rule is how a weekly meeting
    // quietly becomes a daily one.
    expect(event?.rrule).toBe(rrule);
  });

  it('unfolds a wrapped property before reading it', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a@test',
      'DTSTART:20260615T090000Z',
      'SUMMARY:A title that was folded acr',
      ' oss two lines',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(parseCalendarObject(text, options)[0]?.title).toBe('A title that was folded across two lines');
  });

  it('handles a quoted parameter containing a colon or semicolon', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART;TZID="Europe/London";X-NOTE="a; b: c":20260615T090000'),
      options,
    );

    expect(event?.timeZone).toBe('Europe/London');
  });

  it('splits a resource holding a series and its modified occurrence', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a@test',
      'DTSTART:20260615T090000Z',
      'DTEND:20260615T100000Z',
      'RRULE:FREQ=WEEKLY',
      'SUMMARY:Weekly sync',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:a@test',
      'RECURRENCE-ID:20260622T090000Z',
      'DTSTART:20260622T110000Z',
      'DTEND:20260622T120000Z',
      'SUMMARY:Weekly sync (moved)',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseCalendarObject(text, options);

    expect(events).toHaveLength(2);
    expect(events[0]?.externalId).toBe(options.href);
    // The override needs an id of its own — both live in one resource, but the
    // unified table holds one row each.
    expect(events[1]?.externalId).toBe(`${options.href}#20260622T090000Z`);
    expect(events[1]?.recurringEventId).toBe(options.href);
    expect(events[1]?.originalStartsAt?.toISOString()).toBe('2026-06-22T09:00:00.000Z');
  });

  it('maps status and transparency', () => {
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000Z', 'STATUS:TENTATIVE', 'TRANSP:TRANSPARENT'),
      options,
    );

    expect(event?.status).toBe('TENTATIVE');
    expect(event?.transparency).toBe('FREE');
  });

  it('never marks an event deleted from its content alone', () => {
    // A CANCELLED status is not a tombstone. Deletion is something the server
    // states at the protocol level, and inferring it from a body is how a
    // resync turns into data loss.
    const [event] = parseCalendarObject(
      ics('UID:a@test', 'DTSTART:20260615T090000Z', 'STATUS:CANCELLED'),
      options,
    );

    expect(event?.isDeleted).toBe(false);
  });

  it('skips an event with no start rather than inventing one', () => {
    expect(parseCalendarObject(ics('UID:a@test', 'SUMMARY:No time'), options)).toHaveLength(0);
  });

  it('survives text that is not iCalendar at all', () => {
    expect(parseCalendarObject('<html>login page</html>', options)).toEqual([]);
  });
});

describe('text escaping', () => {
  it('round-trips separators and newlines', () => {
    const value = 'Lunch with Ana, Bo; then\nwrite up notes \\ done';
    expect(unescapeText(escapeText(value))).toBe(value);
  });

  it('reads escapes a server produced', () => {
    expect(unescapeText('a\\, b\\; c\\nd')).toBe('a, b; c\nd');
  });
});

describe('durations', () => {
  it('parses the forms that appear in practice', () => {
    expect(parseIcsDuration('PT30M')).toBe(1_800_000);
    expect(parseIcsDuration('P1D')).toBe(86_400_000);
    expect(parseIcsDuration('P1W')).toBe(604_800_000);
    expect(parseIcsDuration('-PT15M')).toBe(-900_000);
    expect(parseIcsDuration('nonsense')).toBeNull();
  });
});

describe('serializing a block we authored', () => {
  const draft = {
    iCalUid: 'fluid-abc@fluid.local',
    title: 'Focus: write the report',
    startsAt: new Date('2026-06-15T09:00:00Z'),
    endsAt: new Date('2026-06-15T10:00:00Z'),
    timeZone: 'Europe/London',
    transparency: 'BUSY' as const,
  };

  it('produces an object that parses back to the same event', () => {
    const [event] = parseCalendarObject(serializeAppBlock(draft), options);

    expect(event?.title).toBe(draft.title);
    expect(event?.iCalUid).toBe(draft.iCalUid);
    expect(event?.startsAt.toISOString()).toBe(draft.startsAt.toISOString());
    expect(event?.endsAt.toISOString()).toBe(draft.endsAt.toISOString());
  });

  it('escapes a title containing separators', () => {
    const text = serializeAppBlock({ ...draft, title: 'Email Ana, Bo; then rest' });
    expect(text).toContain('SUMMARY:Email Ana\\, Bo\\; then rest');
    expect(parseCalendarObject(text, options)[0]?.title).toBe('Email Ana, Bo; then rest');
  });

  it('folds a long line and still round-trips it', () => {
    const title = 'x'.repeat(300);
    const text = serializeAppBlock({ ...draft, title });

    expect(text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(parseCalendarObject(text, options)[0]?.title).toBe(title);
  });

  it('uses CRLF line endings, which strict servers require', () => {
    expect(serializeAppBlock(draft)).toContain('\r\n');
  });
});

describe('patching an existing object', () => {
  const original = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:a@test',
    'DTSTAMP:20260601T120000Z',
    'DTSTART:20260615T090000Z',
    'DTEND:20260615T100000Z',
    'SUMMARY:Original',
    'DESCRIPTION:Event notes',
    'SEQUENCE:2',
    'ATTENDEE;CN=Bo;PARTSTAT=ACCEPTED:mailto:bo@example.test',
    'X-CUSTOM-THING:keep me',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Alarm text',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('changes only what was asked for', () => {
    const patched = patchCalendarObject(original, { title: 'Updated' });

    expect(patched).toContain('SUMMARY:Updated');
    expect(patched).not.toContain('SUMMARY:Original');
  });

  it('preserves properties we do not model', () => {
    // The alternative — parse to our model and re-serialize — would silently
    // drop the attendee, the alarm and the custom property. Losing someone's
    // meeting guests as a side effect of moving a block is not recoverable.
    const patched = patchCalendarObject(original, { title: 'Updated' });

    expect(patched).toContain('ATTENDEE;CN=Bo;PARTSTAT=ACCEPTED:mailto:bo@example.test');
    expect(patched).toContain('X-CUSTOM-THING:keep me');
    expect(patched).toContain('BEGIN:VALARM');
    expect(patched).toContain('TRIGGER:-PT15M');
  });

  it('rewrites the event’s description, not the alarm’s', () => {
    const patched = patchCalendarObject(original, { description: 'New notes' });

    expect(patched).toContain('DESCRIPTION:New notes');
    expect(patched).toContain('DESCRIPTION:Alarm text');
  });

  it('bumps SEQUENCE so other clients can tell which copy is newer', () => {
    expect(patchCalendarObject(original, { title: 'Updated' })).toContain('SEQUENCE:3');
  });

  it('adds a property the event did not have', () => {
    expect(patchCalendarObject(original, { transparency: 'FREE' })).toContain('TRANSP:TRANSPARENT');
  });

  it('is not confused by a title that looks like a regex replacement', () => {
    // `$&` in a replacement string means "the whole match". Calendar text is
    // user-supplied, so this is reachable, and it corrupts the event silently.
    const patched = patchCalendarObject(original, { title: '$& $1 costs $100' });
    expect(patched).toContain('SUMMARY:$& $1 costs $100');
  });

  it('leaves a modified occurrence alone', () => {
    const withOverride = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a@test',
      'DTSTART:20260615T090000Z',
      'SUMMARY:Series',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:a@test',
      'RECURRENCE-ID:20260622T090000Z',
      'DTSTART:20260622T110000Z',
      'SUMMARY:That one week',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const patched = patchCalendarObject(withOverride, { title: 'Renamed' });

    expect(patched).toContain('SUMMARY:Renamed');
    expect(patched).toContain('SUMMARY:That one week');
  });
});
