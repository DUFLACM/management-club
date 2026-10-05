-- DropForeignKey
ALTER TABLE "calculation_batches" DROP CONSTRAINT "calculation_batches_rule_version_id_fkey";

-- DropForeignKey
ALTER TABLE "disclosures" DROP CONSTRAINT "disclosures_rule_version_id_fkey";

-- AlterTable
ALTER TABLE "calculation_batches" ALTER COLUMN "rule_version_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "disclosures" ALTER COLUMN "rule_version_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "calculation_batches" ADD CONSTRAINT "calculation_batches_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
