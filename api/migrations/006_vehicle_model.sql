ALTER TABLE vehicles ADD COLUMN model_key text CHECK(model_key IN ('ioniq5'));
ALTER TABLE pickups ADD COLUMN vehicle_model_key text CHECK(vehicle_model_key IN ('ioniq5'));
