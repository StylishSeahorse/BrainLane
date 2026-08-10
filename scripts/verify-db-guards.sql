-- Repeatable proof that the database-level integrity guards actually fire.
--
-- Every test below MUST print an ERROR except test 6, which must succeed.
-- Run with:
--   docker exec -i fluid-postgres psql -U fluid -d fluid -q < scripts/verify-db-guards.sql
--
-- Creates a fixture, exercises each guard in its own transaction so one
-- failure does not abort the rest, then deletes the fixture.

INSERT INTO users (id, email, "timeZone", "createdAt", "updatedAt")
  VALUES ('guard-check-user', 'guard-check@fluid.local', 'UTC', now(), now());
INSERT INTO calendar_connections (id, "userId", provider, "accountIdentifier", "encryptedCredentials", status, "createdAt", "updatedAt")
  VALUES ('guard-check-conn', 'guard-check-user', 'GOOGLE', 'guard-check@fluid.local', 'sealed', 'ACTIVE', now(), now());
INSERT INTO calendars (id, "connectionId", "userId", "externalId", name, "timeZone", "canWrite", "isSelected", "isWriteTarget", "needsFullResync", "createdAt", "updatedAt")
  VALUES ('guard-check-cal', 'guard-check-conn', 'guard-check-user', 'ext-guard', 'Work', 'UTC', true, true, true, false, now(), now());
INSERT INTO events (id, "calendarId", title, "startsAt", "endsAt", "isAllDay", "timeZone", status, transparency, origin, "localUpdatedAt", "createdAt")
  VALUES ('guard-check-real', 'guard-check-cal', 'A real meeting', now(), now() + interval '1 hour', false, 'UTC', 'CONFIRMED', 'BUSY', 'EXTERNAL', now(), now());
INSERT INTO events (id, "calendarId", title, "startsAt", "endsAt", "isAllDay", "timeZone", status, transparency, origin, "localUpdatedAt", "createdAt")
  VALUES ('guard-check-ours', 'guard-check-cal', 'A block we created', now(), now() + interval '1 hour', false, 'UTC', 'CONFIRMED', 'BUSY', 'APP_BLOCK', now(), now());
INSERT INTO tasks (id, "userId", title, status, priority, energy, "estimateMinutes", "actualMinutes", "isSplittable", "minChunkMinutes", "maxChunkMinutes", "rescheduleCount", "lastTouchedAt", "createdAt", "updatedAt")
  VALUES ('guard-check-task', 'guard-check-user', 'Write report', 'READY', 'HIGH', 'HIGH', 60, 0, true, 25, 90, 0, now(), now(), now());

\echo ''
\echo '== 1. Scheduler tries to take ownership of a real meeting  -> must FAIL'
BEGIN;
INSERT INTO scheduled_blocks (id, "taskId", "eventId", "startsAt", "endsAt", state, "isPinned", "createdAt", "updatedAt")
  VALUES ('guard-check-b1', 'guard-check-task', 'guard-check-real', now(), now() + interval '1 hour', 'ACCEPTED', false, now(), now());
ROLLBACK;

\echo ''
\echo '== 2. Relabel a real meeting as ours, then grab it         -> must FAIL'
BEGIN;
UPDATE events SET origin = 'APP_BLOCK' WHERE id = 'guard-check-real';
ROLLBACK;

\echo ''
\echo '== 3. A second write-target calendar for one user          -> must FAIL'
BEGIN;
INSERT INTO calendars (id, "connectionId", "userId", "externalId", name, "timeZone", "canWrite", "isSelected", "isWriteTarget", "needsFullResync", "createdAt", "updatedAt")
  VALUES ('guard-check-cal2', 'guard-check-conn', 'guard-check-user', 'ext-guard-2', 'Personal', 'UTC', true, true, true, false, now(), now());
ROLLBACK;

\echo ''
\echo '== 4. Calendar whose userId disagrees with its connection   -> must FAIL'
BEGIN;
INSERT INTO calendars (id, "connectionId", "userId", "externalId", name, "timeZone", "canWrite", "isSelected", "isWriteTarget", "needsFullResync", "createdAt", "updatedAt")
  VALUES ('guard-check-cal3', 'guard-check-conn', 'someone-else', 'ext-guard-3', 'Sneaky', 'UTC', true, true, false, false, now(), now());
ROLLBACK;

\echo ''
\echo '== 5. A block that ends before it starts                    -> must FAIL'
BEGIN;
INSERT INTO scheduled_blocks (id, "taskId", "startsAt", "endsAt", state, "isPinned", "createdAt", "updatedAt")
  VALUES ('guard-check-b2', 'guard-check-task', now() + interval '2 hour', now(), 'PROPOSED', false, now(), now());
ROLLBACK;

\echo ''
\echo '== 6. A block on an event we created                        -> must SUCCEED'
BEGIN;
INSERT INTO scheduled_blocks (id, "taskId", "eventId", "startsAt", "endsAt", state, "isPinned", "createdAt", "updatedAt")
  VALUES ('guard-check-b3', 'guard-check-task', 'guard-check-ours', now(), now() + interval '1 hour', 'ACCEPTED', false, now(), now());
SELECT 'OK: ' || count(*)::text || ' block created' AS result FROM scheduled_blocks WHERE id = 'guard-check-b3';
ROLLBACK;

\echo ''
DELETE FROM users WHERE id = 'guard-check-user';
\echo 'Fixture removed.'
