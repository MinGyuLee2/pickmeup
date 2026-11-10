-- Remember explicit waiting-location consent for this pickup, including after pin removal.
ALTER TABLE pickups ADD COLUMN waiting_point_consent_version text;
UPDATE pickups SET waiting_point_consent_version='2026-11-09-manual'
WHERE waiting_point->>'consentVersion'='2026-11-09-manual';
