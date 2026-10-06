-- 贡献申报佐证：补回被静默丢弃的文字说明，并支持多张图片佐证。
-- points_claims.evidence_asset_id 为单图遗留字段，保留不动以兼容历史数据。

-- AlterTable
ALTER TABLE "points_claims" ADD COLUMN "evidence_note" TEXT;

-- CreateTable
CREATE TABLE "points_claim_assets" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_claim_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "points_claim_assets_asset_id_key" ON "points_claim_assets"("asset_id");

-- CreateIndex
CREATE INDEX "points_claim_assets_claim_id_idx" ON "points_claim_assets"("claim_id");

-- AddForeignKey
ALTER TABLE "points_claim_assets" ADD CONSTRAINT "points_claim_assets_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "points_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_claim_assets" ADD CONSTRAINT "points_claim_assets_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
