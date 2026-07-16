-- Seed the built-in and starter categories that ship with the MVP (spec 001).
-- Runs once, tracked by the Drizzle migration journal, so re-running db:migrate
-- is a no-op. All categories are user-editable afterward; new ones need no
-- migration. `created_at` is epoch-ms (timestamp_ms), `is_income_source` is 0/1.
--
-- System built-ins (locked in the API): Transfer is excluded from every
-- income/expense aggregate; Income is the seeded income source. "Personal loans"
-- (flagged as an anticipated addition in spec 001) is intentionally NOT seeded —
-- it is not part of the approved starter set and can be added from Settings.
INSERT INTO `categories` (`name`, `system_key`, `is_income_source`, `sort_order`, `created_at`) VALUES
  ('Groceries',           NULL,       0, 10,  (unixepoch() * 1000)),
  ('Restaurants & Cafés', NULL,       0, 20,  (unixepoch() * 1000)),
  ('Transport',           NULL,       0, 30,  (unixepoch() * 1000)),
  ('Housing',             NULL,       0, 40,  (unixepoch() * 1000)),
  ('Utilities',           NULL,       0, 50,  (unixepoch() * 1000)),
  ('Health',              NULL,       0, 60,  (unixepoch() * 1000)),
  ('Subscriptions',       NULL,       0, 70,  (unixepoch() * 1000)),
  ('Shopping',            NULL,       0, 80,  (unixepoch() * 1000)),
  ('Entertainment',       NULL,       0, 90,  (unixepoch() * 1000)),
  ('Travel',              NULL,       0, 100, (unixepoch() * 1000)),
  ('Fees & Interest',     NULL,       0, 110, (unixepoch() * 1000)),
  ('Cash',                NULL,       0, 120, (unixepoch() * 1000)),
  ('Other',               NULL,       0, 130, (unixepoch() * 1000)),
  ('Income',              'income',   1, 140, (unixepoch() * 1000)),
  ('Transfer',            'transfer', 0, 150, (unixepoch() * 1000));