#!/usr/bin/env bash
# Run on a trusted Linux host with PostgreSQL 17 client and GnuPG. Never enable shell tracing.
set -euo pipefail
umask 077
: "${OT_BACKUP_DATABASE_URL:?Set OT_BACKUP_DATABASE_URL in GitHub Secrets}"
: "${OT_BACKUP_ENCRYPTION_KEY:?Set OT_BACKUP_ENCRYPTION_KEY in GitHub Secrets}"
if (( ${#OT_BACKUP_ENCRYPTION_KEY} < 32 )); then
  echo "Backup encryption key must contain at least 32 characters." >&2
  exit 1
fi
output_dir="${1:?Specify an encrypted backup output directory}"
backup_temp="$(mktemp -d)"
trap 'rm -rf -- "$backup_temp"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Normalize clipboard padding and enable TLS by default without logging the URI.
python3 "$script_dir/prepare_backup_url.py" "$backup_temp/connection-uri"
export PGDATABASE="$(< "$backup_temp/connection-uri")"
export PGCONNECT_TIMEOUT=30
export PGOPTIONS="-c statement_timeout=300000 -c lock_timeout=15000"
# Run the PostgreSQL 17 client directly (the workflow installs it from PGDG).
# Keep the full connection URI out of printed logs; no shell tracing is permitted.
PG_DUMP_BIN="${PG_DUMP_BIN:-/usr/lib/postgresql/17/bin/pg_dump}"
if [[ ! -x "$PG_DUMP_BIN" ]]; then
  echo "OT_BACKUP_CLIENT: PostgreSQL 17 pg_dump executable is missing or not executable." >&2
  exit 1
fi
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
# One transaction-consistent snapshot. Auth identities retain the Google-to-user-ID mapping.
# Only data for these tables is included; schema/configuration are separate.
if ! "$PG_DUMP_BIN" --dbname="$PGDATABASE" --format=custom --data-only --no-owner --no-privileges \
  --table=public.ot_entries --table=public.ot_settings --table=public.work_notes \
  --table=public.push_subscriptions --table=auth.users --table=auth.identities \
  > "$backup_temp/ot.dump" 2> "$backup_temp/database-errors"; then
  # pg_dump stderr can contain endpoint, account and query details. GitHub logs
  # must only receive fixed diagnostic messages; never print the raw error.
  if grep -Eiq 'password authentication failed|no password supplied|SASL.*(failed|error)' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_AUTH: Database authentication failed. Check the stored password and URL-encoding of special characters." >&2
  elif grep -Eiq 'Tenant or user not found|role .* does not exist|database .* does not exist|invalid user' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_IDENTITY: Pooler username, project reference or database name was rejected. Re-copy the Session pooler URI." >&2
  elif grep -Eiq 'invalid URI|invalid connection option|invalid percent-encoded|invalid URI query parameter|invalid port number|could not parse|missing .* in connection info string' "$backup_temp/database-errors"; then
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
  elif grep -Eiq 'connection to server|connection to database|connection failed|could not connect|FATAL:|connection exception|unexpected EOF on client connection' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_CONNECT_OTHER: Database connection failed for a reason not yet categorized. Check the Session pooler URI without sharing credentials." >&2
  elif grep -Eiq 'pg_dump: error: query failed|pg_dump: error: query was|SQL statement failed|pg_dump: error: could not execute query' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_QUERY_OTHER: Connection reached the database but a required dump query failed. Check table access and database compatibility." >&2
  elif grep -Eiq 'pg_dump: error:|pg_dump: fatal:' "$backup_temp/database-errors"; then
    echo "OT_BACKUP_PGDUMP_OTHER: PostgreSQL dump failed; classification withheld raw details for security." >&2
  else
    echo "OT_BACKUP_OTHER: Backup command failed before a recognizable PostgreSQL error. Raw diagnostics were withheld to protect secrets." >&2
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
