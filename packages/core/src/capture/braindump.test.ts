import { describe, expect, it } from 'vitest';
import { parseBraindump } from './braindump';

// Thursday, so "friday" is one day ahead and "monday" is four.
const THURSDAY = { todayDayOfWeek: 4 };

describe('parseBraindump', () => {
  it('splits a run-on sentence into separate pieces of work', () => {
    const items = parseBraindump(
      'I need to organise lights for Saturday, ring Steve about the trailer, order the new XLR leads sometime this month, finish the event poster tomorrow.',
      THURSDAY,
    );

    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.map((item) => item.title.toLowerCase()).join(' | ')).toContain('steve');
  });

  it('splits on newlines and bullets', () => {
    const items = parseBraindump('- Fix the server\n- Call the supplier\n• Write the FAQ', THURSDAY);
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toBe('Fix the server');
    expect(items[2]!.title).toBe('Write the FAQ');
  });

  it('strips leading filler from a title', () => {
    const [item] = parseBraindump('I need to ring Steve about the trailer', THURSDAY);
    expect(item!.title).toBe('Ring Steve about the trailer');
  });

  it('reads an explicit duration and removes it from the title', () => {
    const [item] = parseBraindump('Write the FAQ 90 mins', THURSDAY);
    expect(item!.estimateMinutes).toBe(90);
    expect(item!.title).toBe('Write the FAQ');
  });

  it('converts hours to minutes', () => {
    const [item] = parseBraindump('Deep clean the workshop 2 hours', THURSDAY);
    expect(item!.estimateMinutes).toBe(120);
  });

  it('ignores a bare number that is part of the task', () => {
    const [item] = parseBraindump('Order 40 cable ties', THURSDAY);
    expect(item!.estimateMinutes).toBeUndefined();
    expect(item!.title).toBe('Order 40 cable ties');
  });

  it('resolves tomorrow to one day out', () => {
    const [item] = parseBraindump('Finish the event poster tomorrow', THURSDAY);
    expect(item!.dueInDays).toBe(1);
    expect(item!.title).toBe('Finish the event poster');
  });

  it('resolves a named weekday to its next occurrence', () => {
    const [item] = parseBraindump('Organise lights for Saturday', THURSDAY);
    expect(item!.dueInDays).toBe(2);
  });

  it('treats a weekday that has passed this week as next week', () => {
    // Thursday asking about Monday means the Monday coming, not three days ago.
    const [item] = parseBraindump('Send the invoice on Monday', THURSDAY);
    expect(item!.dueInDays).toBe(4);
  });

  it('maps vague horizons to buckets rather than dates', () => {
    const [month] = parseBraindump('Order the new XLR leads sometime this month', THURSDAY);
    expect(month!.bucket).toBe('THIS_MONTH');
    expect(month!.dueInDays).toBeUndefined();
    // The word that only existed to introduce the horizon goes with it.
    expect(month!.title).toBe('Order the new XLR leads');

    const [someday] = parseBraindump('Learn to weld someday', THURSDAY);
    expect(someday!.bucket).toBe('SOMEDAY');
  });

  it('picks up priority words', () => {
    const [urgent] = parseBraindump('Renew the insurance urgent', THURSDAY);
    expect(urgent!.priority).toBe('URGENT');

    const [low] = parseBraindump('Tidy the cable drawer whenever', THURSDAY);
    expect(low!.priority).toBe('LOW');
  });

  it('keeps the original fragment so the parse can be checked', () => {
    const [item] = parseBraindump('I need to ring Steve tomorrow', THURSDAY);
    expect(item!.source).toBe('I need to ring Steve tomorrow');
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(parseBraindump('', THURSDAY)).toEqual([]);
    expect(parseBraindump('   \n  \n ', THURSDAY)).toEqual([]);
  });

  it('never produces an empty title', () => {
    const items = parseBraindump('tomorrow\n- \nurgent', THURSDAY);
    for (const item of items) expect(item.title.length).toBeGreaterThan(0);
  });

  it('caps a very long title rather than storing an essay', () => {
    const [item] = parseBraindump('a'.repeat(500), THURSDAY);
    expect(item!.title.length).toBeLessThanOrEqual(200);
  });
});
