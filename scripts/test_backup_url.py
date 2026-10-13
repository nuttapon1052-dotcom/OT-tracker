#!/usr/bin/env python3
import contextlib
import io
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from prepare_backup_url import prepare_backup_url, BackupURLValidationError, main

URI = "postgresql://postgres.fixture:fixture%40pw%20test@pooler.example.invalid:5432/postgres"

class BackupURLTests(unittest.TestCase):
    def test_clipboard_whitespace_and_missing_tls_default(self):
        self.assertEqual(prepare_backup_url(" \n" + URI + "\r\n "), URI + "?sslmode=require")

    def test_query_values_and_escaped_password_are_preserved(self):
        self.assertEqual(prepare_backup_url(URI + "?connect_timeout=10"),
                         URI + "?connect_timeout=10&sslmode=require")

    def test_explicit_strict_tls_is_preserved(self):
        for mode in ("require", "verify-ca", "verify-full"):
            value = URI + "?sslmode=" + mode
            self.assertEqual(prepare_backup_url(value), value)

    def test_internal_spaces_are_not_removed_from_credentials(self):
        with self.assertRaisesRegex(BackupURLValidationError, "^WHITESPACE$"):
            prepare_backup_url(URI.replace("fixture%40pw", "fixture pw"))

    def test_unencrypted_or_duplicate_tls_settings_are_rejected(self):
        for suffix in ("?sslmode=disable", "?sslmode=", "?sslmode=require&sslmode=disable"):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(BackupURLValidationError, "^SSL_QUERY$"):
                prepare_backup_url(URI + suffix)

    def test_transaction_pooler_is_rejected(self):
        with self.assertRaisesRegex(BackupURLValidationError, "^PORT$"):
            prepare_backup_url(URI.replace(":5432/", ":6543/"))

    def test_bad_percent_encoding_and_fragments_are_rejected(self):
        for value in (URI.replace("%40", "%xx"), URI + "#unescaped-password-part"):
            with self.subTest(value=value), self.assertRaises(BackupURLValidationError):
                prepare_backup_url(value)

    def test_local_fixture_exemption_cannot_apply_to_remote_host(self):
        local = "postgresql://postgres:fixture@127.0.0.1:54329/postgres"
        self.assertEqual(prepare_backup_url(local, True), local)
        with self.assertRaisesRegex(BackupURLValidationError, "^PORT$"):
            prepare_backup_url(local, False)
        with self.assertRaisesRegex(BackupURLValidationError, "^SSL_QUERY$"):
            prepare_backup_url(URI + "?sslmode=disable", True)

    def test_cli_writes_private_file_and_never_prints_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "uri"
            logs = io.StringIO()
            with patch.dict(os.environ, {"OT_BACKUP_DATABASE_URL": URI, "OT_BACKUP_ALLOW_LOCAL_TEST": ""}), \
                 patch("sys.argv", ["prepare_backup_url.py", str(output)]), \
                 contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
                self.assertEqual(main(), 0)
            self.assertEqual(logs.getvalue(), "")
            self.assertEqual(output.read_text(), URI + "?sslmode=require")
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

if __name__ == "__main__":
    unittest.main()
