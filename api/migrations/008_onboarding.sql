CREATE TABLE onboarding (
  pairing_id uuid PRIMARY KEY REFERENCES pairings(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES login_challenges(id),
  session_hash text, driver_id uuid REFERENCES drivers(id), completed_at timestamptz
);
