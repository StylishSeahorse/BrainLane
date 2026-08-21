'use client';

/**
 * The week board: days as columns, work as cards.
 *
 * Sunsama's central claim, made structural — a task is not a commitment until
 * it is on a day. Dragging a card from the backlog into Wednesday is the
 * moment "this exists" becomes "I am doing this", and the column's capacity
 * bar answers the question that decision actually depends on: does it fit?
 *
 * The AI's role here is deliberately quiet. It does not decide which day work
 * belongs to — the user does that — it decides *when within the day*, and the
 * card shows the time it chose. Motion's engine underneath Sunsama's surface.
 *
 * Drag-and-drop is the fast path, never the only one. Native HTML5 dragging is
 * invisible to keyboards and awkward on touch, so every card also carries a
 * "Move to" menu with the same options. That is not a nicety: this is an app
 * used one-handed on a phone, mid-transition, by people for whom a fiddly
 * gesture is the difference between planning and not.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { commitTaskToDay, reorderBoardDay } from '@/app/actions';
import { formatDuration, formatTime, relativeDays } from '@/components/format';
import { CheckIcon, TimerIcon } from '@/components/icons';

export interface BoardCard {
  id: string;
  title: string;
  status: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  energy: 'LOW' | 'MEDIUM' | 'HIGH';
  estimateMinutes: number;
  actualMinutes: number;
  deadline: Date | null;
  rolloverCount: number;
  timerStartedAt: Date | null;
  project: { id: string; name: string; color: string | null } | null;
  area: { id: string; name: string; color: string | null; countsTowardCapacity: boolean } | null;
  objective: { id: string; title: string } | null;
  subtasks: Array<{ id: string; status: string }>;
  scheduledBlocks: Array<{ id: string; startsAt: Date; endsAt: Date; state: string }>;
}

export interface BoardColumn {
  /** `YYYY-MM-DD` in the user's zone — the identity the board is keyed by. */
  key: string;
  label: string;
  dayNumber: string;
  isToday: boolean;
  isPast: boolean;
  capacityMinutes: number;
  /** Minutes the scheduler has actually placed on this day. */
  bookedMinutes: number;
  meetingMinutes: number;
  isNonWorkingDay: boolean;
  hasWorkingHours: boolean;
  tasks: BoardCard[];
}

/** Where the backlog lives in drag state. Not a date, so it needs a name. */
const BACKLOG = 'backlog';

interface DropTarget {
  column: string;
  index: number;
}

export function WeekBoard({
  columns: initialColumns,
  backlog: initialBacklog,
  timeZone,
}: {
  columns: BoardColumn[];
  backlog: BoardCard[];
  timeZone: string;
}) {
  // Local state so a drop lands instantly. The server is the authority, but
  // waiting a round trip to see the card move makes the board feel broken —
  // and a planner that feels unresponsive is one people stop planning in.
  const [columns, setColumns] = useState(initialColumns);
  const [backlog, setBacklog] = useState(initialBacklog);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync when the server sends fresh data. Comparing a cheap signature
  // rather than the arrays themselves: props are new objects on every render,
  // so an identity check here would clobber the optimistic state immediately.
  const signature = `${initialColumns
    .map((column) => `${column.key}:${column.tasks.map((task) => task.id).join(',')}`)
    .join('|')}#${initialBacklog.map((task) => task.id).join(',')}`;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setColumns(initialColumns);
    setBacklog(initialBacklog);
  }, [signature, initialColumns, initialBacklog]);

  const findCard = (taskId: string): BoardCard | undefined =>
    columns.flatMap((column) => column.tasks).find((task) => task.id === taskId) ??
    backlog.find((task) => task.id === taskId);

  /**
   * Move a card, locally first and then on the server.
   *
   * The optimistic write and the request are built from the same computed
   * placement, so what the user sees and what gets persisted cannot disagree.
   */
  const move = (taskId: string, target: DropTarget) => {
    const card = findCard(taskId);
    if (!card) return;

    const from =
      columns.find((column) => column.tasks.some((task) => task.id === taskId))?.key ??
      (backlog.some((task) => task.id === taskId) ? BACKLOG : null);
    if (from === null) return;

    // Dropping a card back where it already is, at the same index, is a no-op
    // rather than a pointless round trip that re-renders the whole board.
    if (from === target.column) {
      const list = from === BACKLOG ? backlog : columns.find((c) => c.key === from)!.tasks;
      const currentIndex = list.findIndex((task) => task.id === taskId);
      if (currentIndex === target.index || currentIndex === target.index - 1) {
        setOver(null);
        return;
      }
    }

    setError(null);

    // --- Optimistic placement ---------------------------------------------
    const withoutCard = (tasks: BoardCard[]) => tasks.filter((task) => task.id !== taskId);
    const insertAt = (tasks: BoardCard[], index: number) => {
      const next = withoutCard(tasks);
      // Removing the card first shifts every later index down by one.
      const offset = tasks.findIndex((task) => task.id === taskId);
      const at = offset !== -1 && offset < index ? index - 1 : index;
      next.splice(Math.max(0, Math.min(at, next.length)), 0, card);
      return next;
    };

    const nextBacklog = target.column === BACKLOG ? insertAt(backlog, target.index) : withoutCard(backlog);
    const nextColumns = columns.map((column) => {
      if (column.key === target.column) return { ...column, tasks: insertAt(column.tasks, target.index) };
      if (column.tasks.some((task) => task.id === taskId)) {
        return { ...column, tasks: withoutCard(column.tasks) };
      }
      return column;
    });

    // The capacity bars need no separate update: each column derives its load
    // from the cards it holds plus what the scheduler has booked, so moving a
    // card moves the numbers at both ends of the drag for free.
    setColumns(nextColumns);
    setBacklog(nextBacklog);
    setOver(null);

    // --- Persist ------------------------------------------------------------
    const targetIndex = (target.column === BACKLOG ? nextBacklog : nextColumns.find((c) => c.key === target.column)!.tasks)
      .findIndex((task) => task.id === taskId);

    startTransition(async () => {
      const result = await commitTaskToDay({
        taskId,
        day: target.column === BACKLOG ? null : target.column,
        position: Math.max(0, targetIndex),
      });

      if (result.error) {
        // Put it back rather than leaving the board showing a move that did
        // not happen. A silent divergence here would be the worst outcome:
        // the user plans against a day that does not exist on the server.
        setColumns(initialColumns);
        setBacklog(initialBacklog);
        setError(result.error);
        return;
      }

      // Reordering within a day is a separate concern from committing to one,
      // so the column's final order is sent explicitly.
      if (target.column !== BACKLOG) {
        const ordered = nextColumns.find((c) => c.key === target.column)?.tasks ?? [];
        await reorderBoardDay({ day: target.column, orderedIds: ordered.map((task) => task.id) });
      }
    });
  };

  const dropHandlers = (column: string, index: number) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver((current) =>
        current?.column === column && current.index === index ? current : { column, index },
      );
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData('text/plain') || dragging;
      if (taskId) move(taskId, { column, index });
      setDragging(null);
    },
  });

  const dayOptions = columns.map((column) => ({ key: column.key, label: column.label }));

  return (
    <div className="min-w-0">
      {error ? (
        <div role="alert" className="border-error/30 bg-error/8 text-error mb-3 rounded-xl border px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
        {/* --- The uncommitted pile ---------------------------------------- */}
        <section
          className={`card bg-base-100 border-base-200 border shadow-sm ${
            over?.column === BACKLOG ? 'border-primary ring-primary/20 ring-2' : ''
          }`}
          onDragOver={dropHandlers(BACKLOG, backlog.length).onDragOver}
          onDrop={dropHandlers(BACKLOG, backlog.length).onDrop}
          onDragLeave={() => setOver(null)}
        >
          <div className="border-base-200 border-b px-3.5 py-2.5">
            <h2 className="text-sm font-semibold">Backlog</h2>
            <p className="text-base-content/45 text-xs">
              {backlog.length === 0
                ? 'Nothing waiting.'
                : `${backlog.length} not on a day yet`}
            </p>
          </div>

          <div className="max-h-[62vh] space-y-1.5 overflow-y-auto p-2">
            {backlog.length === 0 ? (
              <p className="text-base-content/40 px-1.5 py-4 text-center text-xs">
                Drag anything here to take it off a day without losing it.
              </p>
            ) : (
              backlog.map((task, index) => (
                <Card
                  key={task.id}
                  task={task}
                  timeZone={timeZone}
                  columnKey={BACKLOG}
                  dayOptions={dayOptions}
                  isDragging={dragging === task.id}
                  showInsertLine={over?.column === BACKLOG && over.index === index}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(null)}
                  onMove={move}
                  {...dropHandlers(BACKLOG, index)}
                />
              ))
            )}
          </div>
        </section>

        {/* --- The week ----------------------------------------------------- */}
        <div className="min-w-0 overflow-x-auto pb-2">
          <div className="grid min-w-[64rem] grid-cols-7 gap-2.5">
            {columns.map((column) => (
              <Column
                key={column.key}
                column={column}
                timeZone={timeZone}
                dayOptions={dayOptions}
                dragging={dragging}
                over={over}
                onDragStart={setDragging}
                onDragEnd={() => setDragging(null)}
                onMove={move}
                dropHandlers={dropHandlers}
                onLeave={() => setOver(null)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

function Column({
  column,
  timeZone,
  dayOptions,
  dragging,
  over,
  onDragStart,
  onDragEnd,
  onMove,
  dropHandlers,
  onLeave,
}: {
  column: BoardColumn;
  timeZone: string;
  dayOptions: Array<{ key: string; label: string }>;
  dragging: string | null;
  over: DropTarget | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (taskId: string, target: DropTarget) => void;
  dropHandlers: (column: string, index: number) => {
    onDragOver: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
  onLeave: () => void;
}) {
  const open = column.tasks.filter((task) => task.status !== 'DONE');
  const done = column.tasks.length - open.length;

  /**
   * How full this day really is.
   *
   * Two sources, and both are needed. `bookedMinutes` is what the scheduler
   * has actually placed here — which includes work that spilled in from
   * another day, and excludes work committed here that had to go elsewhere.
   * On top of that sits anything committed to this day that has no time yet,
   * counted at its estimate.
   *
   * Summing card estimates alone would have shown a comfortable Friday while
   * three hours of overflow from Monday sat on it; using only the booked total
   * would leave the bar motionless when a card is dropped, which is the moment
   * the number is being consulted.
   */
  const unplaced = open.filter(
    (task) => !task.scheduledBlocks.some((block) => dayKeyOf(block.startsAt, timeZone) === column.key),
  );
  const planned =
    column.bookedMinutes +
    unplaced
      // Same ledger split the server applies to booked time. Counting an
      // unplaced errand as work here while the booked version of it is
      // excluded would make the bar jump the moment the scheduler ran.
      .filter((task) => task.area?.countsTowardCapacity !== false)
      .reduce((sum, task) => sum + task.estimateMinutes, 0);

  // The denominator is real working time left after meetings and routines.
  // Without working hours there is no honest denominator, so the bar is simply
  // not drawn rather than invented.
  const over100 = column.hasWorkingHours && planned > column.capacityMinutes;
  const fill = column.capacityMinutes > 0 ? Math.min(100, (planned / column.capacityMinutes) * 100) : 0;

  const isDropTarget = over?.column === column.key;

  return (
    <section
      className={`bg-base-100 border-base-200 flex min-h-[24rem] flex-col rounded-2xl border shadow-sm transition-colors ${
        column.isToday ? 'border-primary/45' : ''
      } ${isDropTarget ? 'border-primary ring-primary/20 ring-2' : ''} ${
        column.isPast ? 'opacity-75' : ''
      }`}
      onDragOver={dropHandlers(column.key, column.tasks.length).onDragOver}
      onDrop={dropHandlers(column.key, column.tasks.length).onDrop}
      onDragLeave={onLeave}
      aria-label={column.label}
    >
      {/* --- Header: which day, and does it fit? -------------------------- */}
      <header className="border-base-200 border-b px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className={`text-sm font-semibold ${column.isToday ? 'text-primary' : ''}`}>
            {column.label}
          </h3>
          <span
            className={`text-xs tabular-nums ${
              column.isToday ? 'text-primary font-semibold' : 'text-base-content/40'
            }`}
          >
            {column.dayNumber}
          </span>
        </div>

        {column.isNonWorkingDay ? (
          <p className="text-base-content/40 mt-1 text-[0.7rem]">
            {planned > 0 ? `${formatDuration(planned)} planned · day off` : 'Day off'}
          </p>
        ) : column.hasWorkingHours ? (
          <>
            <div
              className="bg-base-200 mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full"
              role="img"
              aria-label={`${formatDuration(planned)} planned of ${formatDuration(
                column.capacityMinutes,
              )} free`}
            >
              <span
                className={`h-full ${over100 ? 'bg-error' : 'bg-primary'}`}
                style={{ width: `${fill}%` }}
              />
            </div>
            <p
              className={`mt-1 text-[0.7rem] tabular-nums ${
                over100 ? 'text-error font-medium' : 'text-base-content/45'
              }`}
            >
              {over100
                ? `${formatDuration(planned - column.capacityMinutes)} over`
                : `${formatDuration(planned)} of ${formatDuration(column.capacityMinutes)}`}
              {column.meetingMinutes > 0 ? ` · ${formatDuration(column.meetingMinutes)} in meetings` : ''}
            </p>
          </>
        ) : (
          <p className="text-base-content/40 mt-1 text-[0.7rem]">
            {planned > 0 ? formatDuration(planned) : 'Nothing yet'}
          </p>
        )}
      </header>

      {/* --- The cards ---------------------------------------------------- */}
      <div className="grow space-y-1.5 p-2">
        {column.tasks.length === 0 ? (
          <p className="text-base-content/35 px-1 py-8 text-center text-xs leading-relaxed">
            {dragging ? 'Drop here' : 'Nothing committed'}
          </p>
        ) : (
          column.tasks.map((task, index) => (
            <Card
              key={task.id}
              task={task}
              timeZone={timeZone}
              columnKey={column.key}
              dayOptions={dayOptions}
              isDragging={dragging === task.id}
              showInsertLine={isDropTarget && over.index === index}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMove={onMove}
              {...dropHandlers(column.key, index)}
            />
          ))
        )}
      </div>

      {done > 0 ? (
        <footer className="border-base-200 text-base-content/45 border-t px-3 py-1.5 text-[0.7rem]">
          {done} done
        </footer>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

function Card({
  task,
  timeZone,
  columnKey,
  dayOptions,
  isDragging,
  showInsertLine,
  onDragStart,
  onDragEnd,
  onMove,
  onDragOver,
  onDrop,
}: {
  task: BoardCard;
  timeZone: string;
  columnKey: string;
  dayOptions: Array<{ key: string; label: string }>;
  isDragging: boolean;
  showInsertLine: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (taskId: string, target: DropTarget) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  const done = task.status === 'DONE';
  const block = task.scheduledBlocks[0];
  const subtasksDone = task.subtasks.filter((subtask) => subtask.status === 'DONE').length;

  return (
    <>
      {showInsertLine ? <div className="bg-primary mx-1 h-0.5 rounded-full" aria-hidden="true" /> : null}

      <article
        draggable={!done}
        onDragStart={(event) => {
          if (done) return;
          event.dataTransfer.setData('text/plain', task.id);
          event.dataTransfer.effectAllowed = 'move';
          onDragStart(task.id);
        }}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`group border-base-200 bg-base-100 hover:border-base-300 rounded-xl border p-2 transition-all ${
          done ? 'opacity-50' : 'cursor-grab active:cursor-grabbing'
        } ${isDragging ? 'opacity-35' : ''} ${
          task.priority === 'URGENT' && !done ? 'border-l-error border-l-[3px]' : ''
        }`}
      >
        <div className="flex items-start gap-1.5">
          {/*
            Area colour first, project colour second. The area is the coarser
            grouping and therefore the one worth being able to scan a week by;
            the project is already named in the row beneath.
          */}
          {task.area?.color || task.project?.color ? (
            <span
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ backgroundColor: task.area?.color ?? task.project!.color! }}
              title={task.area?.name ?? task.project!.name}
              aria-hidden="true"
            />
          ) : null}

          <p className={`min-w-0 grow text-[0.82rem] font-medium leading-snug ${done ? 'line-through' : ''}`}>
            {task.title}
          </p>

          {/*
            The keyboard and touch path to the same move the drag performs.
            `details` rather than a JS menu so it works before hydration.
          */}
          {!done ? (
            <details className="dropdown dropdown-end shrink-0">
              {/*
                Always visible, not hover-revealed. A control that only exists
                under a mouse pointer does not exist at all on a phone, and the
                phone is where this app gets used standing up — which is
                exactly when dragging a card is hardest and the menu matters
                most. Low contrast until hover keeps the column quiet without
                making the affordance a secret.
              */}
              <summary
                className="btn btn-ghost btn-xs btn-square text-base-content/25 hover:text-base-content focus-visible:text-base-content -mr-0.5 -mt-0.5 transition-colors"
                aria-label={`Move “${task.title}” to another day`}
              >
                <MoveIcon />
              </summary>
              <ul className="dropdown-content menu bg-base-100 border-base-200 z-20 w-40 rounded-xl border p-1 text-xs shadow-lg">
                {dayOptions
                  .filter((option) => option.key !== columnKey)
                  .map((option) => (
                    <li key={option.key}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          onMove(task.id, { column: option.key, index: 0 });
                        }}
                      >
                        {option.label}
                      </button>
                    </li>
                  ))}
                {columnKey !== BACKLOG ? (
                  <li>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.removeAttribute('open');
                        onMove(task.id, { column: BACKLOG, index: 0 });
                      }}
                    >
                      Back to backlog
                    </button>
                  </li>
                ) : null}
              </ul>
            </details>
          ) : null}
        </div>

        {/* --- The facts that change the decision ------------------------- */}
        <div className="text-base-content/45 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.68rem]">
          {done ? (
            <span className="text-success inline-flex items-center gap-0.5">
              <CheckIcon className="size-3" /> done
            </span>
          ) : (
            <span className="tabular-nums">{formatDuration(task.estimateMinutes)}</span>
          )}

          {/*
            The AI's answer to "when", shown on the card the user placed. This
            is the seam between the two products: the day is the user's call,
            the time inside it is the scheduler's.

            When the scheduler could not honour the day — the column was full,
            or the task cannot start until later — the card says so instead of
            showing a time that belongs to a different day. A planner that
            quietly relocates work is one you stop being able to read, and the
            silent version of this is precisely the Motion complaint this
            product exists to answer.
          */}
          {block && !done ? (
            dayKeyOf(block.startsAt, timeZone) === columnKey || columnKey === BACKLOG ? (
              <span className="text-primary/70 tabular-nums" title="When the scheduler placed this">
                {formatTime(block.startsAt, timeZone)}
              </span>
            ) : (
              <span
                className="text-warning font-medium"
                title={`Committed to this day, but the schedule could not fit it here — it is booked for ${shortDay(
                  block.startsAt,
                  timeZone,
                )} at ${formatTime(block.startsAt, timeZone)} instead.`}
              >
                → {shortDay(block.startsAt, timeZone)}
              </span>
            )
          ) : null}

          {task.timerStartedAt ? (
            <span className="text-secondary inline-flex items-center gap-0.5 font-medium">
              <TimerIcon className="size-3" /> running
            </span>
          ) : null}

          {task.subtasks.length > 0 ? (
            <span className="tabular-nums">
              {subtasksDone}/{task.subtasks.length}
            </span>
          ) : null}

          {task.deadline && !done ? (
            <span className={isSoon(task.deadline) ? 'text-error font-medium' : ''}>
              due {relativeDays(task.deadline)}
            </span>
          ) : null}

          {/*
            Stated as a count, never as a reprimand. "Moved 5 times" is a fact
            about the task's size; "you keep failing to do this" is a story the
            user will supply on their own if the app leaves room for it.
          */}
          {task.rolloverCount >= 3 && !done ? (
            <span className="text-warning" title="Carried forward this many times">
              moved {task.rolloverCount}×
            </span>
          ) : null}
        </div>
      </article>
    </>
  );
}

/** Within two days. The threshold at which a deadline changes a decision. */
function isSoon(deadline: Date): boolean {
  return deadline.getTime() - Date.now() < 2 * 86_400_000;
}

/**
 * `YYYY-MM-DD` in the user's zone — the same key the columns are built from.
 *
 * `en-CA` because it is the locale whose short date format *is* ISO order, so
 * this needs no reassembly and cannot disagree with the server's key.
 */
function dayKeyOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(instant);
}

function shortDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(instant);
}

const MoveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
