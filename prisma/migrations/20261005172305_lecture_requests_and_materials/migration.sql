-- DropForeignKey
ALTER TABLE "admin_login_challenges" DROP CONSTRAINT "admin_login_challenges_gate_id_fkey";

-- CreateTable
CREATE TABLE "lecture_requests" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "topic" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_materials" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "uploader_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'solution',
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lecture_requests_activity_id_user_id_key" ON "lecture_requests"("activity_id", "user_id");

-- CreateIndex
CREATE INDEX "activity_materials_activity_id_idx" ON "activity_materials"("activity_id");

-- AddForeignKey
-- 保持 20261005170000 建立的 CASCADE 语义（密语轮换撤销 gate 时级联清理验证码）
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_gate_id_fkey" FOREIGN KEY ("gate_id") REFERENCES "admin_gate_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_requests" ADD CONSTRAINT "lecture_requests_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_requests" ADD CONSTRAINT "lecture_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_materials" ADD CONSTRAINT "activity_materials_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_materials" ADD CONSTRAINT "activity_materials_uploader_user_id_fkey" FOREIGN KEY ("uploader_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
