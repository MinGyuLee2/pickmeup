-- A recipient-chosen waiting spot is independent of the short-lived GPS sample.
ALTER TABLE pickups ADD COLUMN waiting_point jsonb;
ALTER TABLE pickups ADD COLUMN waiting_point_revision bigint NOT NULL DEFAULT 0;
