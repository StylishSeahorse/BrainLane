import { describe, expect, it } from 'vitest';
import { computeCapacity, verdictFor, type CapacityInput } from './capacity';

const at = (hhmm: string) => new Date(`2026-06-15T${hhmm}:00Z`);
const span = (start: string, end: string) => ({ start: at(start), end: at(end) });

/** A 9-to-5 Monday with nothing in it. */
function makeInput(overrides: Partial<CapacityInput> = {}): CapacityInput {
  return {
    day: span('00:00', '23:59'),
    workable: [span('09:00', '17:00')],
    protectedTimes: [],
    meetings: [],
    planned: [],
    bufferMinutes: 0,
    ...overrides,
  };
}

describe('computeCapacity', () => {
  it('reports the whole working day when nothing is booked', () => {
    const capacity = computeCapacity(makeInput());

    expect(capacity.workableMinutes).toBe(480);
    expect(capacity.capacityMinutes).toBe(480);
    expect(capacity.freeMinutes).toBe(480);
    expect(verdictFor(capacity)).toBe('empty');
  });

  it('ignores time outside working hours', () => {
    // A 7am meeting does not reduce a 9-to-5 capacity, and reporting a deficit
    // someone cannot act on is worse than reporting nothing.
    const capacity = computeCapacity(makeInput({ meetings: [span('07:00', '08:00')] }));

    expect(capacity.meetingMinutes).toBe(0);
    expect(capacity.capacityMinutes).toBe(480);
  });

  it('charges a minute once when a meeting and a routine overlap', () => {
    const capacity = computeCapacity(
      makeInput({
        meetings: [span('12:00', '13:00')],
        protectedTimes: [span('12:00', '13:00')],
      }),
    );

    expect(capacity.meetingMinutes).toBe(60);
    expect(capacity.protectedMinutes).toBe(0);
    expect(capacity.capacityMinutes).toBe(420);
  });

  it('counts buffers once per session, not once per gap', () => {
    // Two sessions, ten minutes of transition each. Charging both ends would
    // double-bill every block in the day.
    const capacity = computeCapacity(
      makeInput({
        planned: [span('09:00', '10:00'), span('11:00', '12:00')],
        bufferMinutes: 10,
      }),
    );

    expect(capacity.plannedMinutes).toBe(120);
    expect(capacity.bufferMinutes).toBe(20);
    expect(capacity.committedMinutes).toBe(140);
  });

  it('keeps completed work out of what the day still owes', () => {
    const capacity = computeCapacity(
      makeInput({
        planned: [span('14:00', '15:00')],
        completed: [span('09:00', '11:00')],
      }),
    );

    expect(capacity.completedMinutes).toBe(120);
    expect(capacity.plannedMinutes).toBe(60);
    expect(capacity.committedMinutes).toBe(60);
  });

  it('reports overcommitment rather than silently trimming it', () => {
    const capacity = computeCapacity(
      makeInput({ planned: [span('09:00', '17:00'), span('09:00', '11:00')] }),
    );

    expect(capacity.overcommittedMinutes).toBe(120);
    expect(capacity.freeMinutes).toBe(0);
    expect(verdictFor(capacity)).toBe('over');
  });

  // -------------------------------------------------------------------------
  // Personal time
  //
  // The whole point of an area that does not count toward capacity: the time
  // is still gone, but it is not work you promised to deliver.
  // -------------------------------------------------------------------------
  describe('non-working areas', () => {
    it('removes personal time from capacity without counting it as work', () => {
      const capacity = computeCapacity(makeInput({ personal: [span('11:00', '12:00')] }));

      expect(capacity.personalMinutes).toBe(60);
      // The hour is genuinely gone from the working day...
      expect(capacity.capacityMinutes).toBe(420);
      // ...but nothing was promised, so nothing is owed.
      expect(capacity.committedMinutes).toBe(0);
      expect(capacity.plannedMinutes).toBe(0);
    });

    it('does not invent free time by simply dropping personal work', () => {
      // The failure this guards against: excluding the appointment entirely
      // would report a full 8 hours available on a day that has 7.
      const withAppointment = computeCapacity(makeInput({ personal: [span('11:00', '12:00')] }));
      const withoutAppointment = computeCapacity(makeInput());

      expect(withAppointment.capacityMinutes).toBeLessThan(withoutAppointment.capacityMinutes);
    });

    it('does not charge personal time that a meeting already covers', () => {
      const capacity = computeCapacity(
        makeInput({
          meetings: [span('11:00', '12:00')],
          personal: [span('11:00', '12:00')],
        }),
      );

      expect(capacity.meetingMinutes).toBe(60);
      expect(capacity.personalMinutes).toBe(0);
      expect(capacity.capacityMinutes).toBe(420);
    });

    it('tips a day into overcommitment once personal time is accounted for', () => {
      // Six hours of work fits an eight-hour day comfortably — until three
      // hours of it belong to someone else's ledger.
      const capacity = computeCapacity(
        makeInput({
          personal: [span('09:00', '12:00')],
          planned: [span('12:00', '17:00'), span('13:00', '14:00')],
        }),
      );

      expect(capacity.capacityMinutes).toBe(300);
      expect(capacity.committedMinutes).toBe(360);
      expect(verdictFor(capacity)).toBe('over');
    });

    it('leaves capacity untouched when every area counts', () => {
      // The default path must be byte-identical to the behaviour before areas
      // existed, or every existing day silently re-scores itself.
      const withEmpty = computeCapacity(makeInput({ personal: [] }));
      const withUndefined = computeCapacity(makeInput());

      expect(withEmpty).toEqual(withUndefined);
      expect(withUndefined.personalMinutes).toBe(0);
    });
  });
});
