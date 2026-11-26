ALTER TABLE "points_ledger"
    ADD COLUMN "bonus_visible" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "points_ledger_visible_bonus_idx"
    ON "points_ledger" ("recorded_at" DESC, "id" DESC)
    WHERE "bonus_visible" AND "status" = 'approved' AND "amount" > 0 AND "category" <> 'reversal';
