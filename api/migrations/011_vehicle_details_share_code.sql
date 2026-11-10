ALTER TABLE vehicles ADD COLUMN model_name text, ADD COLUMN license_plate text;
ALTER TABLE pickups ADD COLUMN vehicle_model_name text, ADD COLUMN vehicle_plate text,
  ADD COLUMN recipient_code_hash text, ADD COLUMN recipient_code_ciphertext text;
ALTER TABLE share_grants ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0;
