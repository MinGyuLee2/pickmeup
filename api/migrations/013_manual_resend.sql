ALTER TABLE onboarding
  ADD COLUMN resend_count smallint NOT NULL DEFAULT 0 CHECK(resend_count BETWEEN 0 AND 1),
  ADD COLUMN claim_ciphertext text,
  ADD COLUMN message_ciphertext text;
ALTER TABLE pickups ADD COLUMN message_resend_count smallint NOT NULL DEFAULT 0 CHECK(message_resend_count BETWEEN 0 AND 1);
ALTER TABLE message_jobs DROP CONSTRAINT message_jobs_kind_check;
ALTER TABLE message_jobs ADD CONSTRAINT message_jobs_kind_check CHECK(kind IN ('OTP','START','NEAR','RESEND'));
