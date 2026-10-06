-- 指定比赛认定目录（附录一 A/B/C）
-- CreateTable
CREATE TABLE "designated_contests" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "lambda_key" TEXT,
    "note" TEXT,
    "evidence_ref" TEXT,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "designated_contests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "designated_contests_category_status_idx" ON "designated_contests"("category", "status");
