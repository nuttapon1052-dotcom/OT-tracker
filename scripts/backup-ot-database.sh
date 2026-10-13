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
  # pg_dump stderr can contain endpoint, account and query details. GitHub logs
  # must only receive fixed diagnostic messages; never print the raw error.
  if grep -Eiq 'password authentication failed|no password supplied|SASL.*(failed|error)' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_AUTH: Database authentication failed. Check the stored password and URL-encoding of special characters." >&2
  elif grep -Eiq 'Tenant or user not found|role .* does not exist|database .* does not exist|invalid user' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_IDENTITY: Pooler username, project reference or database name was rejected. Re-copy the Session pooler URI." >&2
  elif grep -Eiq 'invalid URI|invalid connection option|invalid percent-encoded|missing .* in connection info string' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_URI: Database connection URI is malformed. Check punctuation and percent-encoding without sharing the URI." >&2
  elif grep -Eiq 'permission denied|must be owner|must be superuser|row-level security policy' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_PERMISSIONS: The database user cannot read one or more required OT/auth tables." >&2
  elif grep -Eiq 'server version:|aborting because of server version mismatch|unsupported version' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_PG_VERSION: pg_dump client version is incompatible with the database server." >&2
  elif grep -Eiq 'relation .* does not exist|no matching tables were found|schema .* does not exist' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_SCHEMA: A required table or schema is missing. Check the configured backup table list." >&2
  elif grep -Eiq 'could not translate host name|Name or service not known|Temporary failure in name resolution|nodename nor servname provided' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_DNS: Pooler host name could not be resolved. Re-copy the Session pooler host." >&2
  elif grep -Eiq 'no pg_hba.conf entry|SSL error|certificate verify failed|does not support SSL|server does not support SSL' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_TLS: Database rejected the TLS/connection policy. Verify Session pooler URI and sslmode." >&2
  elif grep -Eiq 'connection refused|timeout expired|Connection timed out|Network is unreachable|No route to host|server closed the connection unexpectedly|could not receive data from server|SSL SYSCALL error' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_NETWORK: Database connection could not be established or was interrupted. Check network, pooler availability and port 5432." >&2
  elif grep -Eiq 'statement timeout|canceling statement due to|too many connections|remaining connection slots' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_CAPACITY: Database was busy or a query timed out. Retry later or review the project limits." >&2
  else
    echo "OT_BACKUP_UNKNOWN: pg_dump failed with an unclassified error. Raw error details were withheld to protect database secrets." >&2
  fi
  echo "Database snapshot failed; no backup was published." >&2
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
