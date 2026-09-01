CREATE TABLE "answer_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_run_id" uuid NOT NULL,
	"citation_key" text NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_revision_id" uuid NOT NULL,
	"claim_index" integer DEFAULT 0 NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_citations_query_citation_key_unique" UNIQUE("query_run_id","citation_key"),
	CONSTRAINT "answer_citations_claim_index_non_negative" CHECK ("answer_citations"."claim_index" >= 0),
	CONSTRAINT "answer_citations_excerpt_nonempty" CHECK (length(trim("answer_citations"."excerpt")) > 0)
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"topic_id" uuid,
	"subject_key" text NOT NULL,
	"metric_type" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"value" integer NOT NULL,
	"unit" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_item_id" uuid,
	"query_signature" text,
	"is_incomplete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "metric_obs_natural_key_unique" UNIQUE("source_id","subject_key","metric_type","window_start","window_end","raw_item_id"),
	CONSTRAINT "metric_obs_metric_type_valid" CHECK ("metric_observations"."metric_type" IN (
        'community_mentions',
        'issue_discussion',
        'repo_attention',
        'source_diversity',
        'release_activity',
        'paper_activity',
        'model_activity',
        'package_downloads'
      )),
	CONSTRAINT "metric_obs_window_ordered" CHECK ("metric_observations"."window_end" >= "metric_observations"."window_start")
);
--> statement-breakpoint
CREATE TABLE "query_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"question_hash" text NOT NULL,
	"parsed_query" jsonb NOT NULL,
	"retrieval_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_version" text NOT NULL,
	"model_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "query_runs_question_hash_sha256" CHECK ("query_runs"."question_hash" ~ '^[0-9a-fA-F]{64}$'),
	CONSTRAINT "query_runs_status_valid" CHECK ("query_runs"."status" IN ('pending', 'running', 'completed', 'failed', 'insufficient_evidence'))
);
--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_query_run_id_query_runs_id_fk" FOREIGN KEY ("query_run_id") REFERENCES "public"."query_runs"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "answer_citations_chunk_id_idx" ON "answer_citations" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "answer_citations_doc_revision_id_idx" ON "answer_citations" USING btree ("document_revision_id");--> statement-breakpoint
CREATE INDEX "metric_obs_subject_metric_window_idx" ON "metric_observations" USING btree ("subject_key","metric_type","window_start");--> statement-breakpoint
CREATE INDEX "query_runs_request_id_idx" ON "query_runs" USING btree ("request_id");