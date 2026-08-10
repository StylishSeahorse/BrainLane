import { features } from '@fluid/env';
import { prisma } from '@fluid/db';
import { setAutonomy, updateAccessibility } from '@/app/actions';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

const AUTONOMY_OPTIONS = [
  {
    value: 'PROPOSE_THEN_CONFIRM',
    title: 'Ask me first',
    detail: 'The AI drafts changes. Nothing is written until you agree.',
  },
  {
    value: 'AUTO_WITH_UNDO',
    title: 'Act, but keep undo open',
    detail: 'Changes apply immediately and stay one tap from being reversed.',
  },
  {
    value: 'FULL_AUTO',
    title: 'Just do it',
    detail:
      'Changes apply immediately. Deleting, double-booking and scheduling outside your hours still need your say-so.',
  },
] as const;

export default async function SettingsPage() {
  const user = await requireUser();
  const caller = await getCaller();

  const [preferences, aiSetting, connections, autonomy] = await Promise.all([
    prisma.userPreferences.findUnique({ where: { userId: user.id } }),
    prisma.aiSetting.findUnique({ where: { userId: user.id } }),
    prisma.calendarConnection.findMany({ where: { userId: user.id } }),
    caller.agent.autonomy(),
  ]);

  return (
    <>
      <PageHeader title="Settings" subtitle="Reading, motion, and what the AI is allowed to do." />

      <SectionTitle>Accessibility</SectionTitle>
      <form action={updateAccessibility} className="card bg-base-100 border-base-300 border shadow-sm">
        <div className="card-body gap-1">
          {[
            { name: 'highContrast', label: 'High contrast', on: preferences?.highContrast },
            { name: 'reducedMotion', label: 'Reduce motion', on: preferences?.reducedMotion },
            {
              name: 'dyslexiaFont',
              label: 'Dyslexia-friendly text spacing',
              on: preferences?.dyslexiaFont,
            },
            { name: 'largeText', label: 'Larger text', on: preferences?.largeText },
          ].map((option) => (
            <label key={option.name} className="label cursor-pointer justify-between py-2">
              <span className="label-text">{option.label}</span>
              <input
                type="checkbox"
                name={option.name}
                defaultChecked={option.on ?? false}
                className="toggle toggle-primary"
              />
            </label>
          ))}

          <div className="card-actions mt-2">
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
          </div>
        </div>
      </form>

      <SectionTitle>How much the AI may do on its own</SectionTitle>
      <form action={setAutonomy} className="card bg-base-100 border-base-300 border shadow-sm">
        <div className="card-body gap-4">
          <div className="space-y-2">
            {AUTONOMY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="border-base-300 hover:bg-base-200 flex cursor-pointer items-start gap-3 rounded-box border p-3"
              >
                <input
                  type="radio"
                  name="level"
                  value={option.value}
                  defaultChecked={autonomy.level === option.value}
                  className="radio radio-primary mt-0.5"
                />
                <span>
                  <span className="block font-medium">{option.title}</span>
                  <span className="text-base-content/60 block text-sm">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">How much it may rewrite at once</legend>
              <select name="scope" defaultValue={autonomy.scope} className="select w-full">
                <option value="TODAY">Today only</option>
                <option value="THIS_WEEK">This week</option>
              </select>
              <p className="label text-xs">
                A cap so one bad plan cannot quietly restructure a month.
              </p>
            </fieldset>

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Undo window (seconds)</legend>
              <input
                type="number"
                name="undoWindowSeconds"
                min={5}
                max={300}
                step={5}
                defaultValue={autonomy.undoWindowSeconds}
                className="input w-full"
              />
            </fieldset>
          </div>

          {/*
            Stated plainly, because a tiered autonomy control is only meaningful
            if the ceiling is visible from the same screen.
          */}
          <div role="note" className="alert alert-info alert-soft text-sm">
            <span>
              Whatever you choose here, the AI never touches events it did not create, never
              schedules over protected time, and always asks before deleting something.
            </span>
          </div>

          <div className="card-actions">
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
          </div>
        </div>
      </form>

      <SectionTitle>AI and your data</SectionTitle>
      <div className="card bg-base-100 border-base-300 border shadow-sm">
        <div className="card-body gap-3">
          <p className="text-base-content/70 text-sm">
            {features.ai
              ? features.aiDefaultKey
                ? 'AI features are available.'
                : 'AI is enabled but no API key is configured, so the deterministic scheduler is doing all the work.'
              : 'AI is switched off entirely (AI_DISABLED=1). Everything still works — the deterministic scheduler runs on its own.'}
          </p>

          <ul className="divide-base-200 divide-y">
            {[
              {
                label: 'Scheduling',
                on: aiSetting?.allowScheduling ?? true,
                detail: 'Sends durations, deadlines and categories. Never task titles.',
              },
              {
                label: 'Task breakdown',
                on: aiSetting?.allowTaskBreakdown ?? true,
                detail: 'Sends the task you ask it to break down.',
              },
              {
                label: 'Avoidance check-ins',
                on: aiSetting?.allowAvoidanceCheck ?? false,
                detail: 'Off by default. The pattern detection itself is arithmetic and always runs.',
              },
              {
                label: 'Share task titles and notes',
                on: aiSetting?.shareTaskText ?? false,
                detail: 'Off by default. With this off, the model never sees your own words.',
              },
            ].map((row) => (
              <li key={row.label} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium">{row.label}</div>
                  <p className="text-base-content/50 text-xs">{row.detail}</p>
                </div>
                <span className={`badge badge-sm badge-soft shrink-0 ${row.on ? 'badge-success' : ''}`}>
                  {row.on ? 'on' : 'off'}
                </span>
              </li>
            ))}
          </ul>

          <p className="text-base-content/40 text-xs">
            These flags are enforced server-side; editing them from here is not wired up yet.
          </p>
        </div>
      </div>

      <SectionTitle>Calendars</SectionTitle>
      <div className="card bg-base-100 border-base-300 border shadow-sm">
        <div className="card-body">
          {connections.length === 0 ? (
            <p className="text-base-content/70 text-sm">
              No calendars connected. The sync engine, adapter interface and conflict model are
              built; the Google OAuth flow is not wired up yet, so scheduled blocks currently live
              only in Fluid.
            </p>
          ) : (
            <ul className="divide-base-200 divide-y">
              {connections.map((connection) => (
                <li key={connection.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="font-medium">{connection.provider}</div>
                    <p className="text-base-content/50 truncate text-xs">
                      {connection.accountIdentifier}
                    </p>
                  </div>
                  <span
                    className={`badge badge-sm badge-soft shrink-0 ${
                      connection.status === 'ACTIVE' ? 'badge-success' : 'badge-error'
                    }`}
                  >
                    {connection.status.toLowerCase().replace('_', ' ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
