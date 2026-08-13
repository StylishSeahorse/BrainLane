'use client';

/**
 * A visible record of what just happened.
 *
 * Most actions in this app are a server action behind a plain `<form>` — the
 * page revalidates, but if nothing on screen happens to change (logging five
 * minutes against a task changes no visible field), the click looks like it
 * did nothing at all. For someone who already doubts whether they did the
 * thing right, that silence reads as "it's broken", not "it worked quietly".
 *
 * This is two pieces working together: a tiny module-level store any client
 * component can push a line into via `logAction()`, and a floating panel that
 * shows the last few. The panel starts collapsed to a small badge — a log
 * that is always open competes with the page for attention, which is the
 * opposite of what a low-cognitive-load surface needs.
 */
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { ActivityIcon, CheckIcon, XIcon } from '@/components/icons';

export type LogTone = 'success' | 'error' | 'info';

/**
 * How to reverse an entry.
 *
 * A server-action reference plus a plain string argument, rather than a
 * closure: a closure cannot cross the server-to-client boundary, but a server
 * action is passed by reference and a string is just data, so a server
 * component can hand this to a client one.
 */
export interface LogUndo {
  action: (arg: string) => Promise<{ error?: string } | void>;
  arg: string;
  label?: string;
}

export interface LogEntry {
  id: string;
  message: string;
  tone: LogTone;
  at: number;
  undo?: LogUndo;
  undone?: boolean;
}

const MAX_ENTRIES = 30;

let entries: LogEntry[] = [];
let unread = 0;
const listeners = new Set<() => void>();

/**
 * `useSyncExternalStore`'s server snapshot must return a referentially stable
 * value when nothing has changed — a fresh `[]` literal on every call looks
 * to React like the store changing on every render, which it reports as a
 * potential infinite loop. There is never server-rendered log content (the
 * log is entirely a client-side, in-memory thing), so one empty constant
 * covers every server render.
 */
const EMPTY_ENTRIES: LogEntry[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record that something happened. Safe to call from anywhere on the client. */
export function logAction(message: string, tone: LogTone = 'success', undo?: LogUndo): void {
  entries = [
    { id: crypto.randomUUID(), message, tone, at: Date.now(), ...(undo ? { undo } : {}) },
    ...entries,
  ].slice(0, MAX_ENTRIES);
  unread += 1;
  emit();
}

function clearLog(): void {
  entries = [];
  unread = 0;
  emit();
}

function markRead(): void {
  if (unread === 0) return;
  unread = 0;
  emit();
}

/** Mark an entry as reversed, so its Undo button does not linger and re-fire. */
function markUndone(id: string): void {
  entries = entries.map((entry) => (entry.id === id ? { ...entry, undone: true } : entry));
  emit();
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

const TONE_DOT: Record<LogTone, string> = {
  success: 'bg-success',
  error: 'bg-error',
  info: 'bg-base-content/40',
};

/**
 * The floating log itself.
 *
 * Mounted once, in the authenticated layout. Draggable by its header — the
 * default corner is a reasonable guess, not everyone's preference, and a
 * panel that cannot be moved out of the way of whatever it happens to cover
 * is a panel people learn to ignore.
 */
export function ActionLogPanel() {
  const log = useSyncExternalStore(subscribe, () => entries, () => EMPTY_ENTRIES);
  const unreadCount = useSyncExternalStore(
    subscribe,
    () => unread,
    () => 0,
  );

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragOrigin = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(
    null,
  );

  // Re-render on a timer while open, so "just now" ages into "2m ago" without
  // needing a fresh action to force it.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((value) => value + 1), 15_000);
    return () => clearInterval(id);
  }, [open]);

  const toggle = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) markRead();
      return !wasOpen;
    });
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.closest('[data-log-panel]')?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = { pointerX: event.clientX, pointerY: event.clientY, x: rect.left, y: rect.top };
  };

  const duringDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    if (!origin) return;
    const nextX = origin.x + (event.clientX - origin.pointerX);
    const nextY = origin.y + (event.clientY - origin.pointerY);
    // Kept fully on screen — a panel dragged past the edge and out of reach
    // would be a worse outcome than one that cannot be moved at all.
    const clampedX = Math.max(8, Math.min(window.innerWidth - 60, nextX));
    const clampedY = Math.max(8, Math.min(window.innerHeight - 60, nextY));
    setPosition({ x: clampedX, y: clampedY });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragOrigin.current = null;
  };

  const style: React.CSSProperties = position
    ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
    : { right: '1.25rem', bottom: '1.25rem' };

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        data-log-panel
        style={style}
        className="btn btn-circle btn-primary fixed z-40 shadow-lg"
        aria-label={`Activity log${unreadCount > 0 ? ` — ${unreadCount} new` : ''}`}
        title="Activity log"
      >
        <ActivityIcon className="size-5" />
        {unreadCount > 0 ? (
          <span className="badge badge-secondary badge-sm absolute -right-1 -top-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      data-log-panel
      style={style}
      className="card bg-base-100 border-base-300 fixed z-40 w-80 max-w-[calc(100vw-2rem)] border shadow-xl"
    >
      <div
        className="border-base-200 flex cursor-grab items-center justify-between border-b px-3 py-2 active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={duringDrag}
        onPointerUp={endDrag}
      >
        <span className="text-sm font-semibold">Activity log</span>
        <div className="flex items-center gap-1">
          {log.length > 0 ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={clearLog}
              // Dragging starts on pointerdown at the header; stop this
              // button's own click from also being read as a drag handle.
              onPointerDown={(event) => event.stopPropagation()}
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square"
            onClick={toggle}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Close activity log"
          >
            <XIcon />
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto p-2">
        {log.length === 0 ? (
          <p className="text-base-content/50 px-2 py-4 text-center text-xs">
            Nothing yet. Actions you take will show up here.
          </p>
        ) : (
          <ul className="space-y-1">
            {log.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs">
                <span className={`mt-1 size-1.5 shrink-0 rounded-full ${TONE_DOT[entry.tone]}`} />
                <span className="grow">
                  {entry.message}
                  {entry.undone ? <span className="text-base-content/40"> · undone</span> : null}
                </span>
                {entry.undo && !entry.undone ? (
                  <UndoButton entry={entry} undo={entry.undo} />
                ) : null}
                <span className="text-base-content/40 shrink-0">{relativeTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The per-entry Undo control. Split out so it can own its own pending state. */
function UndoButton({ entry, undo }: { entry: LogEntry; undo: LogUndo }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs shrink-0"
      disabled={pending}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        startTransition(async () => {
          const result = await undo.action(undo.arg);
          if (result && 'error' in result && result.error) {
            logAction(result.error, 'error');
            return;
          }
          markUndone(entry.id);
        });
      }}
    >
      {pending ? <span className="loading loading-dots loading-xs" /> : (undo.label ?? 'Undo')}
    </button>
  );
}

/**
 * A button that calls a server action directly (not through `<form action>`),
 * so it can react to the result: a same-instant "Done" flash on the button
 * itself, plus a line in the floating log for anyone who looks away and back.
 *
 * `fields` are packed into a `FormData`, matching what the existing actions
 * already expect — this is a thin wrapper, not a new action-calling
 * convention.
 */
export function LoggedActionButton({
  action,
  fields,
  successMessage,
  pendingLabel,
  className,
  undo,
  children,
}: {
  action: (formData: FormData) => Promise<void | { error?: string } | undefined>;
  fields: Record<string, string>;
  successMessage: string;
  pendingLabel?: string;
  className?: string;
  /** Attaches an Undo control to the log line this button writes. */
  undo?: LogUndo;
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [justDone, setJustDone] = useState(false);

  const handleClick = () => {
    setPending(true);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);

    void (async () => {
      try {
        const result = await action(formData);
        if (result && 'error' in result && result.error) {
          logAction(result.error, 'error');
          return;
        }
        logAction(successMessage, 'success', undo);
        setJustDone(true);
        setTimeout(() => setJustDone(false), 1600);
      } catch (error) {
        logAction(error instanceof Error ? error.message : 'Something went wrong.', 'error');
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <button type="button" className={className} onClick={handleClick} disabled={pending}>
      {pending ? (
        // Animated dots rather than only swapping the label: several of these
        // sit on AI-backed actions that can take tens of seconds, and a
        // static "Working…" is indistinguishable from a button that hung.
        <span className="inline-flex items-center gap-1.5">
          <span className="loading loading-dots loading-xs" />
          {pendingLabel ?? 'Working…'}
        </span>
      ) : justDone ? (
        <span className="inline-flex items-center gap-1.5">
          <CheckIcon />
          Done
        </span>
      ) : (
        children
      )}
    </button>
  );
}
