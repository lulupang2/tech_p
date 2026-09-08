CREATE TABLE "collection_page_attempts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"partition_id" uuid NOT NULL,
	"page_sequence" integer NOT NULL,
	"lease_epoch" integer NOT NULL,
	CONSTRAINT "collection_page_attempt_epoch_unique" UNIQUE("partition_id","lease_epoch"),
	CONSTRAINT "collection_page_attempt_counters_valid" CHECK ("collection_page_attempts"."page_sequence" >= 0 AND "collection_page_attempts"."lease_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "collection_page_attempts" ADD CONSTRAINT "collection_page_attempts_run_id_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collection_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_page_attempts" ADD CONSTRAINT "collection_page_attempts_partition_id_collection_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."collection_partitions"("id") ON DELETE restrict ON UPDATE no action;