-- Existing pickups keep their original send authorization; new pickups wait for confirmation.
ALTER TABLE pickups ADD COLUMN sms_confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE pickups ALTER COLUMN sms_confirmed SET DEFAULT false;
