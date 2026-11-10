-- New guests have an isolated owner, never a fabricated or unverified phone account.
-- Existing phone accounts and vehicle tokens are unchanged.
ALTER TABLE drivers ADD COLUMN is_guest boolean NOT NULL DEFAULT false;
ALTER TABLE drivers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE drivers ADD CONSTRAINT drivers_guest_identity
  CHECK ((is_guest AND phone IS NULL) OR (NOT is_guest AND phone IS NOT NULL));
CREATE TABLE guest_installations (
  secret_hash text NOT NULL, auth_mode text NOT NULL CHECK(auth_mode IN ('local','sens','solapi')),
  vehicle_id uuid NOT NULL UNIQUE REFERENCES vehicles(id), encrypted_device_token text NOT NULL,
  ip_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(secret_hash,auth_mode)
);
CREATE INDEX guest_installations_ip ON guest_installations(ip_hash,created_at);
ALTER TABLE onboarding ADD COLUMN target_vehicle_id uuid REFERENCES vehicles(id);
