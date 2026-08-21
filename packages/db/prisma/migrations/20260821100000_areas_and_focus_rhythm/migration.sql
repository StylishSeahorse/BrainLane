-- Areas, and the focus rhythm settings.
--
-- An area is a context one level above a project: Work, Personal, the side
-- project. `countsTowardCapacity` is the part that earns its keep — time in an
-- area that does not count still reduces the day's free time, because it is
-- real time, but it is reported apart from the day's committed work rather
-- than inflating it.

-- CreateTable
CREATE TABLE "areas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "countsTowardCapacity" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "areas_userId_position_idx" ON "areas"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "areas_userId_name_key" ON "areas"("userId", "name");

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "areaId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "areaId" TEXT;

-- CreateIndex
CREATE INDEX "projects_areaId_idx" ON "projects"("areaId");

-- CreateIndex
CREATE INDEX "tasks_areaId_idx" ON "tasks"("areaId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "pomodoroEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pomodoroWorkMinutes" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "pomodoroBreakMinutes" INTEGER NOT NULL DEFAULT 10;
