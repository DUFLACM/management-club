-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "popup" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_reads" (
    "announcement_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("announcement_id","principal_id")
);

-- CreateIndex
CREATE INDEX "announcements_status_published_at_idx" ON "announcements"("status", "published_at");

-- CreateIndex
CREATE INDEX "announcement_reads_principal_id_idx" ON "announcement_reads"("principal_id");

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
