-- CreateTable
CREATE TABLE "lecture_ratings" (
    "id" UUID NOT NULL,
    "lecture_request_id" UUID NOT NULL,
    "rater_user_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lecture_ratings_lecture_request_id_created_at_idx" ON "lecture_ratings"("lecture_request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lecture_ratings_lecture_request_id_rater_user_id_key" ON "lecture_ratings"("lecture_request_id", "rater_user_id");

-- AddForeignKey
-- 讲题申请被撤销/删除时评分一并清理，避免孤立评分被聚合进别处
ALTER TABLE "lecture_ratings" ADD CONSTRAINT "lecture_ratings_lecture_request_id_fkey" FOREIGN KEY ("lecture_request_id") REFERENCES "lecture_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_ratings" ADD CONSTRAINT "lecture_ratings_rater_user_id_fkey" FOREIGN KEY ("rater_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
