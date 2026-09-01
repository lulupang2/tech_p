CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor_before" text,
	"cursor_after" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_runs_status_valid" CHECK ("collection_runs"."status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "collection_runs_times_ordered" CHECK ("collection_runs"."ended_at" IS NULL OR "collection_runs"."started_at" IS NULL OR "collection_runs"."ended_at" >= "collection_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"processor_version" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_events_stage_nonempty" CHECK (length(trim("pipeline_events"."stage")) > 0),
	CONSTRAINT "pipeline_events_attempt_positive" CHECK ("pipeline_events"."attempt" > 0),
	CONSTRAINT "pipeline_events_status_valid" CHECK ("pipeline_events"."status" IN ('started', 'succeeded', 'failed', 'skipped', 'quarantined'))
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rights_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "raw_items_revision_identity_unique" UNIQUE("source_id","external_id","payload_hash"),
	CONSTRAINT "raw_items_external_id_nonempty" CHECK (length(trim("raw_items"."external_id")) > 0),
	CONSTRAINT "raw_items_canonical_url_http" CHECK ("raw_items"."canonical_url" ~ '^https?://'),
	CONSTRAINT "raw_items_payload_hash_sha256" CHECK ("raw_items"."payload_hash" ~ '^[0-9a-fA-F]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_config" jsonb NOT NULL,
	"policy_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_key_unique" UNIQUE("key"),
	CONSTRAINT "sources_key_nonempty" CHECK (length(trim("sources"."key")) > 0),
	CONSTRAINT "sources_base_url_http" CHECK ("sources"."base_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_run_id_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collection_runs"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "collection_runs_source_scheduled_idx" ON "collection_runs" USING btree ("source_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "pipeline_events_raw_item_occurred_idx" ON "pipeline_events" USING btree ("raw_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "raw_items_source_external_idx" ON "raw_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "raw_items_payload_hash_idx" ON "raw_items" USING btree ("payload_hash");