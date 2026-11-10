-- One explicitly opted-in browser per pickup/endpoint; raw endpoints and keys are encrypted.
CREATE TABLE pickup_push_subscriptions (
  id uuid PRIMARY KEY, pickup_id uuid NOT NULL REFERENCES pickups(id), endpoint_hash text NOT NULL,
  protected_subscription text, state text NOT NULL DEFAULT 'WAITING'
    CHECK(state IN ('WAITING','CLAIMED','SENT','FAILED','UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid, lease_expires_at timestamptz, sent_at timestamptz, revoked_at timestamptz,
  last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(pickup_id,endpoint_hash)
);
CREATE INDEX pickup_push_ready ON pickup_push_subscriptions(available_at) WHERE state='WAITING' AND revoked_at IS NULL;
