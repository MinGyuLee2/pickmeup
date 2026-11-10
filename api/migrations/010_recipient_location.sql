-- Latest opt-in sample only. End/expiry clears the sample and its write lease.
ALTER TABLE pickups ADD COLUMN recipient_location jsonb;
ALTER TABLE pickups ADD COLUMN recipient_location_id uuid;
ALTER TABLE pickups ADD COLUMN recipient_location_lease_hash text;
ALTER TABLE pickups ADD COLUMN recipient_location_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE pickups ADD COLUMN recipient_location_paused boolean NOT NULL DEFAULT false;
