CREATE TABLE "duplicate_cluster_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"raw_item_id" uuid,
	"algorithm_version" text NOT NULL,
	"confidence" integer NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duplicate_cluster_memberships_identity_unique" UNIQUE("cluster_id","document_id","revision_id","algorithm_version"),
	CONSTRAINT "duplicate_cluster_memberships_confidence_range" CHECK ("duplicate_cluster_memberships"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "duplicate_cluster_memberships_status_valid" CHECK ("duplicate_cluster_memberships"."status" IN ('suggested', 'accepted', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "duplicate_cluster_memberships" ADD CONSTRAINT "duplicate_cluster_memberships_cluster_id_duplicate_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."duplicate_clusters"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "duplicate_cluster_memberships" ADD CONSTRAINT "duplicate_cluster_memberships_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "duplicate_cluster_memberships" ADD CONSTRAINT "duplicate_cluster_memberships_revision_id_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "duplicate_cluster_memberships" ADD CONSTRAINT "duplicate_cluster_memberships_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "duplicate_cluster_memberships_document_idx" ON "duplicate_cluster_memberships" USING btree ("document_id","created_at");