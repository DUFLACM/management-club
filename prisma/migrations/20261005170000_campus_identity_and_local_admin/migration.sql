-- Campus identifiers are opaque CAS-verified strings. They are never parsed as
-- numbers so leading zeroes survive, and their length is not fixed to nine.
ALTER TABLE "users" DROP CONSTRAINT "users_student_no_format_check";
ALTER TABLE "users" ALTER COLUMN "student_no" TYPE VARCHAR(64);
ALTER TABLE "invitations" ALTER COLUMN "allowed_student_no" TYPE VARCHAR(64);
ALTER TABLE "registration_intents" ALTER COLUMN "student_no" TYPE VARCHAR(64);
ALTER TABLE "hydro_identity_links" ALTER COLUMN "verified_student_no" TYPE VARCHAR(64);
ALTER TABLE "disclosure_rows" ALTER COLUMN "student_no" TYPE VARCHAR(64);

ALTER TABLE "auth_identities" RENAME COLUMN "verified_student_no" TO "verified_campus_id";
ALTER TABLE "auth_identities" ALTER COLUMN "verified_campus_id" TYPE VARCHAR(64);

ALTER TABLE "staff_profiles" ADD COLUMN "staff_no" VARCHAR(64);

ALTER TABLE "users"
  ADD CONSTRAINT "users_student_no_format_check"
  CHECK ("student_no" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "staff_profiles"
  ADD CONSTRAINT "staff_profiles_staff_no_format_check"
  CHECK ("staff_no" IS NULL OR "staff_no" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "auth_identities"
  ADD CONSTRAINT "auth_identities_campus_id_format_check"
  CHECK ("verified_campus_id" IS NULL OR "verified_campus_id" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_student_no_format_check"
  CHECK ("allowed_student_no" IS NULL OR "allowed_student_no" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "registration_intents"
  ADD CONSTRAINT "registration_intents_student_no_format_check"
  CHECK ("student_no" IS NULL OR "student_no" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "hydro_identity_links"
  ADD CONSTRAINT "hydro_identity_links_student_no_format_check"
  CHECK ("verified_student_no" ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE "disclosure_rows"
  ADD CONSTRAINT "disclosure_rows_student_no_format_check"
  CHECK ("student_no" ~ '^[A-Za-z0-9._-]{1,64}$');

CREATE UNIQUE INDEX "staff_profiles_staff_no_key" ON "staff_profiles"("staff_no");
CREATE UNIQUE INDEX "auth_identities_principal_id_provider_key" ON "auth_identities"("principal_id", "provider");

-- Local administrator authentication is independent from CAS and invitations.
-- Passwords and the shared access phrase are represented only by slow hashes.
CREATE TABLE "admin_credentials" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disabled_at" TIMESTAMPTZ(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_credentials_username_format_check"
      CHECK ("username" ~ '^[a-z0-9._-]{3,64}$'),
    CONSTRAINT "admin_credentials_display_name_check"
      CHECK (btrim("display_name") <> ''),
    CONSTRAINT "admin_credentials_status_check"
      CHECK ("status" IN ('active', 'disabled')),
    CONSTRAINT "admin_credentials_failed_attempts_check"
      CHECK ("failed_attempts" >= 0)
);

CREATE TABLE "admin_access_secrets" (
    "key" TEXT NOT NULL DEFAULT 'primary',
    "secret_hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_access_secrets_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "admin_access_secrets_key_check" CHECK ("key" = 'primary'),
    CONSTRAINT "admin_access_secrets_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "admin_gate_challenges" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "secret_version" INTEGER NOT NULL,
    "ip_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_gate_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_login_challenges" (
    "id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "answer_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_auth_throttles" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_auth_throttles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_auth_throttles_failed_count_check" CHECK ("failed_count" >= 0)
);

CREATE UNIQUE INDEX "admin_credentials_principal_id_key" ON "admin_credentials"("principal_id");
CREATE UNIQUE INDEX "admin_credentials_username_key" ON "admin_credentials"("username");
CREATE UNIQUE INDEX "admin_gate_challenges_token_hash_key" ON "admin_gate_challenges"("token_hash");
CREATE INDEX "admin_gate_challenges_expires_at_idx" ON "admin_gate_challenges"("expires_at");
CREATE INDEX "admin_login_challenges_gate_id_expires_at_idx" ON "admin_login_challenges"("gate_id", "expires_at");
CREATE UNIQUE INDEX "admin_auth_throttles_scope_key_hash_key" ON "admin_auth_throttles"("scope", "key_hash");
CREATE INDEX "admin_auth_throttles_blocked_until_idx" ON "admin_auth_throttles"("blocked_until");

ALTER TABLE "admin_credentials"
  ADD CONSTRAINT "admin_credentials_principal_id_fkey"
  FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_login_challenges"
  ADD CONSTRAINT "admin_login_challenges_gate_id_fkey"
  FOREIGN KEY ("gate_id") REFERENCES "admin_gate_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
