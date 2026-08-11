/**
 * iCalendar (RFC 5545) reading and writing.
 *
 * CalDAV has no JSON. Every event arrives as an iCalendar object and every
 * write is one, so this module is the whole translation layer between a text
 * format from 1998 and our normalized `RemoteEvent`.
 *
 * Two rules shape everything here:
 *
 *   1. WE PARSE WHAT WE MUST AND PRESERVE THE REST. Recurrence rules are
 *      captured as the literal line the server sent and handed on untouched.
 *      Round-tripping an RRULE through a parser is how a weekly meeting becomes
 *      a daily one, and how a series shifts an hour at a DST boundary. We only
 *      ever emit rules we wrote ourselves — which, today, is none.
 *
 *   2. A DATE-TIME IS NOT AN INSTANT UNTIL A ZONE SAYS SO. `20260615T090000`
 *      with a TZID means 9am in that zone, which is a different instant in June
 *      than in December. Resolving it through `fromLocal` rather than by
 *      pasting on an offset is what keeps a recurring 9am block at 9am all
 *      year.
 */
import { fromLocal, type LocalDateTime } from '@fluid/core';
import type { EventDraft, RemoteEvent, RemoteEventStatus, RemoteTransparency } from './types';

export interface IcsProperty {
  /** Upper-cased property name, e.g. `DTSTART`. */
  name: string;
  /** Upper-cased parameter names mapped to their (unquoted) values. */
  params: Record<string, string>;
  /** The raw value, still escaped. */
  value: string;
  /** The complete unfolded line, for properties we preserve verbatim. */
  raw: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  children: IcsComponent[];
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * Undo RFC 5545 line folding.
 *
 * A long property is split across lines with each continuation prefixed by a
 * space or tab. Unfolding has to happen before anything else looks at the text,
 * or a folded DESCRIPTION turns into a malformed property name.
 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded: string[] = [];

  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      unfolded.push(line);
    }
  }

  return unfolded;
}

/**
 * Split a content line into name, parameters and value.
 *
 * Hand-written rather than a regex because a quoted parameter value may contain
 * `:` and `;` — `ATTENDEE;CN="Smith; Bob":mailto:…` is legal, and a naive
 * `split(':')` mangles it.
 */
function parseLine(line: string): IcsProperty | null {
  let index = 0;
  let inQuotes = false;
  let valueStart = -1;

  while (index < line.length) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ':' && !inQuotes) {
      valueStart = index;
      break;
    }
    index += 1;
  }

  if (valueStart === -1) return null;

  const head = line.slice(0, valueStart);
  const value = line.slice(valueStart + 1);

  const segments: string[] = [];
  let current = '';
  inQuotes = false;
  for (const char of head) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ';' && !inQuotes) {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  segments.push(current);

  const name = (segments.shift() ?? '').trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    const raw = segment.slice(eq + 1).trim();
    params[key] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }

  return { name, params, value, raw: line };
}

/** Parse into a component tree. Unknown components are kept, not discarded. */
export function parseIcs(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];

  for (const line of unfold(text)) {
    const property = parseLine(line);
    if (!property) continue;

    if (property.name === 'BEGIN') {
      const component: IcsComponent = {
        name: property.value.trim().toUpperCase(),
        properties: [],
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(component);
      else roots.push(component);
      stack.push(component);
      continue;
    }

    if (property.name === 'END') {
      stack.pop();
      continue;
    }

    stack[stack.length - 1]?.properties.push(property);
  }

  return roots;
}

function get(component: IcsComponent, name: string): IcsProperty | undefined {
  return component.properties.find((property) => property.name === name);
}

function all(component: IcsComponent, name: string): IcsProperty[] {
  return component.properties.filter((property) => property.name === name);
}

/** Reverse RFC 5545 TEXT escaping. */
export function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      out += char;
      continue;
    }

    const next = value[i + 1];
    i += 1;
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === undefined) out += '\\';
    else out += next; // covers \, \; \\ and anything else, per the spec's leniency
  }
  return out;
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;

export interface ParsedDate {
  instant: Date;
  isAllDay: boolean;
  /** The zone the value was authored in, as far as we can tell. */
  timeZone: string;
}

/**
 * Turn a DATE or DATE-TIME property into an instant.
 *
 * `fallbackZone` covers the floating case — a DATE-TIME with neither a `Z` nor
 * a TZID. RFC 5545 says such a time means "whatever local time the viewer is
 * in", which has no single correct answer; interpreting it in the calendar's
 * own zone is the reading that matches what the person who created it saw.
 */
export function parseIcsDate(property: IcsProperty, fallbackZone: string): ParsedDate | null {
  const value = property.value.trim();

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly || property.params.VALUE === 'DATE') {
    const match = dateOnly ?? DATE_ONLY.exec(value.slice(0, 8));
    if (!match) return null;
    const [, year, month, day] = match;
    const local: LocalDateTime = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: 0,
      minute: 0,
      second: 0,
    };
    const zone = property.params.TZID ?? fallbackZone;
    return { instant: fromLocal(local, zone), isAllDay: true, timeZone: zone };
  }

  const match = DATE_TIME.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, utc] = match;
  const local: LocalDateTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };

  // A trailing Z is absolute and outranks any TZID a server mistakenly attached.
  const zone = utc ? 'UTC' : (property.params.TZID ?? fallbackZone);
  return { instant: fromLocal(local, zone), isAllDay: false, timeZone: zone };
}

const DURATION =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** RFC 5545 DURATION into milliseconds. Returns null on anything unexpected. */
export function parseIcsDuration(value: string): number | null {
  const match = DURATION.exec(value.trim());
  if (!match) return null;

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    Number(weeks ?? 0) * 604_800_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000;

  if (total === 0 && !/\d/.test(value)) return null;
  return sign === '-' ? -total : total;
}

// ---------------------------------------------------------------------------
// VEVENT -> RemoteEvent
// ---------------------------------------------------------------------------

function statusOf(component: IcsComponent): RemoteEventStatus {
  const value = get(component, 'STATUS')?.value.trim().toUpperCase();
  if (value === 'CANCELLED') return 'CANCELLED';
  if (value === 'TENTATIVE') return 'TENTATIVE';
  return 'CONFIRMED';
}

function transparencyOf(component: IcsComponent): RemoteTransparency {
  return get(component, 'TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT' ? 'FREE' : 'BUSY';
}

/**
 * Recurrence lines, verbatim.
 *
 * RRULE, RDATE and EXDATE together define the series; keeping the raw lines
 * means we can hand them back to a server byte-for-byte, and it means a rule
 * using a feature we never implemented still survives a round trip.
 */
function recurrenceOf(component: IcsComponent): string | undefined {
  const lines = [
    ...all(component, 'RRULE'),
    ...all(component, 'RDATE'),
    ...all(component, 'EXDATE'),
  ].map((property) => property.raw);

  return lines.length > 0 ? lines.join('\r\n') : undefined;
}

export interface ParseOptions {
  /** Resource path at the server. Becomes the event's `externalId`. */
  href: string;
  etag?: string;
  /** Zone for floating times — normally the calendar's own. */
  defaultTimeZone: string;
}

/**
 * Convert one calendar object (one `.ics` resource) into events.
 *
 * A single resource holds the master event plus any modified occurrences, all
 * sharing a UID. They come back as separate `RemoteEvent`s so the unified table
 * can hold one row each, with overrides pointing at their master.
 */
export function parseCalendarObject(text: string, options: ParseOptions): RemoteEvent[] {
  const calendars = parseIcs(text).filter((component) => component.name === 'VCALENDAR');
  const events: RemoteEvent[] = [];

  for (const calendar of calendars) {
    for (const component of calendar.children) {
      if (component.name !== 'VEVENT') continue;

      const dtstart = get(component, 'DTSTART');
      if (!dtstart) continue; // Not a usable event; skipping beats inventing a time.

      const start = parseIcsDate(dtstart, options.defaultTimeZone);
      if (!start) continue;

      let end: Date;
      const dtend = get(component, 'DTEND');
      const duration = get(component, 'DURATION');

      if (dtend) {
        end = parseIcsDate(dtend, start.timeZone)?.instant ?? start.instant;
      } else if (duration) {
        end = new Date(start.instant.getTime() + (parseIcsDuration(duration.value) ?? 0));
      } else if (start.isAllDay) {
        end = new Date(start.instant.getTime() + 86_400_000);
      } else {
        end = start.instant;
      }

      const recurrenceId = get(component, 'RECURRENCE-ID');
      const originalStart = recurrenceId
        ? parseIcsDate(recurrenceId, start.timeZone)?.instant
        : undefined;

      // A modified occurrence shares its resource with the master, so it needs
      // an id of its own. Suffixing with the occurrence it replaces is stable
      // across syncs, which an index would not be.
      const externalId = recurrenceId
        ? `${options.href}#${recurrenceId.value.trim()}`
        : options.href;

      const lastModified = get(component, 'LAST-MODIFIED') ?? get(component, 'DTSTAMP');
      const remoteUpdatedAt = lastModified
        ? parseIcsDate(lastModified, 'UTC')?.instant
        : undefined;

      const sequenceValue = Number(get(component, 'SEQUENCE')?.value);

      events.push({
        externalId,
        ...(get(component, 'UID') ? { iCalUid: get(component, 'UID')!.value.trim() } : {}),
        ...(options.etag ? { etag: options.etag } : {}),
        ...(Number.isFinite(sequenceValue) ? { sequence: sequenceValue } : {}),

        title: unescapeText(get(component, 'SUMMARY')?.value ?? '(no title)'),
        ...(get(component, 'DESCRIPTION')
          ? { description: unescapeText(get(component, 'DESCRIPTION')!.value) }
          : {}),
        ...(get(component, 'LOCATION')
          ? { location: unescapeText(get(component, 'LOCATION')!.value) }
          : {}),

        startsAt: start.instant,
        endsAt: end,
        isAllDay: start.isAllDay,
        timeZone: start.timeZone,

        ...(recurrenceOf(component) ? { rrule: recurrenceOf(component) } : {}),
        ...(recurrenceId ? { recurringEventId: options.href } : {}),
        ...(originalStart ? { originalStartsAt: originalStart } : {}),

        status: statusOf(component),
        transparency: transparencyOf(component),
        ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),

        // Never inferred here. A deletion is something the server states, and
        // it states it at the protocol level (a 404 in a sync report), not
        // inside an iCalendar body.
        isDeleted: false,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// RemoteEvent -> VEVENT
// ---------------------------------------------------------------------------

function utcStamp(instant: Date): string {
  return `${instant.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Fold a content line to 75 octets.
 *
 * Octets, not characters: a multi-byte character split down the middle produces
 * an unreadable property on servers that decode strictly.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const pieces: string[] = [];
  let offset = 0;
  let limit = 75;

  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    // Do not split a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (end > offset && end < bytes.length && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
    }
    pieces.push(bytes.subarray(offset, end).toString('utf8'));
    offset = end;
    limit = 74; // Continuations carry a leading space.
  }

  return pieces.join('\r\n ');
}

/**
 * Serialize a block we authored.
 *
 * Deliberately minimal, and deliberately UTC-only. We write times as absolute
 * instants rather than TZID references so the object carries no VTIMEZONE
 * component we would have to keep correct — the zone the user cares about is
 * already recorded on our side. This function is only ever used for events we
 * created; an event that came from a server is never re-serialized from our
 * parse of it.
 */
export function serializeAppBlock(draft: EventDraft, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fluid//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${draft.iCalUid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(draft.startsAt)}`,
    `DTEND:${utcStamp(draft.endsAt)}`,
    `SUMMARY:${escapeText(draft.title)}`,
    ...(draft.description ? [`DESCRIPTION:${escapeText(draft.description)}`] : []),
    `TRANSP:${draft.transparency === 'FREE' ? 'TRANSPARENT' : 'OPAQUE'}`,
    'STATUS:CONFIRMED',
    // Marks the event as ours on the server, so a human looking at the raw
    // object can tell where it came from.
    'X-FLUID-ORIGIN:APP_BLOCK',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * Apply a patch to an existing calendar object, in place, textually.
 *
 * The alternative — parse to our model and re-serialize — would silently drop
 * every property we do not model: attendees, alarms, attachments, custom
 * fields. Editing the lines we mean to change and leaving the rest untouched is
 * the only version of this that cannot lose someone's data.
 */
export function patchCalendarObject(
  text: string,
  patch: {
    title?: string;
    description?: string;
    startsAt?: Date;
    endsAt?: Date;
    transparency?: RemoteTransparency;
  },
): string {
  const replacements = new Map<string, string>();

  if (patch.title !== undefined) replacements.set('SUMMARY', `SUMMARY:${escapeText(patch.title)}`);
  if (patch.description !== undefined) {
    replacements.set('DESCRIPTION', `DESCRIPTION:${escapeText(patch.description)}`);
  }
  if (patch.startsAt) replacements.set('DTSTART', `DTSTART:${utcStamp(patch.startsAt)}`);
  if (patch.endsAt) replacements.set('DTEND', `DTEND:${utcStamp(patch.endsAt)}`);
  if (patch.transparency) {
    replacements.set(
      'TRANSP',
      `TRANSP:${patch.transparency === 'FREE' ? 'TRANSPARENT' : 'OPAQUE'}`,
    );
  }

  // Structural, not a line-anchored regex. A VEVENT usually contains a VALARM,
  // and a VALARM has a DESCRIPTION of its own — a textual replace of the first
  // DESCRIPTION would rewrite the reminder text instead of the event's, which
  // is the kind of bug nobody notices until an alarm reads like a meeting.
  const lines = unfold(text);
  const out: string[] = [];

  // Components nest: VCALENDAR > VEVENT > VALARM. We only touch properties
  // sitting directly inside a VEVENT, so each VEVENT is buffered and patched
  // as a unit.
  let buffer: string[] | null = null;

  const flush = (): void => {
    if (!buffer) return;

    // Never patch a modified occurrence: its properties describe one instance,
    // and rewriting them from a series-scoped edit is precisely the silent
    // series rewrite the adapter refuses to perform.
    const isOverride = buffer.some((line) => /^RECURRENCE-ID[;:]/i.test(line));

    if (!isOverride) {
      const seen = new Set<string>();
      const depth: string[] = [];

      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer[index]!;
        const property = parseLine(line);
        if (!property) continue;

        if (property.name === 'BEGIN') {
          depth.push(property.value.trim().toUpperCase());
          continue;
        }
        if (property.name === 'END') {
          depth.pop();
          continue;
        }
        // Inside a VALARM or other nested component — leave it alone.
        if (depth.length > 0) continue;

        const replacement = replacements.get(property.name);
        if (replacement !== undefined) {
          buffer[index] = replacement;
          seen.add(property.name);
          continue;
        }

        // SEQUENCE increments on every change, per RFC 5545. Servers and other
        // clients use it to decide which copy of an event is newer.
        if (property.name === 'SEQUENCE') {
          const current = Number(property.value.trim());
          buffer[index] = `SEQUENCE:${Number.isFinite(current) ? current + 1 : 1}`;
        }
      }

      // Anything the event did not already have gets appended.
      for (const [name, line] of replacements) {
        if (!seen.has(name)) buffer.push(line);
      }
    }

    out.push(...buffer);
    buffer = null;
  };

  for (const line of lines) {
    const property = parseLine(line);
    const name = property?.name;

    if (name === 'BEGIN' && property!.value.trim().toUpperCase() === 'VEVENT' && !buffer) {
      out.push(line);
      buffer = [];
      continue;
    }

    if (name === 'END' && property!.value.trim().toUpperCase() === 'VEVENT' && buffer) {
      flush();
      out.push(line);
      continue;
    }

    if (buffer) buffer.push(line);
    else out.push(line);
  }

  flush();

  return `${out.map(fold).join('\r\n')}\r\n`;
}
