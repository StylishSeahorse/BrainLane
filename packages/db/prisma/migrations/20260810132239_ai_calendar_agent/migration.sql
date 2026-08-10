-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('FULL_AUTO', 'AUTO_WITH_UNDO', 'PROPOSE_THEN_CONFIRM');

-- CreateEnum
CREATE TYPE "ActionScope" AS ENUM ('TODAY', 'THIS_WEEK');

-- CreateEnum
CREATE TYPE "AiActionKind" AS ENUM ('CREATE_BLOCK', 'MOVE_BLOCK', 'RESIZE_BLOCK', 'DELETE_BLOCK');

-- CreateEnum
CREATE TYPE "AiActionStatus" AS ENUM ('APPLIED', 'PROPOSED', 'REVERTED', 'BLOCKED', 'REJECTED');

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "aiActionScope" "ActionScope" NOT NULL DEFAULT 'TODAY',
ADD COLUMN     "aiAutonomy" "AutonomyLevel" NOT NULL DEFAULT 'AUTO_WITH_UNDO',
ADD COLUMN     "undoWindowSeconds" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "ai_actions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AiActionKind" NOT NULL,
    "status" "AiActionStatus" NOT NULL,
    "blockId" TEXT,
    "taskId" TEXT,
    "reason" TEXT NOT NULL,
    "explanation" TEXT,
    "boundary" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "batchId" TEXT,
    "scope" "ActionScope" NOT NULL DEFAULT 'TODAY',
    "undoExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_actions_userId_createdAt_idx" ON "ai_actions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_actions_batchId_idx" ON "ai_actions"("batchId");

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
