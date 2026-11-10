ALTER TABLE drivers ADD COLUMN auth_mode text NOT NULL DEFAULT 'local' CHECK(auth_mode IN ('local','sens'));
ALTER TABLE drivers DROP CONSTRAINT drivers_phone_key;
ALTER TABLE drivers ADD UNIQUE(phone,auth_mode);
ALTER TABLE login_challenges ADD COLUMN auth_mode text NOT NULL DEFAULT 'local' CHECK(auth_mode IN ('local','sens'));
ALTER TABLE pairings ADD COLUMN auth_mode text NOT NULL DEFAULT 'local' CHECK(auth_mode IN ('local','sens'));
ALTER TABLE pickups ADD COLUMN recipient_link_ciphertext text;
ALTER TABLE message_jobs
  ADD COLUMN provider text NOT NULL DEFAULT 'local' CHECK(provider IN ('local','sens')),
  ADD COLUMN provider_message_id text,
  ADD COLUMN dispatch_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_until timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  ADD COLUMN delivered_at timestamptz;
CREATE INDEX message_jobs_ready ON message_jobs(provider,available_at) WHERE status='PENDING';
CREATE INDEX message_jobs_reconcile ON message_jobs(provider,next_check_at) WHERE status IN ('ACCEPTED','UNKNOWN');
CREATE UNIQUE INDEX message_jobs_provider_request ON message_jobs(provider,provider_id) WHERE provider_id IS NOT NULL;
