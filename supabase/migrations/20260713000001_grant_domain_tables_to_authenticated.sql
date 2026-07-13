-- Grant table-level privileges on the domain tables to the `authenticated` role.
--
-- The original create_domain_tables migration enabled RLS with per-user policies
-- and REVOKED the anon role, but never GRANTed privileges to `authenticated` —
-- it relied on Supabase's default privileges, which are not present on this
-- project. Postgres checks table privileges BEFORE RLS, so authenticated users
-- hit "permission denied for table garmin_credentials" on every read/write and
-- the row-level policies never even ran.
--
-- RLS still restricts WHICH rows each user can access; these grants only open the
-- table at the privilege layer. anon stays revoked.

grant select, insert, update, delete on table race_goals         to authenticated;
grant select, insert, update, delete on table garmin_credentials to authenticated;
grant select, insert, update, delete on table workout_selections to authenticated;
