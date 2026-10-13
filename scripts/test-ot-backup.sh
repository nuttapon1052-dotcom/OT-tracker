#!/usr/bin/env bash
# Isolated fixture only: no production connection or secrets.
set -euo pipefail
umask 077
test_temp="$(mktemp -d)"
test_container="ot-backup-test-${GITHUB_RUN_ID:-local}-${RANDOM}"
trap 'docker rm -f "$test_container" >/dev/null 2>&1 || true; rm -rf -- "$test_temp"' EXIT
docker run --detach --rm --name "$test_container" --publish 127.0.0.1:54329:5432 \
  --env POSTGRES_PASSWORD=ot_fixture_password postgres:17 >/dev/null
for attempt in {1..30}; do
  if docker exec "$test_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$test_container" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider text, provider_id text);
CREATE TABLE public.ot_settings (user_id uuid PRIMARY KEY REFERENCES auth.users(id), hourly_rate numeric);
CREATE TABLE public.ot_entries (id integer PRIMARY KEY, user_id uuid REFERENCES auth.users(id), note text, deleted boolean);
CREATE TABLE public.work_notes (id integer PRIMARY KEY, user_id uuid REFERENCES auth.users(id), content text);
CREATE TABLE public.push_subscriptions (id integer PRIMARY KEY, user_id uuid REFERENCES auth.users(id), endpoint text);
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111', 'fixture@example.invalid');
INSERT INTO auth.identities VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'google', 'fixture-google-account');
INSERT INTO public.ot_settings VALUES ('11111111-1111-4111-8111-111111111111', 250);
INSERT INTO public.ot_entries SELECT n, '11111111-1111-4111-8111-111111111111', 'historical OT ' || n, n = 1000 FROM generate_series(1,1000) n;
INSERT INTO public.work_notes VALUES (1, '11111111-1111-4111-8111-111111111111', 'fixture reminder');
INSERT INTO public.push_subscriptions VALUES (1, '11111111-1111-4111-8111-111111111111', 'https://example.invalid/push');
CREATE DATABASE restored;
SQL
docker exec "$test_container" pg_dump -U postgres --schema-only --no-owner --no-privileges > "$test_temp/schema.sql"
docker exec -i "$test_container" psql -U postgres -d restored -v ON_ERROR_STOP=1 < "$test_temp/schema.sql" >/dev/null
export OT_BACKUP_DATABASE_URL="postgresql://postgres:ot_fixture_password@127.0.0.1:54329/postgres"
export OT_BACKUP_ENCRYPTION_KEY="fixture-only-key-32-characters-not-for-production"
export OT_BACKUP_ALLOW_LOCAL_TEST=true
bash scripts/backup-ot-database.sh "$test_temp/output"
test "$(find "$test_temp/output" -type f | wc -l)" -eq 2
encrypted_file="$(find "$test_temp/output" -name '*.dump.gpg')"
(cd "$test_temp/output" && sha256sum --check ./*.sha256)
printf '%s' "$OT_BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --homedir "$test_temp" --decrypt --output "$test_temp/restored.dump" "$encrypted_file" 2>/dev/null
docker exec -i "$test_container" pg_restore -U postgres -d restored --data-only --disable-triggers --exit-on-error < "$test_temp/restored.dump"
docker exec -i "$test_container" psql -U postgres -d restored -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
BEGIN
  IF (SELECT count(*) FROM public.ot_entries) <> 1000 THEN RAISE EXCEPTION 'history lost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ot_entries WHERE id=1000 AND deleted) THEN RAISE EXCEPTION 'tombstone lost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.identities i JOIN public.ot_entries e ON e.user_id=i.user_id WHERE i.provider='google' AND i.provider_id='fixture-google-account') THEN RAISE EXCEPTION 'Google account mapping lost'; END IF;
  IF (SELECT hourly_rate FROM public.ot_settings) <> 250 THEN RAISE EXCEPTION 'settings lost'; END IF;
  IF (SELECT content FROM public.work_notes) <> 'fixture reminder' THEN RAISE EXCEPTION 'notes lost'; END IF;
  IF (SELECT count(*) FROM public.push_subscriptions) <> 1 THEN RAISE EXCEPTION 'subscriptions lost'; END IF;
END $$;
SQL
# Missing/unsafe configuration must fail without publishing any file.
if OT_BACKUP_ENCRYPTION_KEY=short bash scripts/backup-ot-database.sh "$test_temp/rejected" >/dev/null 2>&1; then
  echo "Invalid encryption key accepted" >&2; exit 1
fi
if OT_BACKUP_ALLOW_LOCAL_TEST=false bash scripts/backup-ot-database.sh "$test_temp/rejected" >/dev/null 2>&1; then
  echo "Insecure production connection accepted" >&2; exit 1
fi
test ! -e "$test_temp/rejected"
echo "PASS: encrypted snapshot restored 1,000 OT rows, tombstones, settings, notes and Google account mapping."
