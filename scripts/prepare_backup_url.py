#!/usr/bin/env python3
"""Validate a secret backup URI and write it to a private file, never stdout."""
import os
import re
import sys
from urllib.parse import urlsplit, parse_qs


class BackupURLValidationError(ValueError):
    pass


def prepare_backup_url(value, allow_local_test=False):
    # Clipboard whitespace outside the URI is harmless; whitespace inside a
    # password/URI must be encoded by its owner, never silently removed.
    value = value.strip()
    if any(c.isspace() for c in value):
        raise BackupURLValidationError("WHITESPACE")
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        raise BackupURLValidationError("PERCENT_ENCODING")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("postgresql", "postgres") or not parsed.hostname:
            raise BackupURLValidationError("SCHEME_HOST")
        if parsed.fragment:
            raise BackupURLValidationError("FRAGMENT")
        if not parsed.username or not parsed.password or "[YOUR-PASSWORD]" in parsed.password:
            raise BackupURLValidationError("USER_PASSWORD")
        local_fixture = allow_local_test and parsed.hostname == "127.0.0.1"
        if parsed.port != 5432 and not (local_fixture and parsed.port and 1 <= parsed.port <= 65535):
            raise BackupURLValidationError("PORT")
        if parsed.path != "/postgres":
            raise BackupURLValidationError("DATABASE")
        query = parse_qs(parsed.query, keep_blank_values=True)
        if not local_fixture:
            if "sslmode" not in query:
                # Keep the original escaped credentials and other query values.
                parsed = parsed._replace(query=(parsed.query + "&" if parsed.query else "") + "sslmode=require")
            elif query["sslmode"] not in (["require"], ["verify-ca"], ["verify-full"]):
                raise BackupURLValidationError("SSL_QUERY")
        return parsed.geturl()
    except BackupURLValidationError:
        raise
    except (ValueError, TypeError):
        raise BackupURLValidationError("URI_FORMAT") from None


def main():
    try:
        normalized = prepare_backup_url(
            os.environ.get("OT_BACKUP_DATABASE_URL", ""),
            os.environ.get("OT_BACKUP_ALLOW_LOCAL_TEST") == "true",
        )
    except BackupURLValidationError as error:
        print("OT_BACKUP_PREFLIGHT_" + str(error) + ": Fix the stored Database URL secret; no credentials were logged.", file=sys.stderr)
        return 1
    os.umask(0o077)
    with open(sys.argv[1], "w", encoding="utf-8") as output:
        output.write(normalized)
    return 0


if __name__ == "__main__":
    sys.exit(main())
