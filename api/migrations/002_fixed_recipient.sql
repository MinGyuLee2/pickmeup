-- A contact edit must not redirect an already active pickup to a different phone.
ALTER TABLE pickups ADD COLUMN recipient_phone_ciphertext text;
