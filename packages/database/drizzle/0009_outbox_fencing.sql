ALTER TABLE "delivery_outbox" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD COLUMN "lease_until" timestamp with time zone;