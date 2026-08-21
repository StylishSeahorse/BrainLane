-- CreateEnum
CREATE TYPE "TimeBucket" AS ENUM ('SOON', 'THIS_MONTH', 'THIS_QUARTER', 'LATER', 'SOMEDAY');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "objectiveId" TEXT,
ADD COLUMN     "timeBucket" "TimeBucket";

-- CreateTable
CREATE TABLE "objectives" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "weekStart" TIMESTAMPTZ(3) NOT NULL,
    "achievedAt" TIMESTAMP(3),
    "rolledFromId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TIMESTAMPTZ(3) NOT NULL,
    "plannedAt" TIMESTAMP(3),
    "shutdownAt" TIMESTAMP(3),
    "reflection" TEXT,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "focusedMinutes" INTEGER NOT NULL DEFAULT 0,
    "meetingMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "day_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "objectives_userId_weekStart_idx" ON "objectives"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "day_logs_userId_day_idx" ON "day_logs"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "day_logs_userId_day_key" ON "day_logs"("userId", "day");

-- CreateIndex
CREATE INDEX "tasks_userId_timeBucket_idx" ON "tasks"("userId", "timeBucket");

-- CreateIndex
CREATE INDEX "tasks_objectiveId_idx" ON "tasks"("objectiveId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_logs" ADD CONSTRAINT "day_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

