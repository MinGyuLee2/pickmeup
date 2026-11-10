CREATE TABLE drivers (
  id uuid PRIMARY KEY, phone text NOT NULL UNIQUE, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_challenges (
  id uuid PRIMARY KEY, phone text NOT NULL, code_hash text NOT NULL, ip_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX login_challenges_phone ON login_challenges(phone, created_at DESC);
CREATE INDEX login_challenges_ip ON login_challenges(ip_hash, created_at DESC);
CREATE TABLE web_sessions (
  token_hash text PRIMARY KEY, driver_id uuid NOT NULL REFERENCES drivers(id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vehicles (
  id uuid PRIMARY KEY, driver_id uuid NOT NULL REFERENCES drivers(id),
  token_hash text NOT NULL UNIQUE, name text NOT NULL DEFAULT '내 차량',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pairings (
  id uuid PRIMARY KEY, device_secret_hash text NOT NULL, claim_token_hash text NOT NULL UNIQUE,
  ip_hash text NOT NULL, vehicle_id uuid REFERENCES vehicles(id), encrypted_device_token text,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE contacts (
  id uuid PRIMARY KEY, driver_id uuid NOT NULL REFERENCES drivers(id),
  name text NOT NULL, phone text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE contact_aliases (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  alias text NOT NULL, PRIMARY KEY(contact_id, alias)
);
CREATE TABLE pickups (
  id uuid PRIMARY KEY, driver_id uuid NOT NULL REFERENCES drivers(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id), contact_id uuid NOT NULL REFERENCES contacts(id),
  recipient_name text NOT NULL, destination jsonb NOT NULL,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','ARRIVED','ENDED','EXPIRED')),
  readiness text NOT NULL DEFAULT 'UNKNOWN' CHECK(readiness IN ('UNKNOWN','PREPARING','OUTSIDE')),
  latest_observation jsonb, sequence bigint NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(), arrived_at timestamptz, near_notified_at timestamptz,
  expires_at timestamptz NOT NULL, ended_at timestamptz, end_reason text,
  UNIQUE(vehicle_id, idempotency_key)
);
CREATE UNIQUE INDEX pickups_one_active_per_vehicle ON pickups(vehicle_id) WHERE state IN ('ACTIVE','ARRIVED');
CREATE TABLE share_grants (
  token_hash text PRIMARY KEY, pickup_id uuid NOT NULL REFERENCES pickups(id), expires_at timestamptz NOT NULL
);
CREATE TABLE recipient_sessions (
  token_hash text PRIMARY KEY, pickup_id uuid NOT NULL REFERENCES pickups(id), expires_at timestamptz NOT NULL
);
CREATE TABLE message_jobs (
  id uuid PRIMARY KEY, pickup_id uuid REFERENCES pickups(id), challenge_id uuid REFERENCES login_challenges(id),
  kind text NOT NULL CHECK(kind IN ('OTP','START','NEAR')),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','DELIVERED','FAILED','UNKNOWN','SIMULATED','CANCELLED')),
  protected_payload text, provider_id text, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pickup_id, kind)
);
