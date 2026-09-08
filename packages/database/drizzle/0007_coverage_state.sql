CREATE TABLE "acquisition_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partition_id" uuid NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"revision_id" uuid,
	"run_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisition_partition_raw_unique" UNIQUE("partition_id","raw_item_id")
);
--> statement-breakpoint
CREATE TABLE "collection_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partition_id" uuid NOT NULL,
	"page_sequence" integer NOT NULL,
	"lease_epoch" integer NOT NULL,
	"cursor_before" text,
	"cursor_after" text,
	"disposition" text NOT NULL,
	"retained_items" integer NOT NULL,
	"requests" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_checkpoint_page_unique" UNIQUE("partition_id","page_sequence"),
	CONSTRAINT "collection_checkpoint_disposition_valid" CHECK ("collection_checkpoints"."disposition" IN ('continue','complete','deferred','partial')),
	CONSTRAINT "collection_checkpoint_counts_valid" CHECK ("collection_checkpoints"."retained_items" >= 0 AND "collection_checkpoints"."requests" >= 0 AND "collection_checkpoints"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collection_partitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"mode" text NOT NULL,
	"scope_key" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"time_basis" text NOT NULL,
	"workflow_version" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"page_sequence" integer DEFAULT 0 NOT NULL,
	"cursor" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"run_id" uuid,
	"next_due_at" timestamp with time zone NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_partitions_natural_key_unique" UNIQUE("natural_key"),
	CONSTRAINT "collection_partition_window_valid" CHECK ("collection_partitions"."window_from" < "collection_partitions"."window_to"),
	CONSTRAINT "collection_partition_mode_valid" CHECK ("collection_partitions"."mode" IN ('backfill','incremental','on_demand')),
	CONSTRAINT "collection_partition_basis_valid" CHECK ("collection_partitions"."time_basis" IN ('published_at','updated_at','observed_at')),
	CONSTRAINT "collection_partition_state_valid" CHECK ("collection_partitions"."state" IN ('pending','running','deferred','completed','partial','failed','cancelled')),
	CONSTRAINT "collection_partition_counters_valid" CHECK ("collection_partitions"."page_sequence" >= 0 AND "collection_partitions"."lease_epoch" >= 0 AND "collection_partitions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collection_target_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"config_hash" text NOT NULL,
	"selector" jsonb NOT NULL,
	"capability" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"topic_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cadence_ms" bigint,
	"overlap_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_target_revision_hash_unique" UNIQUE("target_id","config_hash"),
	CONSTRAINT "collection_target_cadence_valid" CHECK ("collection_target_revisions"."cadence_ms" IS NULL OR "collection_target_revisions"."cadence_ms" >= 60000),
	CONSTRAINT "collection_target_overlap_valid" CHECK ("collection_target_revisions"."overlap_ms" BETWEEN 0 AND 86400000)
);
--> statement-breakpoint
CREATE TABLE "collection_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"canonical_identity" text NOT NULL,
	"current_revision_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_targets_identity_unique" UNIQUE("source_id","canonical_identity")
);
--> statement-breakpoint
CREATE TABLE "delivery_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"natural_key" text NOT NULL,
	"kind" text NOT NULL,
	"partition_id" uuid NOT NULL,
	"page_sequence" integer NOT NULL,
	"raw_item_id" uuid,
	"revision_id" uuid,
	"not_before" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_outbox_natural_key_unique" UNIQUE("natural_key"),
	CONSTRAINT "delivery_kind_valid" CHECK ("delivery_outbox"."kind" IN ('collection','normalization','embedding')),
	CONSTRAINT "delivery_subject_valid" CHECK (("delivery_outbox"."kind" = 'collection' AND "delivery_outbox"."raw_item_id" IS NULL AND "delivery_outbox"."revision_id" IS NULL) OR ("delivery_outbox"."kind" = 'normalization' AND "delivery_outbox"."raw_item_id" IS NOT NULL) OR ("delivery_outbox"."kind" = 'embedding' AND "delivery_outbox"."revision_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "discovery_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"canonical_identity" text NOT NULL,
	"selector" jsonb NOT NULL,
	"evidence_url" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target_id" uuid,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_candidate_identity_unique" UNIQUE("source_id","canonical_identity"),
	CONSTRAINT "discovery_candidate_state_valid" CHECK ("discovery_candidates"."state" IN ('pending','accepted','rejected'))
);
--> statement-breakpoint
CREATE TABLE "embedding_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_key" text NOT NULL,
	"chunk_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"profile" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"reservation_id" uuid,
	"embedding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_work_items_work_key_unique" UNIQUE("work_key"),
	CONSTRAINT "embedding_work_state_valid" CHECK ("embedding_work_items"."state" IN ('pending','claimed','calling','completed','outcome_unknown','failed')),
	CONSTRAINT "embedding_work_completed_valid" CHECK ("embedding_work_items"."state" != 'completed' OR "embedding_work_items"."embedding_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "observation_cohort_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"unit" text NOT NULL,
	"query_signature" text NOT NULL,
	"cadence_ms" bigint NOT NULL,
	CONSTRAINT "cohort_member_unique" UNIQUE("cohort_id","target_revision_id","metric","unit"),
	CONSTRAINT "cohort_member_cadence_valid" CHECK ("observation_cohort_members"."cadence_ms" >= 60000)
);
--> statement-breakpoint
CREATE TABLE "observation_cohorts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_cohorts_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "provider_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"lane" text NOT NULL,
	"utc_day" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"units" bigint NOT NULL,
	"tokens" bigint NOT NULL,
	"actual_units" bigint,
	"actual_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_budget_reservations_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "budget_reservation_state_valid" CHECK ("provider_budget_reservations"."state" IN ('reserved','settled','outcome_unknown','released')),
	CONSTRAINT "budget_reservation_usage_valid" CHECK ("provider_budget_reservations"."units" >= 0 AND "provider_budget_reservations"."tokens" >= 0 AND ("provider_budget_reservations"."actual_units" IS NULL OR "provider_budget_reservations"."actual_units" >= 0) AND ("provider_budget_reservations"."actual_tokens" IS NULL OR "provider_budget_reservations"."actual_tokens" >= 0))
);
--> statement-breakpoint
CREATE TABLE "provider_budget_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"currency" text NOT NULL,
	"max_daily_units" bigint NOT NULL,
	"max_outstanding_units" bigint NOT NULL,
	"max_daily_tokens" bigint NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_scope_limits_valid" CHECK ("provider_budget_scopes"."max_daily_units" >= 0 AND "provider_budget_scopes"."max_outstanding_units" >= 0 AND "provider_budget_scopes"."max_daily_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "embeddings" DROP CONSTRAINT "embeddings_chunk_provider_model_hash_unique";--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "lexical_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "profile_hash" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "acquisition_memberships" ADD CONSTRAINT "acquisition_memberships_partition_id_collection_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."collection_partitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_memberships" ADD CONSTRAINT "acquisition_memberships_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_memberships" ADD CONSTRAINT "acquisition_memberships_revision_id_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_memberships" ADD CONSTRAINT "acquisition_memberships_run_id_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collection_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_checkpoints" ADD CONSTRAINT "collection_checkpoints_partition_id_collection_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."collection_partitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_partitions" ADD CONSTRAINT "collection_partitions_target_revision_id_collection_target_revisions_id_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."collection_target_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_partitions" ADD CONSTRAINT "collection_partitions_run_id_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collection_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_target_revisions" ADD CONSTRAINT "collection_target_revisions_target_id_collection_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."collection_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_targets" ADD CONSTRAINT "collection_targets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_partition_id_collection_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."collection_partitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_revision_id_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_target_id_collection_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."collection_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_work_items" ADD CONSTRAINT "embedding_work_items_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_work_items" ADD CONSTRAINT "embedding_work_items_reservation_id_provider_budget_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."provider_budget_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_work_items" ADD CONSTRAINT "embedding_work_items_embedding_id_embeddings_id_fk" FOREIGN KEY ("embedding_id") REFERENCES "public"."embeddings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_cohort_members" ADD CONSTRAINT "observation_cohort_members_cohort_id_observation_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."observation_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_cohort_members" ADD CONSTRAINT "observation_cohort_members_target_revision_id_collection_target_revisions_id_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."collection_target_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_budget_reservations" ADD CONSTRAINT "provider_budget_reservations_scope_id_provider_budget_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."provider_budget_scopes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquisition_revision_idx" ON "acquisition_memberships" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "collection_partition_due_idx" ON "collection_partitions" USING btree ("state","next_due_at");--> statement-breakpoint
CREATE INDEX "delivery_pending_idx" ON "delivery_outbox" USING btree ("completed_at","not_before","sent_at");--> statement-breakpoint
CREATE INDEX "embedding_work_state_lease_idx" ON "embedding_work_items" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "budget_reservation_scope_day_idx" ON "provider_budget_reservations" USING btree ("scope_id","utc_day","state");--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_profile_hash_unique" UNIQUE("chunk_id","provider","model","profile_hash","input_hash");