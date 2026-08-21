'use client';

/**
 * The week grid's interactive half: everything from here down runs in the
 * browser because dragging needs a live cursor position, which a server
 * component cannot see. Layout math (which hour a pixel maps to) is kept
 * identical to the server-rendered version above it in `calendar/page.tsx` —
 * duplicated rather than shared, because the two run in different runtimes
 * and passing functions across that boundary is not an option.
 */
import { useRef, useState, useTransition } from 'react';
import { fromLocal, startOfLocalDay, toLocal } from '@fluid/core';
import { formatTime } from '@/components/format';
import { moveScheduledBlock } from '@/app/actions';

export interface WeekGridBlock {
  id: string;
  startsAt: Date;
  endsAt: Date;
  state: string;
  task: { title: string };
}

export interface WeekGridEvent {
  id: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
}

export interface WeekGridRoutine {
  start: Date;
  end: Date;
  label: string;
}

export interface WeekGridProps {
  days: Date[];
  blocks: WeekGridBlock[];
  events: WeekGridEvent[];
  /** Recurring routines, already expanded to concrete instants for this week. */
  routines: WeekGridRoutine[];
  timeZone: string;
  startHour: number;
  totalHours: number;
  /**
   * Drops the weekday/date header row. The planner's single-day pane sits
   * under a header that already names the day — repeating it inside the grid
   * just pushes the timeline down.
   */
  hideDayHeader?: boolean;
}

/** Aligns a drop — or a resized edge — to a readable grid, not an arbitrary minute. */
const SLOT_MINUTES = 15;
/** A block can never be resized shorter than one slot. */
const MIN_DURATION_MS = SLOT_MINUTES * 60_000;

interface DragState {
  blockId: string;
  durationMs: number;
}

interface PreviewState {
  dayIndex: number;
  /** Minutes after `startHour`, already snapped. */
  minutesFromStart: number;
}

type ResizeEdge = 'start' | 'end';

interface ResizeState {
  blockId: string;
  edge: ResizeEdge;
  startsAt: Date;
  endsAt: Date;
}

/** Everything a resize needs that must not change mid-drag, cached at pointerdown. */
interface ResizeContext {
  columnTop: number;
  columnHeight: number;
  day: Date;
  originalStart: Date;
  originalEnd: Date;
}

function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = toLocal(a, timeZone);
  const right = toLocal(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function WeekGrid({
  days,
  blocks,
  events,
  routines,
  timeZone,
  startHour,
  totalHours,
  hideDayHeader = false,
}: WeekGridProps) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Read inside a pointermove handler, never used to trigger a render itself —
  // a ref, not state, because storing it as state would mean every pixel of
  // pointer movement re-renders the whole grid just to read a value back out.
  const resizeContext = useRef<ResizeContext | null>(null);

  const offsetPercent = (date: Date): number => {
    const local = toLocal(date, timeZone);
    const minutes = local.hour * 60 + local.minute - startHour * 60;
    return Math.max(0, Math.min(100, (minutes / (totalHours * 60)) * 100));
  };

  /** `minutesFromStart` (already snapped to the slot grid) on the given day. */
  const dateAtMinutes = (day: Date, minutesFromStart: number): Date => {
    const dayLocal = toLocal(day, timeZone);
    return fromLocal(
      {
        year: dayLocal.year,
        month: dayLocal.month,
        day: dayLocal.day,
        hour: startHour + Math.floor(minutesFromStart / 60),
        minute: minutesFromStart % 60,
        second: 0,
      },
      timeZone,
    );
  };

  /** The instant a drop at this slot would produce. */
  const slotToDate = (slot: PreviewState): Date => dateAtMinutes(days[slot.dayIndex]!, slot.minutesFromStart);

  /** A `clientY` reduced to a snapped, clamped minute offset from `startHour`. */
  const snappedMinutesAt = (clientY: number, columnTop: number, columnHeight: number): number => {
    const fraction = (clientY - columnTop) / columnHeight;
    const raw = fraction * totalHours * 60;
    const snapped = Math.round(raw / SLOT_MINUTES) * SLOT_MINUTES;
    return Math.max(0, Math.min(totalHours * 60, snapped));
  };

  const handleDragOver = (dayIndex: number) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // Required for onDrop to fire at all — the browser refuses to accept a
    // drop on an element unless dragover explicitly opts in.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const clamped = Math.min(
      totalHours * 60 - SLOT_MINUTES,
      snappedMinutesAt(event.clientY, rect.top, rect.height),
    );

    setPreview((current) =>
      current?.dayIndex === dayIndex && current.minutesFromStart === clamped
        ? current
        : { dayIndex, minutesFromStart: clamped },
    );
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const current = dragging;
    const slot = preview;
    setDragging(null);
    setPreview(null);
    if (!current || !slot) return;

    const startsAt = slotToDate(slot);
    const endsAt = new Date(startsAt.getTime() + current.durationMs);

    startTransition(async () => {
      const result = await moveScheduledBlock({ blockId: current.blockId, startsAt, endsAt });
      setError(result.error ?? null);
    });
  };

  /**
   * Start resizing from a top or bottom handle.
   *
   * Pointer events rather than native drag-and-drop: a resize needs to track
   * the cursor continuously against a fixed anchor (the edge that does not
   * move), and native DnD gives no live position outside of `dragover`'s
   * per-element callback — awkward for a thin handle the cursor easily drifts
   * off. `setPointerCapture` redirects every subsequent event to this element
   * regardless of what is under the cursor, which is exactly what a resize
   * that overshoots the handle needs.
   */
  const beginResize = (block: WeekGridBlock, edge: ResizeEdge, day: Date) => (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    // Stops the pointerdown from also being read as the start of the block's
    // own native drag gesture — belt-and-braces alongside `draggable={false}`
    // on the handle itself.
    event.stopPropagation();

    const column = event.currentTarget.closest('.cal-col');
    if (!column) return;
    const rect = column.getBoundingClientRect();

    resizeContext.current = {
      columnTop: rect.top,
      columnHeight: rect.height,
      day,
      originalStart: block.startsAt,
      originalEnd: block.endsAt,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing({ blockId: block.id, edge, startsAt: block.startsAt, endsAt: block.endsAt });
  };

  const handleResizeMove = (blockId: string, edge: ResizeEdge) => (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const context = resizeContext.current;
    if (!context) return;

    const minutes = snappedMinutesAt(event.clientY, context.columnTop, context.columnHeight);
    const candidate = dateAtMinutes(context.day, minutes);

    if (edge === 'end') {
      const minEnd = new Date(context.originalStart.getTime() + MIN_DURATION_MS);
      const endsAt = candidate.getTime() < minEnd.getTime() ? minEnd : candidate;
      setResizing({ blockId, edge, startsAt: context.originalStart, endsAt });
    } else {
      const maxStart = new Date(context.originalEnd.getTime() - MIN_DURATION_MS);
      const startsAt = candidate.getTime() > maxStart.getTime() ? maxStart : candidate;
      setResizing({ blockId, edge, startsAt, endsAt: context.originalEnd });
    }
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    const result = resizing;
    resizeContext.current = null;
    setResizing(null);
    if (!result) return;

    startTransition(async () => {
      const outcome = await moveScheduledBlock({
        blockId: result.blockId,
        startsAt: result.startsAt,
        endsAt: result.endsAt,
      });
      setError(outcome.error ?? null);
    });
  };

  return (
    <div className="card bg-base-100 border-base-200 overflow-hidden border shadow-sm">
      {error ? (
        <div role="alert" className="alert alert-error alert-soft m-3 text-sm">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/*
        Scrolls sideways when the columns cannot all fit. `minmax(7rem, 1fr)`
        is what makes that work: columns share the space when there is enough
        and stop shrinking at a readable width when there is not, rather than
        collapsing into unreadable slivers the way `minmax(0, 1fr)` did.
      */}
      <div className="overflow-x-auto">
        <div
          className="grid min-w-max"
          style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(7rem, 1fr))` }}
        >
        {hideDayHeader ? null : (
          <>
            <div className="border-base-200 border-b" />
            {days.map((day) => {
              const local = toLocal(day, timeZone);
              const isToday = isSameLocalDay(day, new Date(), timeZone);
              return (
                <div key={day.toISOString()} className="border-base-200 border-b border-l py-4 text-center">
                  <div
                    className={`text-[0.65rem] font-semibold uppercase tracking-[0.12em] ${
                      isToday ? 'text-primary' : 'text-base-content/40'
                    }`}
                  >
                    {new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(day)}
                  </div>
                  <div className={`mt-1 text-2xl font-bold tracking-tight ${isToday ? 'text-primary' : ''}`}>
                    {local.day}
                  </div>
                </div>
              );
            })}
          </>
        )}

        <div className="relative" style={{ height: `${totalHours * 4}rem` }}>
          {Array.from({ length: totalHours + 1 }, (_, index) => startHour + index)
            .filter((hour) => (hour - startHour) % 2 === 0)
            .map((hour) => (
              <span
                key={hour}
                className="text-base-content/35 absolute right-2.5 -translate-y-1/2 text-[0.65rem] font-medium"
                style={{ top: `${((hour - startHour) / totalHours) * 100}%` }}
              >
                {`${((hour + 11) % 12) + 1} ${hour < 12 || hour === 24 ? 'AM' : 'PM'}`}
              </span>
            ))}
        </div>

        {days.map((day, dayIndex) => {
          const dayBlocks = blocks.filter((block) => isSameLocalDay(block.startsAt, day, timeZone));
          const dayEvents = events.filter((event) => isSameLocalDay(event.startsAt, day, timeZone));
          // Clipped to this day's own [00:00, 24:00) window, rather than
          // filtered by start day alone — an overnight routine like "Sleep"
          // (23:00-06:30) would otherwise compute a negative height on the
          // day it starts and never appear on the day it ends. Clipping is
          // display-only: the underlying rule is untouched, so this can never
          // drift from what the scheduler actually protects.
          const dayStart = startOfLocalDay(day, timeZone);
          const dayEnd = startOfLocalDay(day, timeZone, 1);
          const dayRoutines = routines
            .filter((routine) => routine.start < dayEnd && routine.end > dayStart)
            .map((routine) => ({
              ...routine,
              start: routine.start < dayStart ? dayStart : routine.start,
              end: routine.end > dayEnd ? dayEnd : routine.end,
            }));
          const showPreview = preview?.dayIndex === dayIndex && dragging;

          return (
            <div
              key={day.toISOString()}
              className="cal-col border-base-200 border-l"
              style={{ height: `${totalHours * 4}rem` }}
              onDragOver={handleDragOver(dayIndex)}
              onDrop={handleDrop}
            >
              {Array.from({ length: totalHours + 1 }, (_, index) => (
                <div key={index} className="cal-line" style={{ top: `${(index / totalHours) * 100}%` }} />
              ))}

              {/*
                Rendered first, so real events and scheduled work always sit
                visually on top on the rare occasion they overlap — routines
                are context, not the plan.
              */}
              {dayRoutines.map((routine, index) => {
                const top = offsetPercent(routine.start);
                const height = Math.max(3, offsetPercent(routine.end) - top);
                return (
                  <div
                    key={`${routine.label}-${index}`}
                    className="cal-evt cal-evt-routine"
                    style={{ top: `${top}%`, height: `${height}%` }}
                    title={`${routine.label} · ${formatTime(routine.start, timeZone)}–${formatTime(routine.end, timeZone)}`}
                  >
                    <div className="truncate font-medium">{routine.label}</div>
                  </div>
                );
              })}

              {dayEvents.map((event) => {
                const top = offsetPercent(event.startsAt);
                const height = Math.max(3, offsetPercent(event.endsAt) - top);
                return (
                  <div
                    key={event.id}
                    className="cal-evt cal-evt-external"
                    style={{ top: `${top}%`, height: `${height}%` }}
                    title={`${event.title} · ${formatTime(event.startsAt, timeZone)}`}
                  >
                    <div className="text-base-content/50 text-[0.62rem]">
                      {formatTime(event.startsAt, timeZone)}
                    </div>
                    <div className="text-base-content/80 truncate font-semibold">{event.title}</div>
                  </div>
                );
              })}

              {dayBlocks.map((block) => {
                const beingResized = resizing?.blockId === block.id;
                // While a resize is live, its own in-progress times drive the
                // block's position — otherwise the edge under the cursor would
                // visibly lag a slot behind where it will actually land.
                const liveStart = beingResized ? resizing.startsAt : block.startsAt;
                const liveEnd = beingResized ? resizing.endsAt : block.endsAt;
                const top = offsetPercent(liveStart);
                const height = Math.max(3, offsetPercent(liveEnd) - top);
                const proposed = block.state === 'PROPOSED';
                // Only a committed block is ours to pick up — a proposal is
                // still awaiting a yes/no on Today, and dragging it here would
                // let two different screens disagree about whether it exists.
                const adjustable = block.state === 'ACCEPTED' && !pending;
                const draggable = adjustable && !beingResized;
                const beingDragged = dragging?.blockId === block.id;

                return (
                  <div
                    key={block.id}
                    className={`cal-evt ${proposed ? 'cal-evt-proposed' : ''} ${
                      draggable ? 'cal-evt-draggable' : ''
                    } ${beingDragged ? 'cal-evt-lifted' : ''}`}
                    style={{ top: `${top}%`, height: `${height}%` }}
                    title={`${block.task.title} · ${formatTime(liveStart, timeZone)}–${formatTime(liveEnd, timeZone)}${draggable ? ' · drag to move, or its edges to resize' : ''}`}
                    draggable={draggable}
                    onDragStart={(event) => {
                      if (!draggable) return;
                      // Firefox refuses to start a native drag without this
                      // set, even though the payload itself goes unused —
                      // the drop handler already has the block id in state.
                      event.dataTransfer.setData('text/plain', block.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging({
                        blockId: block.id,
                        durationMs: block.endsAt.getTime() - block.startsAt.getTime(),
                      });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setPreview(null);
                    }}
                  >
                    {adjustable ? (
                      <div
                        className="cal-resize-handle cal-resize-handle-top"
                        draggable={false}
                        onPointerDown={beginResize(block, 'start', day)}
                        onPointerMove={handleResizeMove(block.id, 'start')}
                        onPointerUp={endResize}
                      />
                    ) : null}

                    <div className="text-primary/70 text-[0.62rem]">
                      {formatTime(liveStart, timeZone)}
                      {beingResized ? ' · resizing' : ''}
                    </div>
                    <div className="line-clamp-2 font-semibold">{block.task.title}</div>
                    <div className="text-base-content/40 mt-0.5 text-[0.6rem]">
                      {proposed ? 'Awaiting your OK' : 'AI task block'}
                    </div>

                    {adjustable ? (
                      <div
                        className="cal-resize-handle cal-resize-handle-bottom"
                        draggable={false}
                        onPointerDown={beginResize(block, 'end', day)}
                        onPointerMove={handleResizeMove(block.id, 'end')}
                        onPointerUp={endResize}
                      />
                    ) : null}
                  </div>
                );
              })}

              {showPreview
                ? (() => {
                    const start = slotToDate(preview);
                    const top = ((preview.minutesFromStart / 60) / totalHours) * 100;
                    const height = Math.max(
                      3,
                      (dragging.durationMs / 60_000 / 60 / totalHours) * 100,
                    );
                    return (
                      <div
                        className="cal-evt-preview flex items-start px-2 py-1"
                        style={{ top: `${top}%`, height: `${height}%` }}
                      >
                        <span className="text-primary text-[0.65rem] font-semibold">
                          {formatTime(start, timeZone)}
                        </span>
                      </div>
                    );
                  })()
                : null}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
