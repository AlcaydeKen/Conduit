-- IF NOT EXISTS added by hand. This project applies schema with drizzle-kit push
-- (see CLAUDE.md), so ai_jobs_one_open_per_card_kind_idx was already in the
-- database before it was ever captured in a migration file. Without the guard
-- this file cannot be replayed on the very database it was generated from.
ALTER TABLE "cards" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_jobs_one_open_per_card_kind_idx" ON "ai_jobs" USING btree ("card_id","kind") WHERE status in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cards_live_idx" ON "cards" USING btree ("workspace_id","column_id","position","id") WHERE archived_at is null;