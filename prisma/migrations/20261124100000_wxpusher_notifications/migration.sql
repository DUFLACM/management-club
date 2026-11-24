-- CreateTable
CREATE TABLE "user_wxpusher_bindings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wxpusher_uid" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_points" BOOLEAN NOT NULL DEFAULT true,
    "notify_approvals" BOOLEAN NOT NULL DEFAULT true,
    "notify_activities" BOOLEAN NOT NULL DEFAULT true,
    "notify_competitions" BOOLEAN NOT NULL DEFAULT true,
    "notify_announcements" BOOLEAN NOT NULL DEFAULT true,
    "bound_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_pushed_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_wxpusher_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wxpusher_bind_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wxpusher_bind_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_wxpusher_bindings_user_id_key" ON "user_wxpusher_bindings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_wxpusher_bindings_wxpusher_uid_key" ON "user_wxpusher_bindings"("wxpusher_uid");

-- CreateIndex
CREATE INDEX "user_wxpusher_bindings_enabled_idx" ON "user_wxpusher_bindings"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "wxpusher_bind_tokens_token_key" ON "wxpusher_bind_tokens"("token");

-- CreateIndex
CREATE INDEX "wxpusher_bind_tokens_user_id_created_at_idx" ON "wxpusher_bind_tokens"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wxpusher_bind_tokens_expires_at_idx" ON "wxpusher_bind_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "user_wxpusher_bindings" ADD CONSTRAINT "user_wxpusher_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wxpusher_bind_tokens" ADD CONSTRAINT "wxpusher_bind_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
