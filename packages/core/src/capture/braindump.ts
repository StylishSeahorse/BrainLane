/**
 * Turning one unstructured thought into separate pieces of work.
 *
 * The moment worth designing for is the one where somebody has six things in
 * their head at once and no chance of entering them one at a time through a
 * form. They type the lot into a box; this splits it up.
 *
 * Deterministic on purpose. A parser that works with no API key, offline, and
 * identically every time is worth more here than a cleverer one that
 * sometimes cannot run — and because nothing is written until the user
 * confirms the parse, a wrong guess costs a click rather than a wrong task.
 * The output is a *proposal*, which is why every field is optional and the
 * original text is kept.
 */

export type BraindumpBucket = 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY';
export type BraindumpPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface BraindumpItem {
  /** Cleaned-up task title. */
  title: string;
  /** The fragment this came from, so the user can see what was interpreted. */
  source: string;
  estimateMinutes?: number;
  bucket?: BraindumpBucket;
  priority?: BraindumpPriority;
  /** Days from today, when the text named one. 0 = today, 1 = tomorrow. */
  dueInDays?: number;
  /** Plain-language note about what was inferred, shown beside the row. */
  hints: string[];
}

/**
 * Verbs common enough at the start of a jotted-down task to be a reliable
 * signal that a comma began a new one.
 *
 * A curated list rather than "split on every comma": people write single
 * tasks containing lists ("email Steve about the trailer, the lights and the
 * poster"), and shredding one of those into three is a worse failure than
 * leaving two tasks joined — the confirmation screen makes the second easy to
 * fix and the first tedious.
 */
const ACTION_VERBS = [
  'ring', 'call', 'email', 'text', 'message', 'chase', 'follow up',
  'order', 'buy', 'get', 'collect', 'pick up', 'drop off', 'return',
  'finish', 'write', 'draft', 'send', 'submit', 'file', 'print', 'post',
  'book', 'schedule', 'arrange', 'organise', 'organize', 'plan', 'prep', 'prepare',
  'fix', 'repair', 'replace', 'install', 'build', 'make', 'design', 'test', 'deploy',
  'clean', 'tidy', 'sort', 'check', 'review', 'read', 'update', 'renew', 'pay',
  'confirm', 'cancel', 'back up', 'sign', 'reply',
].join('|');

/** Splits on newlines, bullets, semicolons, and clause-starting commas. */
function fragments(input: string): string[] {
  const commaSplit = new RegExp(
    // A comma (optionally "and"/"then") followed by something that reads like
    // the start of a new instruction.
    `,\\s*(?=(?:and\\s+|then\\s+)?(?:i\\s+(?:need|have|want|must|should)\\b|(?:${ACTION_VERBS})\\b))`,
    'i',
  );

  return input
    .split(/\r?\n|;|\s+and\s+then\s+/i)
    .flatMap((line) => line.split(commaSplit))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseDuration(text: string): { minutes?: number; matched?: string } {
  // Require an explicit unit — a bare "40" is far more likely to be part of
  // the task ("order 40 cable ties") than an estimate.
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i);
  if (!match) return {};

  const value = Number(match[1]);
  const isHours = /^h/i.test(match[2]!);
  const minutes = Math.round(isHours ? value * 60 : value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) return {};

  return { minutes, matched: match[0] };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Relative dates only.
 *
 * "Tomorrow" and "Friday" are unambiguous to a person and cheap to resolve.
 * Absolute dates are deliberately left alone: getting "3/4" wrong by a
 * continent is worse than not guessing, and the confirmation screen lets the
 * user set a date properly.
 */
function parseWhen(
  text: string,
  todayDayOfWeek: number,
): { dueInDays?: number; bucket?: BraindumpBucket; matched?: string } {
  const lower = text.toLowerCase();

  if (/\btoday\b/.test(lower)) return { dueInDays: 0, matched: 'today' };
  if (/\btomorrow\b/.test(lower)) return { dueInDays: 1, matched: 'tomorrow' };
  if (/\bnext week\b/.test(lower)) return { bucket: 'SOON', matched: 'next week' };
  if (/\bthis week\b/.test(lower)) return { bucket: 'SOON', matched: 'this week' };
  if (/\bthis month\b|\bsometime this month\b/.test(lower)) {
    return { bucket: 'THIS_MONTH', matched: 'this month' };
  }
  if (/\bnext month\b/.test(lower)) return { bucket: 'THIS_MONTH', matched: 'next month' };
  if (/\bthis quarter\b/.test(lower)) return { bucket: 'THIS_QUARTER', matched: 'this quarter' };
  if (/\bsomeday\b|\beventually\b|\bone day\b/.test(lower)) {
    return { bucket: 'SOMEDAY', matched: 'someday' };
  }

  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    const day = WEEKDAYS[index]!;
    if (!new RegExp(`\\b(?:on\\s+)?${day}\\b`).test(lower)) continue;
    // Always the *next* occurrence: naming a weekday that has passed this week
    // means the one coming, not one in the past.
    const ahead = (index - todayDayOfWeek + 7) % 7 || 7;
    return { dueInDays: ahead, matched: day };
  }

  return {};
}

function parsePriority(text: string): { priority?: BraindumpPriority; matched?: string } {
  const lower = text.toLowerCase();
  if (/\burgent\b|\basap\b|\bcritical\b/.test(lower)) return { priority: 'URGENT', matched: 'urgent' };
  if (/\bimportant\b|\bhigh priority\b|\bmust\b/.test(lower)) {
    return { priority: 'HIGH', matched: 'important' };
  }
  if (/\bwhenever\b|\blow priority\b|\bno rush\b/.test(lower)) {
    return { priority: 'LOW', matched: 'no rush' };
  }
  return {};
}

/** Strips leading filler so "I need to ring Steve" becomes "Ring Steve". */
function cleanTitle(text: string): string {
  let title = text
    // Bullet characters survive the newline split, so they are stripped here
    // rather than in the splitter — one place that owns "what a title looks
    // like" beats two that have to agree.
    .replace(/^\s*[-*•·–—]+\s*/, '')
    .replace(/^(?:and\s+)?(?:i\s+(?:need|have|want|must|should)\s+to\s+|i\s+need\s+|then\s+|also\s+|remember\s+to\s+|don'?t\s+forget\s+to\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Words that only existed to introduce a date or duration we have already
    // extracted — "order the leads sometime" reads as an unfinished sentence.
    .replace(/\s+(?:sometime|some\s*time|by|on|in|for|at|before|around)$/i, '')
    .trim()
    .replace(/[.,;]+$/, '');

  if (title.length > 0) title = title.charAt(0).toUpperCase() + title.slice(1);
  return title.slice(0, 200);
}

export interface BraindumpOptions {
  /** 0 = Sunday. Used to resolve named weekdays. */
  todayDayOfWeek: number;
}

export function parseBraindump(input: string, options: BraindumpOptions): BraindumpItem[] {
  const items: BraindumpItem[] = [];

  for (const fragment of fragments(input)) {
    const duration = parseDuration(fragment);
    const when = parseWhen(fragment, options.todayDayOfWeek);
    const priority = parsePriority(fragment);

    // The matched phrases come out of the title — "Finish the poster tomorrow"
    // becomes "Finish the poster" with a due date, not a task whose name
    // contains a date that will be wrong by Thursday.
    let remaining = fragment;
    for (const matched of [duration.matched, when.matched, priority.matched]) {
      if (!matched) continue;
      remaining = remaining.replace(new RegExp(`\\b(?:by|on|in|for)?\\s*${matched}\\b`, 'i'), ' ');
    }

    const title = cleanTitle(remaining) || cleanTitle(fragment);
    if (!title) continue;

    const hints: string[] = [];
    if (when.dueInDays === 0) hints.push('due today');
    else if (when.dueInDays === 1) hints.push('due tomorrow');
    else if (when.dueInDays != null) hints.push(`due in ${when.dueInDays} days`);
    if (when.bucket) hints.push(when.bucket.toLowerCase().replace(/_/g, ' '));
    if (duration.minutes) hints.push(`${duration.minutes} min`);
    if (priority.priority) hints.push(priority.priority.toLowerCase());

    items.push({
      title,
      source: fragment,
      hints,
      ...(duration.minutes ? { estimateMinutes: duration.minutes } : {}),
      ...(when.bucket ? { bucket: when.bucket } : {}),
      ...(when.dueInDays != null ? { dueInDays: when.dueInDays } : {}),
      ...(priority.priority ? { priority: priority.priority } : {}),
    });
  }

  return items;
}
