'use client';

import { useActionState, useState } from 'react';
import { formatDateTime } from '@/components/format';
import {
  connectCalendar,
  disconnectCalendar,
  resumeCalendarSync,
  setCalendarSelected,
  setCalendarWriteTarget,
  syncCalendars,
  type ActionState,
} from '@/app/actions';

export interface CalendarSummary {
  id: string;
  name: string;
  timeZone: string;
  canWrite: boolean;
  isSelected: boolean;
  isWriteTarget: boolean;
}

export interface SyncEntry {
  id: string;
  outcome: string;
  message: string | null;
  startedAt: Date;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  account: string;
  status: string;
  statusDetail: string | null;
  lastSyncAt: Date | null;
  calendars: CalendarSummary[];
  history: SyncEntry[];
}

/**
 * Known CalDAV endpoints.
 *
 * Nobody knows their provider's CalDAV URL, and "enter your server address" is
 * where most people give up. These are the addresses that work, with the two
 * services that need an app-specific password saying so before the sign-in
 * fails rather than after.
 */
const PRESETS = [
  {
    label: 'Fastmail',
    url: 'https://caldav.fastmail.com/dav/',
    note: 'Use an app password from Settings → Privacy & Security → App passwords.',
  },
  {
    label: 'iCloud',
    url: 'https://caldav.icloud.com/',
    note: 'Use an app-specific password from appleid.apple.com, not your Apple ID password.',
  },
  {
    label: 'Nextcloud / ownCloud',
    url: 'https://your-server.example/remote.php/dav/',
    note: 'Replace the host with your own. An app password is safer than your login.',
  },
  {
    label: 'Other',
    url: '',
    note: 'Most servers accept the address of your calendar home, or just the site root.',
  },
] as const;

export function CalendarConnections({
  connections,
  undeliveredWrites,
  timeZone,
}: {
  connections: ConnectionSummary[];
  undeliveredWrites: number;
  /** The user's zone. Timestamps are formatted in it, not the runtime's. */
  timeZone: string;
}) {
  return (
    <div className="space-y-4">
      {connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} timeZone={timeZone} />
      ))}

      {undeliveredWrites > 0 ? (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <span>
            {undeliveredWrites} scheduled block{undeliveredWrites === 1 ? '' : 's'} could not be
            written to your calendar. They are still here and still queued — nothing was lost.
          </span>
        </div>
      ) : null}

      <ConnectForm hasAny={connections.length > 0} />
    </div>
  );
}

function ConnectionCard({
  connection,
  timeZone,
}: {
  connection: ConnectionSummary;
  timeZone: string;
}) {
  const halted = connection.status === 'NEEDS_ATTENTION';

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium">{connection.account}</div>
            <p className="text-base-content/50 text-xs">
              {connection.provider} ·{' '}
              {connection.lastSyncAt
                ? `last synced ${formatDateTime(connection.lastSyncAt, timeZone)}`
                : 'not synced yet'}
            </p>
          </div>

          <span
            className={`badge badge-sm badge-soft shrink-0 ${
              connection.status === 'ACTIVE'
                ? 'badge-success'
                : halted
                  ? 'badge-warning'
                  : 'badge-ghost'
            }`}
          >
            {connection.status.toLowerCase().replace(/_/g, ' ')}
          </span>
        </div>

        {/*
          A halted sync is stated in full, with the reason. Silently pausing and
          showing stale data is how someone ends up trusting a calendar that
          stopped updating three days ago.
        */}
        {halted ? (
          <div role="alert" className="alert alert-warning alert-soft text-sm">
            <div>
              <p className="font-medium">Syncing is paused.</p>
              <p>{connection.statusDetail}</p>
              <form action={resumeCalendarSync} className="mt-2">
                <input type="hidden" name="connectionId" value={connection.id} />
                <button type="submit" className="btn btn-xs btn-warning">
                  I have checked — resume
                </button>
              </form>
            </div>
          </div>
        ) : null}

        {connection.calendars.length > 0 ? (
          <ul className="divide-base-200 divide-y">
            {connection.calendars.map((calendar) => (
              <li key={calendar.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{calendar.name}</div>
                  <p className="text-base-content/50 text-xs">
                    {calendar.timeZone}
                    {calendar.canWrite ? '' : ' · read-only'}
                  </p>
                </div>

                <form action={setCalendarSelected}>
                  <input type="hidden" name="calendarId" value={calendar.id} />
                  <label className="label cursor-pointer gap-2 text-xs">
                    <span>Busy time</span>
                    <input
                      type="checkbox"
                      name="isSelected"
                      defaultChecked={calendar.isSelected}
                      className="toggle toggle-sm toggle-primary"
                      // Auto-submitting keeps this a one-tap change. A Save
                      // button per row would be four taps to do one thing.
                      onChange={(event) => event.currentTarget.form?.requestSubmit()}
                    />
                  </label>
                </form>

                {calendar.isWriteTarget ? (
                  <span className="badge badge-sm badge-primary badge-soft">Blocks go here</span>
                ) : calendar.canWrite ? (
                  <form action={setCalendarWriteTarget}>
                    <input type="hidden" name="calendarId" value={calendar.id} />
                    <button type="submit" className="btn btn-ghost btn-xs">
                      Put blocks here
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {connection.history.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-base-content/60">Recent syncs</summary>
            <ul className="mt-2 space-y-1">
              {connection.history.map((entry) => (
                <li key={entry.id} className="text-base-content/60 flex gap-2 text-xs">
                  <span className="font-mono">{formatDateTime(entry.startedAt, timeZone)}</span>
                  <span>{entry.message ?? entry.outcome.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="card-actions">
          <form action={syncCalendars}>
            <button type="submit" className="btn btn-sm btn-outline rounded-xl">
              Sync now
            </button>
          </form>
          <form action={disconnectCalendar}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <button type="submit" className="btn btn-sm btn-ghost rounded-xl">
              Disconnect
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function ConnectForm({ hasAny }: { hasAny: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(connectCalendar, undefined);
  const [preset, setPreset] = useState(0);
  const [serverUrl, setServerUrl] = useState<string>(PRESETS[0]!.url);

  return (
    <form action={action} className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <div>
          <h3 className="font-medium">{hasAny ? 'Connect another calendar' : 'Connect a calendar'}</h3>
          <p className="text-base-content/60 text-sm">
            Any CalDAV server — Fastmail, iCloud, Nextcloud, Radicale, Zimbra. Your events become
            busy time the scheduler works around, and scheduled blocks appear in your real calendar.
          </p>
        </div>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Where is it</legend>
          <select
            className="select w-full"
            value={preset}
            onChange={(event) => {
              const index = Number(event.target.value);
              setPreset(index);
              setServerUrl(PRESETS[index]!.url);
            }}
          >
            {PRESETS.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="label text-xs">{PRESETS[preset]!.note}</p>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Server address</legend>
          <input
            name="serverUrl"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://caldav.example.com/dav/"
            className="input w-full"
            required
          />
          <p className="label text-xs">
            Must be https. The password is sent on every request, so an unencrypted address is
            refused.
          </p>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Username</legend>
            <input name="username" autoComplete="username" className="input w-full" required />
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Password</legend>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className="input w-full"
              required
            />
          </fieldset>
        </div>

        <p className="text-base-content/50 text-xs">
          Stored encrypted, tied to your account, and only ever decrypted to talk to your server.
          Where your provider offers an app-specific password, use one — it can be revoked on its
          own.
        </p>

        {state?.error ? (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="card-actions">
          <button type="submit" className="btn btn-primary btn-sm rounded-xl" disabled={pending}>
            {pending ? 'Checking…' : 'Connect'}
          </button>
        </div>
      </div>
    </form>
  );
}
