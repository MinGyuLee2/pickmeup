-- A cancellation can arrive before the original start request. Serialize both
-- against the vehicle row and retain a non-location tombstone for that key.
CREATE TABLE cancelled_pickup_starts (
  vehicle_id uuid NOT NULL REFERENCES vehicles(id), idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(vehicle_id,idempotency_key)
);
