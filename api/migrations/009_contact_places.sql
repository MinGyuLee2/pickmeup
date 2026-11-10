-- Optional default meeting place. Existing accounts, contacts and vehicle tokens stay intact.
CREATE TABLE contact_places (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  destination jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
