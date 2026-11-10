ALTER TABLE pickups
  ADD COLUMN share_renew_count smallint NOT NULL DEFAULT 0 CHECK (share_renew_count BETWEEN 0 AND 2),
  ADD COLUMN share_renewed_at timestamptz,
  ADD COLUMN share_renew_key uuid;
