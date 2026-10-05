-- CreateTable
CREATE TABLE "principals" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "student_no" VARCHAR(9) NOT NULL,
    "verified_real_name" TEXT NOT NULL,
    "account_status" TEXT NOT NULL DEFAULT 'active',
    "grade" INTEGER,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "real_name" TEXT NOT NULL,
    "title" TEXT,
    "approved_source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "verified_student_no" VARCHAR(9),
    "verified_real_name" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "flow_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "cookie_binding_hash" TEXT NOT NULL,
    "exact_service" TEXT NOT NULL,
    "return_target" TEXT,
    "registration_intent_id" UUID,
    "attendance_intent_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anonymous_bindings" (
    "id" UUID NOT NULL,
    "cookie_hash" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anonymous_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "principal_id" UUID NOT NULL,
    "auth_time" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "authz_version" INTEGER NOT NULL DEFAULT 1,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "batch_id" UUID,
    "batch_label" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'registration',
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "allowed_student_no" VARCHAR(9),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_redemptions" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_intents" (
    "id" UUID NOT NULL,
    "invitation_id" UUID,
    "anonymous_cookie_hash" TEXT NOT NULL,
    "cas_subject" TEXT,
    "student_no" VARCHAR(9),
    "real_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semesters" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" TIMESTAMP(3) NOT NULL,
    "ends_on" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semesters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_terms" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "membership_status" TEXT NOT NULL,
    "semester_registered_at" TIMESTAMP(3),
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "basis" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_transitions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "months_in_status" INTEGER,
    "grace_months" INTEGER,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rule_version_id" UUID,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "decided_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_grants" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'global',
    "scope_id" UUID,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restrictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "decided_by" UUID NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "campus" TEXT,
    "building" TEXT,
    "floor" TEXT,
    "room" TEXT,
    "description" TEXT,
    "directions" TEXT,
    "operational_status" TEXT NOT NULL DEFAULT 'active',
    "effective_version_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "suspend_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_versions" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL,
    "campus" TEXT,
    "building" TEXT,
    "floor" TEXT,
    "room" TEXT,
    "description" TEXT,
    "directions" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "radius_meters" DECIMAL(8,2),
    "max_accuracy_meters" DECIMAL(8,2),
    "coordinate_source" TEXT,
    "allowed_capabilities" TEXT[],
    "valid_from" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMP(3),
    "content_hash" VARCHAR(64),
    "evidence_digest" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_version_contributors" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "first_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_version_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_verification_samples" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "sampled_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracy_meters" DECIMAL(8,2),
    "device_type" TEXT,
    "note" TEXT,
    "content_hash" VARCHAR(64),
    "retention" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "venue_verification_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_review_events" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence_ref" TEXT,
    "content_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'custom',
    "platform" TEXT,
    "platform_contest_id" TEXT,
    "hydro_instance_id" UUID,
    "title" TEXT NOT NULL,
    "announcement" TEXT NOT NULL,
    "join_notes" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "register_start_at" TIMESTAMP(3),
    "register_deadline" TIMESTAMP(3),
    "cancel_deadline" TIMESTAMP(3),
    "capacity" INTEGER,
    "waitlist_capacity" INTEGER,
    "approval_required" BOOLEAN NOT NULL DEFAULT false,
    "waitlist_confirm_hours" INTEGER,
    "remote_allowed" BOOLEAN NOT NULL DEFAULT false,
    "remote_policy" TEXT,
    "leave_deadline" TIMESTAMP(3),
    "require_valid_submission" BOOLEAN NOT NULL DEFAULT false,
    "rule_version_id" UUID,
    "scoring_config" JSONB,
    "contest_meta" JSONB,
    "venue_version_id" UUID,
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_venue_bindings" (
    "activity_id" UUID NOT NULL,
    "venue_version_id" UUID NOT NULL,
    "fence_snapshot" JSONB,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "policy" TEXT NOT NULL,
    "checkin_open_at" TIMESTAMP(3) NOT NULL,
    "checkin_close_at" TIMESTAMP(3) NOT NULL,
    "checkout_open_at" TIMESTAMP(3),
    "checkout_close_at" TIMESTAMP(3),
    "max_accuracy_meters" DECIMAL(8,2) NOT NULL DEFAULT 50,
    "qr_rotate_seconds" INTEGER NOT NULL DEFAULT 25,
    "qr_ttl_seconds" INTEGER NOT NULL DEFAULT 60,
    "self_checkout" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_registrations" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "waitlist_seq" INTEGER,
    "confirm_deadline" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "idempotency_key" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_history" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_principal_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_participants" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "participation_mode" TEXT NOT NULL DEFAULT 'onsite',
    "eligibility_note" TEXT,
    "frozen_at" TIMESTAMP(3),

    CONSTRAINT "activity_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidence_asset_id" UUID,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_permissions" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "month_key" VARCHAR(7) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_reports" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "affected_user_ids" TEXT[],
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_qr_windows" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "venue_version_id" UUID NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "policy_version" INTEGER NOT NULL,

    CONSTRAINT "attendance_qr_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_challenges" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_attempts" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "failure_code" TEXT,
    "server_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policy_version" INTEGER NOT NULL,
    "qr_window_id" UUID,
    "challenge_id" UUID,
    "geo_evidence_enc" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_checkpoints" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "venue_version_id" UUID,
    "attempt_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_results" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_minutes" INTEGER NOT NULL DEFAULT 0,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "incident_ref" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decided_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "original_value" JSONB NOT NULL,
    "corrected_value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence_ref" TEXT,
    "operator_id" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_handle" TEXT,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "proof_summary" TEXT,
    "verified_by" UUID,
    "verified_at" TIMESTAMP(3),
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_contests" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_contest_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "rule" TEXT,
    "problem_count" INTEGER,
    "full_score" DECIMAL(12,2),
    "rated" BOOLEAN,
    "facts_version" INTEGER NOT NULL DEFAULT 1,
    "source_url" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "sync_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_contests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_results" (
    "id" UUID NOT NULL,
    "platform_contest_id" UUID NOT NULL,
    "platform_account_id" UUID NOT NULL,
    "participation_type" TEXT NOT NULL DEFAULT 'OFFICIAL',
    "score" DECIMAL(14,4),
    "full_score" DECIMAL(14,4),
    "accepted_count" INTEGER,
    "problem_count" INTEGER,
    "rank" INTEGER,
    "rank_total" INTEGER,
    "sign_up_count" INTEGER,
    "rating" DECIMAL(10,2),
    "rating_change" DECIMAL(10,2),
    "rating_status" TEXT,
    "can_show_rank" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "source_snapshot_id" UUID,
    "facts_version" INTEGER NOT NULL DEFAULT 1,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adapter_version" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "storage_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "byte_size" INTEGER,

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_rate_limits" (
    "host" TEXT NOT NULL,
    "next_allowed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_rate_limits_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "integration_instances" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'hydro',
    "instance_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "allowed_domains" TEXT[],
    "adapter_version" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "config" JSONB,
    "secret_ref" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hydro_identity_links" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "hydro_uid" INTEGER NOT NULL,
    "hydro_uname" TEXT,
    "user_id" UUID NOT NULL,
    "verified_student_no" VARCHAR(9) NOT NULL,
    "proof_type" TEXT NOT NULL,
    "reviewed_by" UUID NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hydro_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hydro_event_receipts" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "body_hash" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "hydro_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hydro_nonces" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hydro_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "locked_by" TEXT,
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_versions" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "pending_items" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publicized_at" TIMESTAMP(3),
    "effective_from" TIMESTAMP(3) NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calculation_batches" (
    "id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "summary" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calculation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_ledger" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(20,10) NOT NULL,
    "score_month" VARCHAR(7) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "batch_id" UUID,
    "rule_version_id" UUID,
    "detail" JSONB,
    "evidence_ref" TEXT,
    "approved_by" UUID,
    "reverses_entry_id" UUID,
    "replaced_by_entry_id" UUID,
    "reversal_reason" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_scores" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "score_month" VARCHAR(7) NOT NULL,
    "raw_total" DECIMAL(20,10) NOT NULL,
    "m" INTEGER,
    "rounding_policy" TEXT,
    "category_caps" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "batch_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effective_score_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "e" DECIMAL(20,4) NOT NULL,
    "components" JSONB NOT NULL,
    "low_activity" BOOLEAN NOT NULL DEFAULT false,
    "inactive_months" INTEGER NOT NULL DEFAULT 0,
    "qualification" TEXT NOT NULL DEFAULT 'ranked',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "effective_score_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_claims" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "sub_type" TEXT,
    "activity_id" UUID,
    "contest_key" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence_asset_id" UUID,
    "score_month" VARCHAR(7) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cases" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "target_user_id" UUID,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "teacher_required" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_votes" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "disclosure_id" UUID,
    "ledger_entry_id" UUID,
    "subject" TEXT NOT NULL,
    "materials" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "resolution_note" TEXT,
    "review_case_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosures" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "month_key" VARCHAR(7),
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "rule_version_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "disclosures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosure_rows" (
    "id" UUID NOT NULL,
    "disclosure_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "student_no" VARCHAR(9) NOT NULL,
    "grade" INTEGER,
    "membership" TEXT NOT NULL,
    "last_month_e" DECIMAL(20,4) NOT NULL,
    "month_added" DECIMAL(20,4) NOT NULL,
    "deductions" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "current_e" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "disclosure_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_freezes" (
    "id" UUID NOT NULL,
    "contest_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "freeze_at" TIMESTAMP(3) NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scope_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frozen_ranking_rows" (
    "id" UUID NOT NULL,
    "freeze_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "e_snapshot" DECIMAL(20,4) NOT NULL,
    "q_score" DECIMAL(20,4),
    "eligible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "frozen_ranking_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_registrations" (
    "id" UUID NOT NULL,
    "contest_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "freeze_id" UUID,
    "note" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "competition_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "contest_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_bookings" (
    "id" UUID NOT NULL,
    "venue_id" UUID,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "contest_link" TEXT,
    "applicant_user_id" UUID NOT NULL,
    "co_applicant_user_ids" TEXT[],
    "headcount" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "bio" TEXT,
    "avatar_asset_id" UUID,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "theme_preference" TEXT NOT NULL DEFAULT 'light',
    "display_preferences" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "profile_featured_badges" (
    "user_id" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "award_id" UUID NOT NULL
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "mime_type" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "frames" INTEGER,
    "content_hash" VARCHAR(64),
    "storage_key" TEXT,
    "variants" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_definitions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'blue',
    "category" TEXT NOT NULL,
    "grant_method" TEXT NOT NULL DEFAULT 'manual',
    "is_official_honor" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_rule_versions" (
    "id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "publicized_at" TIMESTAMP(3),
    "preview" JSONB,

    CONSTRAINT "badge_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_awards" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "rule_version" INTEGER,
    "source_key" TEXT NOT NULL,
    "evidence_ref" TEXT,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "revoked_reason" TEXT,

    CONSTRAINT "badge_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_rating_points" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "integration_instance_id" UUID,
    "platform_account_id" UUID,
    "series_type" TEXT NOT NULL,
    "external_event_id" TEXT,
    "contest_key" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "old_value" DECIMAL(12,4),
    "new_value" DECIMAL(12,4),
    "snapshot_value" DECIMAL(12,4),
    "source_revision" INTEGER NOT NULL DEFAULT 1,
    "completeness" TEXT NOT NULL DEFAULT 'complete',

    CONSTRAINT "platform_rating_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_setting_versions" (
    "id" UUID NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "value" JSONB NOT NULL,
    "secret_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_summary" TEXT,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "published_at" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3),
    "revert_of_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_setting_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_events" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_references" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "configured" BOOLEAN NOT NULL DEFAULT true,
    "last_rotated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMP(3),

    CONSTRAINT "secret_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_principal_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "summary" TEXT,
    "before_digest" TEXT,
    "after_digest" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_meta" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_meta_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_principal_id_key" ON "users"("principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_student_no_key" ON "users"("student_no");

-- CreateIndex
CREATE INDEX "users_student_no_idx" ON "users"("student_no");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_principal_id_key" ON "staff_profiles"("principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "auth_attempts_flow_hash_key" ON "auth_attempts"("flow_hash");

-- CreateIndex
CREATE INDEX "auth_attempts_status_expires_at_idx" ON "auth_attempts"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_bindings_cookie_hash_key" ON "anonymous_bindings"("cookie_hash");

-- CreateIndex
CREATE INDEX "anonymous_bindings_expires_at_idx" ON "anonymous_bindings"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_principal_id_idx" ON "sessions"("principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_status_expires_at_idx" ON "invitations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_redemptions_invitation_id_user_id_key" ON "invitation_redemptions"("invitation_id", "user_id");

-- CreateIndex
CREATE INDEX "registration_intents_expires_at_idx" ON "registration_intents"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "semesters_code_key" ON "semesters"("code");

-- CreateIndex
CREATE UNIQUE INDEX "membership_terms_user_id_semester_id_key" ON "membership_terms"("user_id", "semester_id");

-- CreateIndex
CREATE INDEX "membership_transitions_user_id_idx" ON "membership_transitions"("user_id");

-- CreateIndex
CREATE INDEX "role_grants_principal_id_role_idx" ON "role_grants"("principal_id", "role");

-- CreateIndex
CREATE INDEX "restrictions_user_id_type_idx" ON "restrictions"("user_id", "type");

-- CreateIndex
CREATE INDEX "venues_operational_status_idx" ON "venues"("operational_status");

-- CreateIndex
CREATE INDEX "venue_versions_status_idx" ON "venue_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "venue_versions_venue_id_version_no_key" ON "venue_versions"("venue_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "venue_version_contributors_version_id_principal_id_key" ON "venue_version_contributors"("version_id", "principal_id");

-- CreateIndex
CREATE INDEX "venue_verification_samples_version_id_idx" ON "venue_verification_samples"("version_id");

-- CreateIndex
CREATE INDEX "venue_review_events_version_id_idx" ON "venue_review_events"("version_id");

-- CreateIndex
CREATE INDEX "activities_status_start_at_idx" ON "activities"("status", "start_at");

-- CreateIndex
CREATE INDEX "activities_platform_platform_contest_id_idx" ON "activities"("platform", "platform_contest_id");

-- CreateIndex
CREATE UNIQUE INDEX "activity_venue_bindings_activity_id_venue_version_id_key" ON "activity_venue_bindings"("activity_id", "venue_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_activity_id_key" ON "attendance_policies"("activity_id");

-- CreateIndex
CREATE INDEX "activity_registrations_user_id_idx" ON "activity_registrations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "activity_registrations_activity_id_user_id_key" ON "activity_registrations"("activity_id", "user_id");

-- CreateIndex
CREATE INDEX "registration_history_registration_id_idx" ON "registration_history"("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "activity_participants_activity_id_user_id_key" ON "activity_participants"("activity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_activity_id_user_id_key" ON "leave_requests"("activity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_permissions_activity_id_user_id_key" ON "remote_permissions"("activity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_qr_windows_nonce_hash_key" ON "attendance_qr_windows"("nonce_hash");

-- CreateIndex
CREATE INDEX "attendance_qr_windows_activity_id_checkpoint_idx" ON "attendance_qr_windows"("activity_id", "checkpoint");

-- CreateIndex
CREATE INDEX "attendance_challenges_activity_id_user_id_idx" ON "attendance_challenges"("activity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_challenges_nonce_hash_key" ON "attendance_challenges"("nonce_hash");

-- CreateIndex
CREATE INDEX "attendance_attempts_activity_id_checkpoint_idx" ON "attendance_attempts"("activity_id", "checkpoint");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_attempts_user_id_idempotency_key_key" ON "attendance_attempts"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_checkpoints_activity_id_user_id_checkpoint_key" ON "attendance_checkpoints"("activity_id", "user_id", "checkpoint");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_results_activity_id_user_id_key" ON "attendance_results"("activity_id", "user_id");

-- CreateIndex
CREATE INDEX "platform_accounts_platform_external_id_idx" ON "platform_accounts"("platform", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_contests_platform_external_contest_id_key" ON "platform_contests"("platform", "external_contest_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_results_platform_contest_id_platform_account_id_pa_key" ON "platform_results"("platform_contest_id", "platform_account_id", "participation_type");

-- CreateIndex
CREATE INDEX "source_snapshots_platform_fetched_at_idx" ON "source_snapshots"("platform", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_instances_instance_id_key" ON "integration_instances"("instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "hydro_identity_links_instance_id_hydro_uid_key" ON "hydro_identity_links"("instance_id", "hydro_uid");

-- CreateIndex
CREATE UNIQUE INDEX "hydro_event_receipts_event_id_key" ON "hydro_event_receipts"("event_id");

-- CreateIndex
CREATE INDEX "hydro_nonces_expires_at_idx" ON "hydro_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "hydro_nonces_instance_id_key_id_nonce_key" ON "hydro_nonces"("instance_id", "key_id", "nonce");

-- CreateIndex
CREATE INDEX "jobs_status_run_after_priority_idx" ON "jobs"("status", "run_after", "priority");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rule_versions_version_key" ON "rule_versions"("version");

-- CreateIndex
CREATE INDEX "points_ledger_user_id_score_month_idx" ON "points_ledger"("user_id", "score_month");

-- CreateIndex
CREATE INDEX "points_ledger_source_key_idx" ON "points_ledger"("source_key");

-- CreateIndex
CREATE UNIQUE INDEX "points_ledger_idempotency_key_key" ON "points_ledger"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_scores_user_id_score_month_revision_key" ON "monthly_scores"("user_id", "score_month", "revision");

-- CreateIndex
CREATE INDEX "effective_score_snapshots_month_key_revision_idx" ON "effective_score_snapshots"("month_key", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "effective_score_snapshots_user_id_month_key_revision_key" ON "effective_score_snapshots"("user_id", "month_key", "revision");

-- CreateIndex
CREATE INDEX "points_claims_status_idx" ON "points_claims"("status");

-- CreateIndex
CREATE INDEX "review_cases_type_status_idx" ON "review_cases"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_votes_case_id_reviewer_id_key" ON "review_votes"("case_id", "reviewer_id");

-- CreateIndex
CREATE INDEX "appeals_status_idx" ON "appeals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "disclosure_rows_disclosure_id_user_id_key" ON "disclosure_rows"("disclosure_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "frozen_ranking_rows_freeze_id_user_id_key" ON "frozen_ranking_rows"("freeze_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_registrations_contest_key_user_id_key" ON "competition_registrations"("contest_key", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_contest_key_name_key" ON "teams"("contest_key", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "room_bookings_starts_at_ends_at_idx" ON "room_bookings"("starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_featured_badges_user_id_slot_key" ON "profile_featured_badges"("user_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "profile_featured_badges_award_id_key" ON "profile_featured_badges"("award_id");

-- CreateIndex
CREATE INDEX "media_assets_owner_user_id_idx" ON "media_assets"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "badge_definitions_key_key" ON "badge_definitions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "badge_rule_versions_definition_id_version_key" ON "badge_rule_versions"("definition_id", "version");

-- CreateIndex
CREATE INDEX "badge_awards_user_id_status_idx" ON "badge_awards"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "badge_awards_source_key_key" ON "badge_awards"("source_key");

-- CreateIndex
CREATE INDEX "platform_rating_points_platform_account_id_series_type_occu_idx" ON "platform_rating_points"("platform_account_id", "series_type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_rating_points_platform_series_type_platform_accoun_key" ON "platform_rating_points"("platform", "series_type", "platform_account_id", "external_event_id");

-- CreateIndex
CREATE INDEX "site_setting_versions_group_key_status_idx" ON "site_setting_versions"("group", "key", "status");

-- CreateIndex
CREATE INDEX "setting_events_version_id_idx" ON "setting_events"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_references_key_key" ON "secret_references"("key");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_principal_id_created_at_idx" ON "audit_logs"("actor_principal_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_intents" ADD CONSTRAINT "registration_intents_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_terms" ADD CONSTRAINT "membership_terms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_terms" ADD CONSTRAINT "membership_terms_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_versions" ADD CONSTRAINT "venue_versions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_version_contributors" ADD CONSTRAINT "venue_version_contributors_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "venue_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_verification_samples" ADD CONSTRAINT "venue_verification_samples_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "venue_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_review_events" ADD CONSTRAINT "venue_review_events_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "venue_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_venue_bindings" ADD CONSTRAINT "activity_venue_bindings_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_venue_bindings" ADD CONSTRAINT "activity_venue_bindings_venue_version_id_fkey" FOREIGN KEY ("venue_version_id") REFERENCES "venue_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_registrations" ADD CONSTRAINT "activity_registrations_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_registrations" ADD CONSTRAINT "activity_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_history" ADD CONSTRAINT "registration_history_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "activity_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_permissions" ADD CONSTRAINT "remote_permissions_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_qr_windows" ADD CONSTRAINT "attendance_qr_windows_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_qr_windows" ADD CONSTRAINT "attendance_qr_windows_venue_version_id_fkey" FOREIGN KEY ("venue_version_id") REFERENCES "venue_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_challenges" ADD CONSTRAINT "attendance_challenges_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_attempts" ADD CONSTRAINT "attendance_attempts_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_checkpoints" ADD CONSTRAINT "attendance_checkpoints_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_checkpoints" ADD CONSTRAINT "attendance_checkpoints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_checkpoints" ADD CONSTRAINT "attendance_checkpoints_venue_version_id_fkey" FOREIGN KEY ("venue_version_id") REFERENCES "venue_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_results" ADD CONSTRAINT "attendance_results_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_results" ADD CONSTRAINT "attendance_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "attendance_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_results" ADD CONSTRAINT "platform_results_platform_contest_id_fkey" FOREIGN KEY ("platform_contest_id") REFERENCES "platform_contests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_results" ADD CONSTRAINT "platform_results_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hydro_identity_links" ADD CONSTRAINT "hydro_identity_links_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "integration_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hydro_event_receipts" ADD CONSTRAINT "hydro_event_receipts_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "integration_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calculation_batches" ADD CONSTRAINT "calculation_batches_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "points_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_replaced_by_entry_id_fkey" FOREIGN KEY ("replaced_by_entry_id") REFERENCES "points_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_scores" ADD CONSTRAINT "monthly_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "review_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosure_rows" ADD CONSTRAINT "disclosure_rows_disclosure_id_fkey" FOREIGN KEY ("disclosure_id") REFERENCES "disclosures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_freezes" ADD CONSTRAINT "ranking_freezes_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frozen_ranking_rows" ADD CONSTRAINT "frozen_ranking_rows_freeze_id_fkey" FOREIGN KEY ("freeze_id") REFERENCES "ranking_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_featured_badges" ADD CONSTRAINT "profile_featured_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_featured_badges" ADD CONSTRAINT "profile_featured_badges_award_id_fkey" FOREIGN KEY ("award_id") REFERENCES "badge_awards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_awards" ADD CONSTRAINT "badge_awards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_awards" ADD CONSTRAINT "badge_awards_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_rating_points" ADD CONSTRAINT "platform_rating_points_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_rating_points" ADD CONSTRAINT "platform_rating_points_integration_instance_id_fkey" FOREIGN KEY ("integration_instance_id") REFERENCES "integration_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- 以下为方案要求的自定义约束（Prisma schema 无法表达的部分）
-- =====================================================================

-- 九位 ASCII 学号，文本保存保留前导零（03 方案 3.2）
ALTER TABLE "users" ADD CONSTRAINT "users_student_no_format_check" CHECK ("student_no" ~ '^[0-9]{9}$');

-- 平台有效绑定唯一：同一平台同一规范外部账号只允许一个非 revoked 绑定（05 方案 5）
CREATE UNIQUE INDEX "platform_accounts_active_binding_unique"
  ON "platform_accounts"("platform", "external_id")
  WHERE "status" <> 'revoked';

-- 队列 dedupe_key 仅对未完成任务唯一（02 方案 7）
CREATE UNIQUE INDEX "jobs_dedupe_key_active_unique"
  ON "jobs"("dedupe_key")
  WHERE "status" IN ('queued', 'running');

-- 同一积分来源只允许一条当前有效（approved）入账；冲正后状态变化方可写入替代记录（02 方案 5.4）
CREATE UNIQUE INDEX "points_ledger_source_key_active_unique"
  ON "points_ledger"("source_key")
  WHERE "status" = 'approved';

-- 徽标授予逻辑来源键幂等（08 方案 4.2；表内已有全局 UNIQUE，此索引为显性文档化）
CREATE UNIQUE INDEX "badge_awards_source_key_unique" ON "badge_awards"("source_key");
