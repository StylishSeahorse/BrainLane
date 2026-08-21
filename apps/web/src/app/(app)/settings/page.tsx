import { features } from '@fluid/env';
import { prisma } from '@fluid/db';
import { setAutonomy, updateAccessibility, updateFocusRhythm } from '@/app/actions';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { AiProviderForm } from '@/components/ai-provider-form';
import { Areas } from '@/components/areas';
import { RoutinesSection } from '@/components/routines-section';
import { CalendarConnections } from '@/components/calendar-connections';
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

  const [preferences, calendars, autonomy, aiSettings, areas, routines] = await Promise.all([
    prisma.userPreferences.findUnique({ where: { userId: user.id } }),
    caller.calendar.connections(),
    caller.agent.autonomy(),
    caller.ai.settings(),
    caller.area.list(),
    caller.routine.list(),
  ]);

  return (
    <>
      <PageHeader eyebrow="Your workspace"
        title="Settings" subtitle="Reading, motion, and what the AI is allowed to do." />

      <SectionTitle>Accessibility</SectionTitle>
      <form action={updateAccessibility} className="card bg-base-100 border-base-200 border shadow-sm">
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
            <button type="submit" className="btn btn-primary btn-sm rounded-xl">
              Save
            </button>
          </div>
        </div>
      </form>

      <SectionTitle>Areas</SectionTitle>
      <Areas areas={areas} />

      <SectionTitle>
        <span id="routines">Routines</span>
      </SectionTitle>
      <RoutinesSection routines={routines} />

      <SectionTitle>Focus rhythm</SectionTitle>
      <form action={updateFocusRhythm} className="card bg-base-100 border-base-200 border shadow-sm">
        <div className="card-body gap-4">
          <label className="label cursor-pointer justify-between py-0">
            <span>
              <span className="label-text block font-medium">Offer breaks while I work</span>
              <span className="text-base-content/60 block text-sm">
                A prompt in focus mode, never an interruption — push it back or ignore it.
                Taking the break stops the timer so the time away is not logged as work, and
                offers you the restart in the same place.
              </span>
            </span>
            <input
              type="checkbox"
              name="pomodoroEnabled"
              defaultChecked={preferences?.pomodoroEnabled ?? true}
              className="toggle toggle-primary shrink-0"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Work for (minutes)</legend>
              <input
                type="number"
                name="pomodoroWorkMinutes"
                min={10}
                max={180}
                step={5}
                defaultValue={preferences?.pomodoroWorkMinutes ?? 50}
                className="input w-full"
              />
            </fieldset>

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Then break for (minutes)</legend>
              <input
                type="number"
                name="pomodoroBreakMinutes"
                min={1}
                max={60}
                step={1}
                defaultValue={preferences?.pomodoroBreakMinutes ?? 10}
                className="input w-full"
              />
            </fieldset>
          </div>

          <div className="card-actions">
            <button type="submit" className="btn btn-primary btn-sm rounded-xl">
              Save
            </button>
          </div>
        </div>
      </form>

      <SectionTitle>How much the AI may do on its own</SectionTitle>
      <form action={setAutonomy} className="card bg-base-100 border-base-200 border shadow-sm">
        <div className="card-body gap-4">
          <div className="space-y-2">
            {AUTONOMY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="border-base-200 hover:bg-base-200 flex cursor-pointer items-start gap-3 rounded-box border p-3"
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
            <button type="submit" className="btn btn-primary btn-sm rounded-xl">
              Save
            </button>
          </div>
        </div>
      </form>

      <SectionTitle>AI provider</SectionTitle>
      {features.ai ? (
        <AiProviderForm providers={aiSettings.providers} current={aiSettings.current} />
      ) : (
        <div className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body">
            <p className="text-base-content/70 text-sm">
              AI is switched off entirely (AI_DISABLED=1). Everything still works — the
              deterministic scheduler runs on its own.
            </p>
          </div>
        </div>
      )}

      <SectionTitle>Calendars</SectionTitle>
      <CalendarConnections
        connections={calendars.connections}
        undeliveredWrites={calendars.undeliveredWrites}
        timeZone={user.timeZone}
      />
    </>
  );
}
