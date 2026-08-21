# Fluid

An ADHD-focused AI calendar and project planner. It doesn't store tasks so much as
negotiate a realistic schedule: it breaks work into re-entry points, shows every
change as a plain-language diff before applying it, and notices when a task keeps
moving.

The shape is Sunsama's, the engine is Motion's. You choose which **day** work
belongs to — on the Week board or in the morning ritual — and the scheduler works
out **when** inside it, around your meetings. Neither half is allowed to overrule
the other: the AI never picks your day, and you never have to hand-place a block.

**Status: running.** Auth, task/project CRUD, the scheduler, the Week board, the
morning ritual, focus mode, the calendar UI, the ADHD surfaces and the AI calendar
agent all work end to end. Two-way calendar sync is interface-complete but not
wired to a live provider. See
[What exists / what doesn't](#what-exists--what-doesnt).

---

## Getting started

```bash
npm install
```

```bash
docker compose up -d
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy `.env.example` to `.env` and paste that value as `ENCRYPTION_KEK`. Then:

```bash
npm run db:migrate -w @fluid/db
```

```bash
npm run verify
```

Then `npm run db:seed` and `npm run dev` — the app is on **http://localhost:3030**,
and the seeded account is `demo@fluid.local` / `demo-password-1234`.

`verify` runs lint, typecheck, and the test suite — currently 324 tests, all passing.
Postgres listens on **5433** and Redis on **6380** (non-default, so they don't collide
with anything already running locally).

---

## Layout

```
packages/env       Validated config — the ONLY module that reads process.env
packages/crypto    Envelope encryption, Argon2id passwords, opaque tokens
packages/db        Prisma schema, migrations, repositories
packages/core      Scheduler, interval algebra, zoned time — pure, no I/O
packages/calendar  CalendarAdapter interface + fake + shared contract suite
packages/ai        AIProvider interface, provider registry, adapters, redaction,
                   validation, SSRF guard
```

`@fluid/core` has no dependencies at all. That is deliberate: the scheduler is the
part that must be right, and a pure function over plain data can be tested
exhaustively in milliseconds.

---

## Where things live

Five destinations, one per question someone actually arrives with:

| | |
|---|---|
| **Today** | What am I doing now? The day as a list beside the day as a timeline, plus the rituals that bracket it. |
| **Week** | Which day does this belong to? Board, Calendar and Agenda are *lenses* on one page — same seven days, three readings. |
| **Tasks** | What exists at all? Backlog by horizon, projects, braindump capture. |
| **Review** | How did that go? Objectives, estimate calibration, where the time went, and what the AI did. |
| **Settings** | How should this behave? Accessibility, areas, routines, focus rhythm, AI autonomy and provider, calendars. |

Two full-screen flows sit outside the sidebar because they are things you *enter*
rather than places you browse: the morning ritual (`/plan-day`) and focus mode
(`/focus`), both reached from Today.

Board, Calendar, Routines and Activity used to be top-level entries. The first two
were one week of data wearing three hats; the second two were misfiled —
routines are configuration you set once, and the AI log is evidence you read
during a review. Old URLs redirect, carrying the week or view they were pointing
at, so nothing bookmarked dead-ends.

---

## The nine decisions worth knowing

### 1. Ownership decides who may write an event — not timestamps

Two-way calendar sync usually resolves conflicts with last-write-wins. That is unsafe:
clocks skew across providers, and the loser is destroyed silently. Instead every event
carries an immutable `origin`:

- **`EXTERNAL`** — the provider is authority. We write only on a deliberate user edit,
  with an ETag precondition; a 412 surfaces a merge prompt instead of overwriting.
- **`APP_BLOCK`** — we are authority. If the user drags one of our blocks in Google
  Calendar, that is read as *intent*: we accept the new time and pin the block so the
  scheduler won't move it again.

Every conflict stores **both** versions, so whatever wins, the other is recoverable.

### 2. The scheduler physically cannot touch a real meeting

Three layers enforce one rule, because a bug that deletes someone's meetings ends the
product's usefulness permanently — even after the bug is fixed:

1. `packages/db/src/repositories/events.ts` gives the scheduler no vocabulary for it —
   its only write functions are `*AppBlock`.
2. A runtime origin check, for callers reached through a queue payload the types
   didn't cover.
3. Database triggers (`packages/db/prisma/migrations/*/migration.sql`) that hold even
   if someone bypasses the repository entirely.

Verified, not assumed — see [Verifying the guarantees](#verifying-the-guarantees).

### 3. The deterministic scheduler is primary; the AI advises

`plan()` in `packages/core/src/scheduler/plan.ts` is the engine. The AI proposes an
*ordering*; `validateScheduleSuggestion` extracts only that, and the scheduler applies
every hard constraint. Deliberately discarded: the model's suggested times.

This single design does three jobs. The app works with AI disabled, unreachable, or
declined by the user. And it contains prompt injection — **anyone who can send you a
meeting invite can put text into the model's input**, so the worst a successful
injection achieves is a bad suggestion the user sees in the diff and rejects.

Constraint priority: protected/hyperfocus time (inviolable) → no overlap with busy →
working hours → dependencies and earliest-start → deadlines (earliest-deadline-first)
→ energy match → chunk sizes and buffers → **minimize churn**.

That last one is last in precedence and does the most for the user. A schedule that
reshuffles wholesale stops working as the external structure someone is relying on to
counter time blindness. The stability pass keeps every block that is still legal and
moves only what genuinely has to.

### 4. The AI sees durations, not diaries

`redactTask` sends opaque refs, durations, relative deadlines, and a locally-derived
category. Titles and notes go only where the user has opted in, per feature. So
"Write the resignation letter" is categorized as `writing` **without the words leaving
the machine**.

Opaque refs also make the system fail closed: a hallucinated or injected `task_999`
resolves to nothing rather than addressing some arbitrary row.

### 5. Auth deviates from the plan — deliberately

The plan specified Auth.js v5. It is still beta, and for credentials-only login its
JWT-session defaults are weaker than DB-backed sessions. `packages/crypto` therefore
provides the primitives for a small, auditable session system: 256-bit opaque tokens,
SHA-256 digests at rest (a database dump can't be replayed as live logins), Argon2id
via `@node-rs/argon2` (prebuilt binaries — no node-gyp on Windows), and `fakeVerify()`
to keep login timing uniform for non-existent accounts.

The login flow, session table and per-page `requireUser()` guard are built on top of
those primitives.


### 6. The AI acts on the calendar, but only through a gate

The AI can create, move, resize and remove work blocks directly — but it never
writes. It proposes `CalendarAction`s, `packages/core/src/actions` rules on each
one, and only `apps/web/src/server/services/calendar-agent.ts` applies the
survivors. There is no path from a model response to a provider adapter that
skips the validator.

Three verdicts, and the distinction between the first two matters:

- **REFUSE** — outside the AI's authority at *any* autonomy level: protected and
  hyperfocus time, events it did not create, blocks the user pinned by hand, and
  anything outside the pass's scope.
- **NEEDS_CONFIRMATION** — a hard boundary: deleting outright, scheduling outside
  working hours, double-booking. **`FULL_AUTO` does not override these.** That is
  the line the setting must not cross, and a test asserts it.
- **ALLOW** — applied according to the user's autonomy level.

Refusal is not a stricter confirmation. Confirmation means "ask the user";
refusal means the action is outside the AI's authority entirely, and offering it
as a prompt would train people to click through the one dialog that should never
appear.

Autonomy is the user's choice — `FULL_AUTO`, `AUTO_WITH_UNDO` (the default), or
`PROPOSE_THEN_CONFIRM` — and a per-pass cap bounds the blast radius so a bad plan
cannot quietly rewrite a month.

Every action, applied or proposed or refused, lands in the `AiAction` log with a
plain-language reason and its own revert. Per-entry, not a stack: undoing one
change from an hour ago must not unwind the four good ones after it. Refusals are
shown too — a guardrail that works silently is indistinguishable from one that
isn't there.


### 7. Any model provider, one adapter

OpenAI, OpenRouter, CometAPI, Gemini, Groq, DeepSeek, Together, Mistral, Ollama and any
self-hosted server all speak the same OpenAI chat-completions format. So this is not nine
adapters — it is one adapter plus a catalog in `packages/ai/src/registry.ts`. Adding a
provider is a registry entry: no migration, no new adapter, no branch in calling code.
Anthropic keeps its own adapter because its wire format genuinely differs.

`AiSetting.providerId` is a string keyed to that catalog rather than an enum, precisely so
a new provider never needs a schema change.

**No model IDs are hardcoded anywhere.** Vendors add and retire models weekly, and a stale
baked-in list is worse than none — it sends people to a model that 404s. Providers exposing
`GET /models` are queried live, and the field stays free text so a model works the day it
ships.

Letting someone type an endpoint URL is also the most dangerous input in the product: on a
cloud host it is a direct line to the instance metadata service.
`packages/ai/src/net/safe-url.ts` is the guard — https-only outside localhost,
private/link-local/metadata ranges refused, DNS resolved and pinned to defeat rebinding,
redirects never followed. 17 tests, including the IPv4-mapped-IPv6 bypass
(`::ffff:169.254.169.254`).

Keys are envelope-encrypted per user and **write-only**: there is no read path back to the
browser, and the settings screen only ever reports whether a key is stored.

### 8. A day is a commitment, and the user makes it — the AI only says when

Motion auto-schedules everything and decides for you. Sunsama makes you choose a
day for each task and leaves the timing to you. Both halves are load-bearing, and
this app runs them together rather than picking one.

`Task.plannedFor` is the seam. It is the line between *this exists* and *I am doing
this*, and it is set by exactly one kind of gesture: a person putting a card on a
day, on the board or in the morning ritual. Nothing infers it, and committing to a
day never edits the estimate, deadline or priority of the thing being committed —
a planning gesture that quietly rewrites its subject is how a board loses trust.

The scheduler then treats that day as a window (`SchedulableTask.committedTo`) and
orders committed work ahead of everything else. It is deliberately a **soft**
constraint, relaxed in a fixed order: the chosen day first, then the deadline.
Energy is relaxed before either, inside `findSlot`.

Refusing to schedule work that overflows its day would be the easy call and the
wrong one — it punishes someone for a plan that was slightly optimistic, which is
the guilt loop the product exists to interrupt. So the work is placed anyway and
the spill is *reported*: `Plan.spilled`, and on the board a card that could not be
honoured shows `→ Mon` instead of a time. Silently relocating it — Motion's
behaviour and its most-cited ADHD complaint — is the one option not on the table.

Three consequences fall out, and each has a test:

- **Day commitment outranks priority.** Priority is the scheduler's opinion; a day
  is the user's decision, and the second wins. It costs little in practice, because
  work committed to Friday can only be placed on Friday anyway.
- **Stability yields to a new commitment.** The churn-minimizing pass normally keeps
  any block that is still legal — which would silently undo every drag, since the
  old block is still perfectly legal. A retained block outside `committedTo` is
  released.
- **Protected time still wins.** A commitment is a preference. Protected and
  hyperfocus time are not, and the ordering in decision 3 is unchanged.

The day columns report load as *blocks actually booked on that day* plus *committed
work with no time yet*. Summing card estimates alone would show a comfortable Friday
with three hours of overflow sitting on it; using only booked minutes would leave the
bar motionless at the exact moment a card is dropped on it and the number is being
consulted.

### 9. Not all time belongs to the same ledger

An `Area` is a context one level above a project — Work, Personal, the band —
and it carries exactly one behavioural flag: `countsTowardCapacity`.

The obvious implementation of "exclude personal work from my work capacity" is
to drop it from the arithmetic. That is wrong, and wrong in the direction that
matters: a dentist appointment at 11am genuinely removes eleven o'clock from the
working day, so excluding it reports free time that does not exist — the exact
failure the capacity meter is built to prevent.

So personal time is treated the way meetings already are. It reduces
`capacityMinutes`; it is *not* counted in `committedMinutes`. The day gets
smaller, and what the day owes stays honest. `computeCapacity` charges each
minute once: personal time already covered by a meeting or a routine is not a
third deduction.

The same split has to hold everywhere the ledger is visible, or the screens
start contradicting each other. Three places had to be brought into line:

- The board's day columns count *booked* minutes plus *committed-but-unplaced*
  estimates — and the unplaced half filters by the same flag, or the bar would
  jump the moment the scheduler ran.
- Daily highlights key their groups on `(project, countsTowardCapacity)` rather
  than project alone. An "Admin" project holding a client invoice *and* a
  dentist appointment must not report the appointment as work delivered.
- The area lives on the **task**, seeded from its project at creation and owned
  by the task thereafter — so re-filing a project later never silently
  reclassifies work that has already been scheduled and counted.

Deleting an area is `SetNull` on both foreign keys. Losing a label must never be
a way to lose the thing it was labelling.

---

## Security controls in place

| Control | Where |
|---|---|
| Envelope encryption, AAD-bound to user + purpose | `packages/crypto/src/envelope.ts` |
| Secrets can't reach the client bundle | ESLint `no-restricted-syntax` + `import 'server-only'` + `scripts/check-bundle-secrets.mjs` |
| Prompt-injection containment | `packages/ai/src/validate.ts` (structural) + `redaction.ts` (defence in depth) |
| Scheduler can't touch external events | Repository + DB triggers |
| Immutable event origin | DB trigger — closes the relabel-then-grab loophole |

The AAD binding is what makes the crypto worth more than plain column encryption: an
attacker with **database write access** cannot transplant one user's Google refresh
token onto another user's row, because the GCM tag check fails.

---

## Verifying the guarantees

The database guards are verifiable directly, against a fixture the script creates and
cleans up:

```bash
docker exec -i fluid-postgres psql -U fluid -d fluid -q < scripts/verify-db-guards.sql
```

Six checks. Five must print an `ERROR` — including *"the scheduler may only own
APP_BLOCK events"* and *"events.origin is immutable"* — and the sixth, binding a block
to an event we created, must succeed. Anything else means a guard has regressed.

The suites that matter most:

```bash
npx vitest run packages/core/src/scheduler/plan.test.ts
```

Protected-time inviolability (including against an urgent deadline), replan stability
(only the displaced block moves), determinism, and DST correctness across a real
Europe/London transition.

```bash
npx vitest run packages/calendar
```

The adapter contract suite, run twice: once as a full-capability provider and once
shaped like CalDAV (no push, no ETags, no delta sync). Google, Microsoft, and CalDAV
adapters inherit it — including *"never marks an event deleted without an explicit
provider signal"*, the property that stops a full resync becoming mass data loss.

---

## What exists / what doesn't

**Working end to end** (324 tests):

- Signup / login / logout, DB-backed sessions, per-page auth guard
- Task and project CRUD; progressive-disclosure capture form
- Deterministic scheduler with the full constraint set + plan diff
- **Week** (`/week`) — one destination, three lenses on the same seven days:
  **Board** (days as columns, drag work onto the day you mean to do it, with
  per-column capacity), **Calendar** (the time grid), and **Agenda** (the list).
  On the board, drag is the fast path; every card also carries a "move to" menu,
  because native HTML5 dragging is invisible to keyboards and awkward on touch
- **Day commitments** — `plannedFor` as a soft scheduling window, with spill
  reported rather than hidden (decision 8)
- **Morning ritual** (`/plan-day`) — close off yesterday, choose today against a
  live capacity meter, confirm, then hand it to the scheduler
- **Focus mode** (`/focus`) — the day as a sequence rather than a grid, with times
  projected from the clock so an overrun moves everything after it
- **Areas** — contexts above projects, with the capacity ledger split (decision 9),
  colour on the board, and a where-the-time-went breakdown on Review
- **Daily highlights** — what the day added up to, grouped and copyable, built from
  logged minutes rather than estimates
- **Break prompts** — offered after a configurable stretch, never imposed. Taking one
  stops the timer, so time away is never logged as work
- AI calendar agent: autonomy tiers, validator, audit log, per-entry undo
- ADHD surfaces: runway, "Just start", breakdown, avoidance check-ins, estimation coach
- Accessibility modes applied server-side before first paint
- CalendarAdapter + AIProvider interfaces, fakes, shared contract suite
- Provider-neutral prompt templates, plus adapters for Anthropic and every
  OpenAI-compatible provider (OpenAI, OpenRouter, CometAPI, Gemini, Groq, DeepSeek,
  Together, Mistral, Ollama, custom), configurable per user with their own key

**Not built**

- **Google Calendar HTTP calls.** The interface, contract suite, outbox table,
  circuit-breaker fields and conflict model are all in place; the OAuth flow and
  the actual API requests are not. Blocks stay inside Fluid for now.
- CalDAV and Microsoft Graph adapters (step 4 of the build order)
- BullMQ worker — no background sync or nudge delivery yet
- Nudges/notifications, body doubling, Gantt view, task import
- Booking links, an AI notetaker, and Slack/Teams delivery of the daily summary
  (it copies to the clipboard instead)
- AI settings toggles are enforced server-side but not yet editable in the UI

The Anthropic adapter typechecks against the current API but **has not been run
against the live API** — no key was configured, so the app has only exercised the
deterministic path. Expect to shake out real request/response details on first
contact.

## Notes for whoever continues this

- **npm workspaces, not pnpm.** `corepack enable` needs admin rights on this machine.
- **No project references.** Packages export raw TypeScript and are consumed directly
  by Next's `transpilePackages` and Vitest; composite builds would demand `.d.ts`
  outputs nothing produces.
- **Sampling parameters are gone.** Current Anthropic models reject `temperature`,
  `top_p`, and `top_k` with a 400. `PromptSpec.reasoning` maps to `output_config.effort`
  instead — do not reintroduce a `temperature` field to the neutral interface.
- **Don't disable thinking on Opus 5.** It can emit a tool call as plain text (the call
  silently never runs) and leak internal tags into output. Lower `effort` instead.
- When adding a calendar provider, run `runAdapterContract` against it **first**. It
  encodes the data-loss safeguards, and a provider that passes has inherited them.
