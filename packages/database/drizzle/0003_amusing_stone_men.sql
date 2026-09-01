CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"chunker_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_revision_ordinal_version_unique" UNIQUE("document_revision_id","ordinal","chunker_version"),
	CONSTRAINT "chunks_ordinal_non_negative" CHECK ("chunks"."ordinal" >= 0),
	CONSTRAINT "chunks_token_count_positive" CHECK ("chunks"."token_count" > 0),
	CONSTRAINT "chunks_content_hash_sha256" CHECK ("chunks"."content_hash" ~ '^[0-9a-fA-F]{64}$')
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"raw_item_id" uuid,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"author" text,
	"language" text DEFAULT 'ko' NOT NULL,
	"published_at" timestamp with time zone,
	"license_id" text,
	"normalized_hash" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"searchable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_revisions_doc_hash_unique" UNIQUE("document_id","normalized_hash"),
	CONSTRAINT "document_revisions_title_nonempty" CHECK (length(trim("document_revisions"."title")) > 0),
	CONSTRAINT "document_revisions_normalized_hash_sha256" CHECK ("document_revisions"."normalized_hash" ~ '^[0-9a-fA-F]{64}$'),
	CONSTRAINT "document_revisions_status_valid" CHECK ("document_revisions"."status" IN ('pending', 'processing', 'searchable', 'quarantined', 'tombstoned'))
);
--> statement-breakpoint
CREATE TABLE "document_topics" (
	"document_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"method" text DEFAULT 'deterministic' NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"classifier_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_topics_unique" UNIQUE("document_id","topic_id","classifier_version"),
	CONSTRAINT "document_topics_confidence_range" CHECK ("document_topics"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_type" text DEFAULT 'article' NOT NULL,
	"canonical_url" text,
	"duplicate_cluster_id" uuid,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_artifact_type_valid" CHECK ("documents"."artifact_type" IN ('article', 'release_note', 'forum_post', 'qa_post', 'paper')),
	CONSTRAINT "documents_canonical_url_http" CHECK ("documents"."canonical_url" IS NULL OR "documents"."canonical_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "duplicate_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"representative_document_id" uuid,
	"algorithm_version" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duplicate_clusters_confidence_range" CHECK ("duplicate_clusters"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_chunk_provider_model_hash_unique" UNIQUE("chunk_id","provider","model","input_hash"),
	CONSTRAINT "embeddings_dimensions_positive" CHECK ("embeddings"."dimensions" > 0),
	CONSTRAINT "embeddings_input_hash_sha256" CHECK ("embeddings"."input_hash" ~ '^[0-9a-fA-F]{64}$')
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" text PRIMARY KEY NOT NULL,
	"spdx_id" text,
	"name" text NOT NULL,
	"url" text,
	"requires_attribution" boolean DEFAULT true NOT NULL,
	"is_share_alike" boolean DEFAULT false NOT NULL,
	"allows_commercial" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_id_slug" CHECK ("licenses"."id" ~ '^[a-z0-9.-]+$')
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"parent_id" uuid,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"taxonomy_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_slug_taxonomy_unique" UNIQUE("slug","taxonomy_version"),
	CONSTRAINT "topics_slug_format" CHECK ("topics"."slug" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_duplicate_cluster_id_duplicate_clusters_id_fk" FOREIGN KEY ("duplicate_cluster_id") REFERENCES "public"."duplicate_clusters"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "document_revisions_status_published_idx" ON "document_revisions" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "document_topics_topic_doc_idx" ON "document_topics" USING btree ("topic_id","document_id");--> statement-breakpoint
CREATE INDEX "documents_duplicate_cluster_idx" ON "documents" USING btree ("duplicate_cluster_id");