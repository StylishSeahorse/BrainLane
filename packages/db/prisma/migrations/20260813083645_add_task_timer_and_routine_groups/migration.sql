-- AlterTable
ALTER TABLE "protected_times" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "timerStartedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "protected_times_groupId_idx" ON "protected_times"("groupId");
