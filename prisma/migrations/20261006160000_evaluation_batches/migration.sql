-- 综合素质评价建议折算（附录三）：学期批次 + 逐人建议加分
-- DDL 由 `prisma migrate diff --from-empty --to-schema` 生成后摘出，字段与 schema.prisma 一致。

-- CreateTable
CREATE TABLE "evaluation_batches" (
    "id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "weights" JSONB NOT NULL,
    "tier_ratios" JSONB NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "generated_by" UUID,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "evaluation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "student_no" VARCHAR(64) NOT NULL,
    "real_name" TEXT NOT NULL,
    "points_avg" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "points_std" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "contest_std" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "service_std" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discipline_penalty" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "h_score" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "rank_no" INTEGER,
    "tier" TEXT,
    "suggested_score" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "override_points_std" DECIMAL(9,4),
    "override_contest_std" DECIMAL(9,4),
    "override_service_std" DECIMAL(9,4),
    "override_penalty" DECIMAL(9,4),
    "override_score" DECIMAL(6,3),
    "override_reason" TEXT,
    "override_by" UUID,
    "override_at" TIMESTAMPTZ(3),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "exclude_reason" TEXT,
    "cadre" BOOLEAN NOT NULL DEFAULT false,
    "tiebreak" JSONB,

    CONSTRAINT "evaluation_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluation_batches_semester_id_generated_at_idx" ON "evaluation_batches"("semester_id", "generated_at");

-- CreateIndex
CREATE INDEX "evaluation_rows_batch_id_rank_no_idx" ON "evaluation_rows"("batch_id", "rank_no");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_rows_batch_id_user_id_key" ON "evaluation_rows"("batch_id", "user_id");

-- AddForeignKey
ALTER TABLE "evaluation_batches" ADD CONSTRAINT "evaluation_batches_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_rows" ADD CONSTRAINT "evaluation_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "evaluation_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_rows" ADD CONSTRAINT "evaluation_rows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
