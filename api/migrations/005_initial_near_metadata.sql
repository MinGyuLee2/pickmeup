-- Explicit preparation metadata is needed even when no separate NEAR job exists.
ALTER TABLE message_jobs ADD COLUMN includes_near boolean NOT NULL DEFAULT false;
