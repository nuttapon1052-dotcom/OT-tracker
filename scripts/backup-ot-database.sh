#!/usr/bin/env bash
# Run on a trusted Linux host with Docker and GnuPG. Never enable shell tracing.
set -euo pipefail
umask 077
: "${OT_BACKUP_DATABASE_URL:?Set OT_BACKUP_DATABASE_URL in GitHub Secrets}"
: "${OT_BACKUP_ENCRYPTION_KEY:?Set OT_BACKUP_ENCRYPTION_KEY in GitHub Secrets}"
if (( ${#OT_BACKUP_ENCRYPTION_KEY} < 32 )); then
  echo "Backup encryption key must contain at least 32 characters." >&2
  exit 1
fi
case "$OT_BACKUP_DATABASE_URL" in
  *sslmode=require*|*sslmode=verify-ca*|*sslmode=verify-full*) ;;
  *)
    if [[ "${OT_BACKUP_ALLOW_LOCAL_TEST:-}" != true ]] ||
       [[ ! "$OT_BACKUP_DATABASE_URL" =~ @127\.0\.0\.1:[0-9]+/ ]]; then
      echo "Use a database connection string with sslmode=require." >&2
      exit 1
    fi ;;
esac
output_dir="${1:?Specify an encrypted backup output directory}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
backup_temp="$(mktemp -d)"
trap 'rm -rf -- "$backup_temp"' EXIT
export PGDATABASE="$OT_BACKUP_DATABASE_URL"
export PGCONNECT_TIMEOUT=30
export PGOPTIONS="-c statement_timeout=300000 -c lock_timeout=15000"
# One transaction-consistent snapshot. Auth identities retain the Google-to-user-ID mapping.
# Only data for these tables is included; schema/configuration are separate.
if ! docker run --rm --network host --env PGDATABASE --env PGCONNECT_TIMEOUT --env PGOPTIONS \
  postgres:17 sh -c 'exec pg_dump --dbname="$PGDATABASE" "$@"' ot-backup --format=custom --data-only --no-owner --no-privileges \
  --table=public.ot_entries --table=public.ot_settings --table=public.work_notes \
  --table=public.push_subscriptions --table=auth.users --table=auth.identities \
  > "$backup_temp/ot.dump" 2> "$backup_temp/database-errors"; then
  if [[ "${OT_BACKUP_ALLOW_LOCAL_TEST:-}" == true ]] &&
     [[ "$OT_BACKUP_DATABASE_URL" =~ @127\.0\.0\.1:[0-9]+/ ]]; then
    cat "$backup_temp/database-errors" >&2
  fi
  echo "Database snapshot failed. Check the pooler URL, password, network and PostgreSQL version; no backup was published." >&2
  exit 1
fi
test -s "$backup_temp/ot.dump"
backup_name="ot-data-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
# Passphrase goes through stdin, never an argument or log. Plaintext stays in the temporary directory.
printf '%s' "$OT_BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --homedir "$backup_temp" --symmetric --cipher-algo AES256 \
  --output "$backup_temp/$backup_name" "$backup_temp/ot.dump" 2> "$backup_temp/encryption-errors"
# Verify encryption can be reversed before publishing the ciphertext.
printf '%s' "$OT_BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --homedir "$backup_temp" --decrypt \
  --output "$backup_temp/verified.dump" "$backup_temp/$backup_name" 2> "$backup_temp/encryption-errors"
cmp --silent "$backup_temp/ot.dump" "$backup_temp/verified.dump"
install -m 600 "$backup_temp/$backup_name" "$output_dir/$backup_name"
(cd "$output_dir" && sha256sum "$backup_name" > "$backup_name.sha256")
echo "Encrypted OT/account snapshot created and verified."
