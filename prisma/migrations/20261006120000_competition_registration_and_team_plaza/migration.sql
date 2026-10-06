-- DropForeignKey
ALTER TABLE "frozen_ranking_rows" DROP CONSTRAINT "frozen_ranking_rows_freeze_id_fkey";

-- DropForeignKey
ALTER TABLE "ranking_freezes" DROP CONSTRAINT "ranking_freezes_rule_version_id_fkey";

-- DropIndex
DROP INDEX "competition_registrations_contest_key_user_id_key";

-- DropIndex
DROP INDEX "teams_contest_key_name_key";

-- AlterTable
ALTER TABLE "competition_registrations" DROP COLUMN "contest_key",
DROP COLUMN "freeze_id",
DROP COLUMN "title",
ADD COLUMN     "event_id" UUID NOT NULL,
ADD COLUMN     "platform_account_id" UUID,
ADD COLUMN     "result_detail" JSONB,
ADD COLUMN     "result_score" DECIMAL(12,4),
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID;

-- AlterTable
ALTER TABLE "team_members" ADD COLUMN     "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "left_at" TIMESTAMPTZ(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "teams" DROP COLUMN "contest_key",
ADD COLUMN     "captain_user_id" UUID NOT NULL,
ADD COLUMN     "created_by" UUID NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'forming',
ADD COLUMN     "team_size" INTEGER NOT NULL;

-- DropTable
DROP TABLE "frozen_ranking_rows";

-- DropTable
DROP TABLE "ranking_freezes";

-- CreateTable
CREATE TABLE "competition_events" (
    "id" UUID NOT NULL,
    "designated_contest_id" UUID,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "team_size" INTEGER,
    "scoring_mode" TEXT NOT NULL,
    "platform" TEXT,
    "platform_contest_id" TEXT,
    "contest_tier" TEXT,
    "lambda_key" TEXT,
    "announcement" TEXT NOT NULL,
    "register_start_at" TIMESTAMPTZ(3),
    "register_deadline" TIMESTAMPTZ(3) NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "quota" INTEGER,
    "qualification_rule" JSONB,
    "freeze_at" TIMESTAMPTZ(3),
    "team_form_deadline" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_shortlist_rows" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "e_snapshot" DECIMAL(20,4) NOT NULL,
    "q_score" DECIMAL(20,4),
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "shortlisted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "competition_shortlist_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_registration_materials" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_registration_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invites" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "invited_user_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(3),

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_competition_entries" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "result_score" DECIMAL(12,4),
    "result_detail" JSONB,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_competition_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_competition_materials" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_competition_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competition_events_status_category_idx" ON "competition_events"("status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "competition_shortlist_rows_event_id_user_id_key" ON "competition_shortlist_rows"("event_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_team_id_invited_user_id_status_key" ON "team_invites"("team_id", "invited_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_competition_entries_team_id_event_id_key" ON "team_competition_entries"("team_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_registrations_event_id_user_id_key" ON "competition_registrations"("event_id", "user_id");

-- AddForeignKey
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_designated_contest_id_fkey" FOREIGN KEY ("designated_contest_id") REFERENCES "designated_contests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_shortlist_rows" ADD CONSTRAINT "competition_shortlist_rows_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_shortlist_rows" ADD CONSTRAINT "competition_shortlist_rows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_registration_materials" ADD CONSTRAINT "competition_registration_materials_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "competition_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_competition_entries" ADD CONSTRAINT "team_competition_entries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_competition_entries" ADD CONSTRAINT "team_competition_entries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_competition_materials" ADD CONSTRAINT "team_competition_materials_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "team_competition_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
