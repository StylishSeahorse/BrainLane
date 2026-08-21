-- Day commitments.
--
-- `plannedFor` is the line between a record and a promise: a backlog item is
-- something that exists, a task with a day is something the user has said they
-- are doing. `dayOrder` is their ranking within that day, and `rolloverCount`
-- counts how often the promise has been pushed forward.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "plannedFor" TIMESTAMPTZ(3),
ADD COLUMN     "dayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rolloverCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "tasks_userId_plannedFor_dayOrder_idx" ON "tasks"("userId", "plannedFor", "dayOrder");
