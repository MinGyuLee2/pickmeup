-- Preserve local/SENS isolation while adding a personal-account SMS provider.
ALTER TABLE drivers DROP CONSTRAINT drivers_auth_mode_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_auth_mode_check CHECK(auth_mode IN ('local','sens','solapi'));
ALTER TABLE login_challenges DROP CONSTRAINT login_challenges_auth_mode_check;
ALTER TABLE login_challenges ADD CONSTRAINT login_challenges_auth_mode_check CHECK(auth_mode IN ('local','sens','solapi'));
ALTER TABLE pairings DROP CONSTRAINT pairings_auth_mode_check;
ALTER TABLE pairings ADD CONSTRAINT pairings_auth_mode_check CHECK(auth_mode IN ('local','sens','solapi'));
ALTER TABLE message_jobs DROP CONSTRAINT message_jobs_provider_check;
ALTER TABLE message_jobs ADD CONSTRAINT message_jobs_provider_check CHECK(provider IN ('local','sens','solapi'));
