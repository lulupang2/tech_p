ALTER TABLE "raw_items" DROP CONSTRAINT "raw_items_run_id_collection_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_source_id_unique" UNIQUE("source_id","id");
--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_source_run_consistency_fk" FOREIGN KEY ("source_id","run_id") REFERENCES "public"."collection_runs"("source_id","id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_immutable_row_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is immutable; % is not permitted', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_items_immutable_mutation
BEFORE UPDATE OR DELETE ON "raw_items"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
--> statement-breakpoint
CREATE TRIGGER pipeline_events_append_only
BEFORE UPDATE OR DELETE ON "pipeline_events"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();