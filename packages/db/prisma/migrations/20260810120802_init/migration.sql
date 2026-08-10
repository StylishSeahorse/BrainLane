-- CreateEnum
CREATE TYPE "NudgeTone" AS ENUM ('NEUTRAL', 'COACH', 'MINIMAL');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'MICROSOFT', 'CALDAV');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_ATTENTION', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "EventOrigin" AS ENUM ('EXTERNAL', 'APP_BLOCK');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventTransparency" AS ENUM ('BUSY', 'FREE');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('BACKLOG', 'READY', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "EnergyLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "BlockState" AS ENUM ('PROPOSED', 'ACCEPTED', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PlanChangeKind" AS ENUM ('ADDED', 'MOVED', 'RESIZED', 'REMOVED', 'UNCHANGED');

-- CreateEnum
CREATE TYPE "ProtectedTimeKind" AS ENUM ('ROUTINE', 'BUFFER', 'HYPERFOCUS');

-- CreateEnum
CREATE TYPE "RemoteOpKind" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "RemoteOpStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PULL', 'PUSH');

-- CreateEnum
CREATE TYPE "SyncOutcome" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED', 'CIRCUIT_BROKEN');

-- CreateEnum
CREATE TYPE "ConflictResolution" AS ENUM ('REMOTE_WON', 'LOCAL_WON', 'ACCEPTED_AS_INTENT', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE', 'LOCAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "passwordHash" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "highContrast" BOOLEAN NOT NULL DEFAULT false,
    "reducedMotion" BOOLEAN NOT NULL DEFAULT false,
    "dyslexiaFont" BOOLEAN NOT NULL DEFAULT false,
    "largeText" BOOLEAN NOT NULL DEFAULT false,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 10,
    "autoAcceptSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxDailyReshuffles" INTEGER NOT NULL DEFAULT 3,
    "nudgeTone" "NudgeTone" NOT NULL DEFAULT 'NEUTRAL',
    "nudgesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "accountIdentifier" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusDetail" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendars" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "color" TEXT,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "isSelected" BOOLEAN NOT NULL DEFAULT true,
    "isWriteTarget" BOOLEAN NOT NULL DEFAULT false,
    "syncCursor" TEXT,
    "needsFullResync" BOOLEAN NOT NULL DEFAULT false,
    "watchChannelId" TEXT,
    "watchResourceId" TEXT,
    "watchExpiresAt" TIMESTAMP(3),
    "watchTokenDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "externalId" TEXT,
    "iCalUid" TEXT,
    "etag" TEXT,
    "sequence" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "rrule" TEXT,
    "recurringEventId" TEXT,
    "originalStartsAt" TIMESTAMPTZ(3),
    "status" "EventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "transparency" "EventTransparency" NOT NULL DEFAULT 'BUSY',
    "origin" "EventOrigin" NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "remoteUpdatedAt" TIMESTAMP(3),
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "deadline" TIMESTAMPTZ(3),
    "lastTouchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "reachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'BACKLOG',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "energy" "EnergyLevel" NOT NULL DEFAULT 'MEDIUM',
    "estimateMinutes" INTEGER NOT NULL DEFAULT 30,
    "adjustedEstimateMinutes" INTEGER,
    "actualMinutes" INTEGER NOT NULL DEFAULT 0,
    "deadline" TIMESTAMPTZ(3),
    "earliestStart" TIMESTAMPTZ(3),
    "isSplittable" BOOLEAN NOT NULL DEFAULT true,
    "minChunkMinutes" INTEGER NOT NULL DEFAULT 25,
    "maxChunkMinutes" INTEGER NOT NULL DEFAULT 90,
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "lastTouchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "starterStep" TEXT,
    "avoidanceAcknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "prerequisiteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_blocks" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "eventId" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "BlockState" NOT NULL DEFAULT 'PROPOSED',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "planVersionId" TEXT,
    "actualMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_versions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'PROPOSED',
    "trigger" TEXT NOT NULL,
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "autoAcceptedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_changes" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "kind" "PlanChangeKind" NOT NULL,
    "taskId" TEXT NOT NULL,
    "previousStartsAt" TIMESTAMPTZ(3),
    "previousEndsAt" TIMESTAMPTZ(3),
    "newStartsAt" TIMESTAMPTZ(3),
    "newEndsAt" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,

    CONSTRAINT "plan_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "energy_windows" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "level" "EnergyLevel" NOT NULL,

    CONSTRAINT "energy_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protected_times" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ProtectedTimeKind" NOT NULL DEFAULT 'ROUTINE',
    "label" TEXT,
    "dayOfWeek" INTEGER,
    "startTime" TEXT,
    "endTime" TEXT,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protected_times_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_estimate_samples" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "category" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "actualMinutes" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_estimate_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_remote_ops" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "kind" "RemoteOpKind" NOT NULL,
    "status" "RemoteOpStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "eventId" TEXT,
    "externalId" TEXT,
    "expectedEtag" TEXT,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "pending_remote_ops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "outcome" "SyncOutcome" NOT NULL,
    "eventsCreated" INTEGER NOT NULL DEFAULT 0,
    "eventsUpdated" INTEGER NOT NULL DEFAULT 0,
    "eventsDeleted" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "detail" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "eventId" TEXT,
    "resolution" "ConflictResolution" NOT NULL DEFAULT 'UNRESOLVED',
    "localVersion" JSONB NOT NULL,
    "remoteVersion" JSONB NOT NULL,
    "explanation" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AiProviderKind" NOT NULL DEFAULT 'ANTHROPIC',
    "model" TEXT,
    "encryptedApiKey" TEXT,
    "baseUrl" TEXT,
    "allowScheduling" BOOLEAN NOT NULL DEFAULT true,
    "allowTaskBreakdown" BOOLEAN NOT NULL DEFAULT true,
    "allowAvoidanceCheck" BOOLEAN NOT NULL DEFAULT false,
    "allowChat" BOOLEAN NOT NULL DEFAULT false,
    "shareTaskText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenDigest_key" ON "sessions"("tokenDigest");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE INDEX "calendar_connections_status_idx" ON "calendar_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_userId_provider_accountIdentifier_key" ON "calendar_connections"("userId", "provider", "accountIdentifier");

-- CreateIndex
CREATE INDEX "calendars_watchChannelId_idx" ON "calendars"("watchChannelId");

-- CreateIndex
CREATE INDEX "calendars_userId_idx" ON "calendars"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "calendars_connectionId_externalId_key" ON "calendars"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "events_calendarId_startsAt_endsAt_idx" ON "events"("calendarId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "events_origin_idx" ON "events"("origin");

-- CreateIndex
CREATE INDEX "events_deletedAt_idx" ON "events"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "events_calendarId_externalId_key" ON "events"("calendarId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "events_calendarId_iCalUid_key" ON "events"("calendarId", "iCalUid");

-- CreateIndex
CREATE INDEX "projects_userId_status_idx" ON "projects"("userId", "status");

-- CreateIndex
CREATE INDEX "milestones_projectId_dueAt_idx" ON "milestones"("projectId", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_userId_status_idx" ON "tasks"("userId", "status");

-- CreateIndex
CREATE INDEX "tasks_userId_deadline_idx" ON "tasks"("userId", "deadline");

-- CreateIndex
CREATE INDEX "tasks_projectId_idx" ON "tasks"("projectId");

-- CreateIndex
CREATE INDEX "tasks_parentId_idx" ON "tasks"("parentId");

-- CreateIndex
CREATE INDEX "task_dependencies_prerequisiteId_idx" ON "task_dependencies"("prerequisiteId");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_dependentId_prerequisiteId_key" ON "task_dependencies"("dependentId", "prerequisiteId");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_blocks_eventId_key" ON "scheduled_blocks"("eventId");

-- CreateIndex
CREATE INDEX "scheduled_blocks_taskId_idx" ON "scheduled_blocks"("taskId");

-- CreateIndex
CREATE INDEX "scheduled_blocks_startsAt_endsAt_idx" ON "scheduled_blocks"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "scheduled_blocks_state_idx" ON "scheduled_blocks"("state");

-- CreateIndex
CREATE INDEX "plan_versions_userId_status_idx" ON "plan_versions"("userId", "status");

-- CreateIndex
CREATE INDEX "plan_changes_planVersionId_idx" ON "plan_changes"("planVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "working_hours_userId_dayOfWeek_startTime_key" ON "working_hours"("userId", "dayOfWeek", "startTime");

-- CreateIndex
CREATE INDEX "energy_windows_userId_idx" ON "energy_windows"("userId");

-- CreateIndex
CREATE INDEX "protected_times_userId_idx" ON "protected_times"("userId");

-- CreateIndex
CREATE INDEX "time_estimate_samples_userId_category_idx" ON "time_estimate_samples"("userId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "pending_remote_ops_idempotencyKey_key" ON "pending_remote_ops"("idempotencyKey");

-- CreateIndex
CREATE INDEX "pending_remote_ops_status_nextAttemptAt_idx" ON "pending_remote_ops"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "pending_remote_ops_eventId_idx" ON "pending_remote_ops"("eventId");

-- CreateIndex
CREATE INDEX "sync_logs_connectionId_startedAt_idx" ON "sync_logs"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_conflicts_calendarId_resolution_idx" ON "sync_conflicts"("calendarId", "resolution");

-- CreateIndex
CREATE UNIQUE INDEX "ai_settings_userId_key" ON "ai_settings"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_prerequisiteId_fkey" FOREIGN KEY ("prerequisiteId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_blocks" ADD CONSTRAINT "scheduled_blocks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_blocks" ADD CONSTRAINT "scheduled_blocks_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_blocks" ADD CONSTRAINT "scheduled_blocks_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_windows" ADD CONSTRAINT "energy_windows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protected_times" ADD CONSTRAINT "protected_times_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_estimate_samples" ADD CONSTRAINT "time_estimate_samples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_estimate_samples" ADD CONSTRAINT "time_estimate_samples_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_remote_ops" ADD CONSTRAINT "pending_remote_ops_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_remote_ops" ADD CONSTRAINT "pending_remote_ops_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Integrity guards beyond what Prisma's schema language can express.
--
-- The first two are the load-bearing ones. Everything above this line protects
-- shape; these protect the user's actual calendar.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- GUARD 1: the scheduler may only ever own events it created.
--
-- A ScheduledBlock is how the scheduler takes ownership of a calendar event —
-- it moves, resizes and deletes whatever its block points at. If a block could
-- ever point at an EXTERNAL event, a scheduling bug would silently rewrite or
-- delete a real meeting. That is the one failure this product cannot survive,
-- so it is refused by the database and not only by the repository layer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluid_assert_block_event_is_app_block()
RETURNS TRIGGER AS $$
DECLARE
  target_origin "EventOrigin";
BEGIN
  IF NEW."eventId" IS NULL THEN
    RETURN NEW; -- A PROPOSED block, or a user with no calendar connected.
  END IF;

  SELECT "origin" INTO target_origin FROM "events" WHERE "id" = NEW."eventId";

  IF target_origin IS DISTINCT FROM 'APP_BLOCK' THEN
    RAISE EXCEPTION
      'scheduled_blocks.eventId % points at an event with origin %; the scheduler may only own APP_BLOCK events',
      NEW."eventId", COALESCE(target_origin::text, 'MISSING');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_blocks_event_origin_guard
BEFORE INSERT OR UPDATE OF "eventId" ON "scheduled_blocks"
FOR EACH ROW EXECUTE FUNCTION fluid_assert_block_event_is_app_block();

-- ---------------------------------------------------------------------------
-- GUARD 2: origin is immutable.
--
-- Without this, guard 1 is bypassable in two steps: relabel an EXTERNAL event
-- as APP_BLOCK, then attach a block to it. Ownership is decided once, when the
-- event is created, and never reassigned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluid_assert_event_origin_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."origin" IS DISTINCT FROM OLD."origin" THEN
    RAISE EXCEPTION
      'events.origin is immutable (attempted % -> % on event %); ownership is decided at creation',
      OLD."origin", NEW."origin", OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_origin_immutable_guard
BEFORE UPDATE OF "origin" ON "events"
FOR EACH ROW EXECUTE FUNCTION fluid_assert_event_origin_immutable();

-- ---------------------------------------------------------------------------
-- GUARD 3: calendars.userId must agree with its connection's owner.
--
-- userId is denormalized onto calendars so the write-target index below can
-- exist at all. This keeps the denormalization honest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluid_assert_calendar_user_matches_connection()
RETURNS TRIGGER AS $$
DECLARE
  owner_id TEXT;
BEGIN
  SELECT "userId" INTO owner_id FROM "calendar_connections" WHERE "id" = NEW."connectionId";

  IF owner_id IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION
      'calendars.userId (%) does not match the owner of connection % (%)',
      NEW."userId", NEW."connectionId", COALESCE(owner_id, 'MISSING');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calendars_user_matches_connection_guard
BEFORE INSERT OR UPDATE OF "userId", "connectionId" ON "calendars"
FOR EACH ROW EXECUTE FUNCTION fluid_assert_calendar_user_matches_connection();

-- ---------------------------------------------------------------------------
-- GUARD 4: at most one write-target calendar per user.
--
-- Two write targets would mean scheduled blocks scattered across calendars with
-- no single place to reconcile them.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "calendars_one_write_target_per_user"
ON "calendars" ("userId") WHERE "isWriteTarget";

-- ---------------------------------------------------------------------------
-- Range and value sanity. Cheap, and they turn a class of scheduling bugs into
-- a loud failure at the write instead of a corrupt calendar discovered later.
-- ---------------------------------------------------------------------------

-- All-day events legitimately have equal start and end; timed events must not
-- run backwards.
ALTER TABLE "events"
  ADD CONSTRAINT "events_end_not_before_start" CHECK ("endsAt" >= "startsAt");

ALTER TABLE "scheduled_blocks"
  ADD CONSTRAINT "scheduled_blocks_end_after_start" CHECK ("endsAt" > "startsAt");

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_estimate_positive" CHECK ("estimateMinutes" > 0),
  ADD CONSTRAINT "tasks_chunk_bounds"
    CHECK ("minChunkMinutes" > 0 AND "maxChunkMinutes" >= "minChunkMinutes"),
  ADD CONSTRAINT "tasks_actual_not_negative" CHECK ("actualMinutes" >= 0);

-- A task cannot block itself. Longer dependency cycles are caught in the
-- scheduler, which has to walk the graph anyway.
ALTER TABLE "task_dependencies"
  ADD CONSTRAINT "task_dependencies_no_self_reference"
    CHECK ("dependentId" <> "prerequisiteId");

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_sane_ranges"
    CHECK ("bufferMinutes" >= 0 AND "autoAcceptSeconds" >= 0 AND "maxDailyReshuffles" >= 0);

ALTER TABLE "time_estimate_samples"
  ADD CONSTRAINT "time_estimate_samples_positive"
    CHECK ("estimatedMinutes" > 0 AND "actualMinutes" >= 0);
