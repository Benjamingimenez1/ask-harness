-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'assistant', 'tool');
CREATE TYPE "MemoryScope" AS ENUM ('USER', 'CONVERSATION');
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DELETED');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');
CREATE TYPE "ToolRunStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "summary" TEXT,
    "summarizedThroughSeq" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "requestId" TEXT,
    "role" "Role" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "conversationId" TEXT,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueDate" TIMESTAMP(3),
    "goalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "ToolRunStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TurnTrace" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contextTokens" INTEGER NOT NULL,
    "includedMemoryIds" TEXT[],
    "droppedMessageCount" INTEGER NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "unbackedClaims" TEXT[],
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TurnTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");
CREATE UNIQUE INDEX "Message_requestId_key" ON "Message"("requestId");
CREATE INDEX "Message_conversationId_seq_idx" ON "Message"("conversationId", "seq");
CREATE INDEX "Memory_userId_status_idx" ON "Memory"("userId", "status");
CREATE INDEX "Task_userId_status_dueDate_idx" ON "Task"("userId", "status", "dueDate");
CREATE INDEX "Goal_userId_idx" ON "Goal"("userId");
CREATE INDEX "Note_userId_idx" ON "Note"("userId");
CREATE UNIQUE INDEX "ToolExecution_idempotencyKey_key" ON "ToolExecution"("idempotencyKey");
CREATE INDEX "TurnTrace_conversationId_createdAt_idx" ON "TurnTrace"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TurnTrace" ADD CONSTRAINT "TurnTrace_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written additions Prisma's schema language cannot express --------------

-- At most one ACTIVE memory per (user, scope, conversation, key). Saving a new
-- value supersedes the old one inside a transaction; this index turns a race
-- between two concurrent saves into an error instead of two "current" values.
CREATE UNIQUE INDEX "Memory_one_active_per_key"
  ON "Memory"("userId", "scope", COALESCE("conversationId", ''), "key")
  WHERE "status" = 'ACTIVE';

-- Full-text search over notes (used by the search_notes tool).
CREATE INDEX "Note_fts_idx"
  ON "Note" USING GIN (to_tsvector('english', "title" || ' ' || "body"));
