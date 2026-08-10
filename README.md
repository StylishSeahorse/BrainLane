# Fluid

An ADHD-focused AI calendar and project planner. It doesn't store tasks so much as
negotiate a realistic schedule: it breaks work into re-entry points, shows every
change as a plain-language diff before applying it, and notices when a task keeps
moving.

**Status: running.** Auth, task/project CRUD, the scheduler, the calendar UI, the
ADHD surfaces and the AI calendar agent all work end to end. Two-way calendar sync
is interface-complete but not wired to a live provider. See
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

`verify` runs lint, typecheck, and the test suite — currently 157 tests, all passing.
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
packages/ai        AIProvider interface, redaction, validation, Anthropic adapter
```

`@fluid/core` has no dependencies at all. That is deliberate: the scheduler is the
part that must be right, and a pure function over plain data can be tested
exhaustively in milliseconds.

---

## The six decisions worth knowing

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

**Working end to end** (157 tests):

- Signup / login / logout, DB-backed sessions, per-page auth guard
- Task and project CRUD; progressive-disclosure capture form
- Deterministic scheduler with the full constraint set + plan diff
- Week grid and list calendar views, timezone-correct
- AI calendar agent: autonomy tiers, validator, audit log, per-entry undo
- ADHD surfaces: runway, "Just start", breakdown, avoidance check-ins, estimation coach
- Accessibility modes applied server-side before first paint
- CalendarAdapter + AIProvider interfaces, fakes, shared contract suite
- Anthropic adapter and provider-neutral prompt templates

**Not built**

- **Google Calendar HTTP calls.** The interface, contract suite, outbox table,
  circuit-breaker fields and conflict model are all in place; the OAuth flow and
  the actual API requests are not. Blocks stay inside Fluid for now.
- CalDAV and Microsoft Graph adapters (step 4 of the build order)
- BullMQ worker — no background sync or nudge delivery yet
- Nudges/notifications, focus timer and body doubling, Kanban and Gantt views,
  recurring tasks, task import
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
