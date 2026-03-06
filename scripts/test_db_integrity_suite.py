#!/usr/bin/env python3
"""
Unit tests for db-integrity-suite.py

All subprocess and filesystem calls are mocked — no live DB or real files required.

Run:
    python3 -m unittest scripts.test_db_integrity_suite -v
    # or from scripts/:
    python3 -m unittest test_db_integrity_suite -v
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, mock_open, patch

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))
import db_integrity_suite as dis  # type: ignore


def _make_proc(returncode: int = 0, stdout: str = "", stderr: str = "") -> MagicMock:
    p = MagicMock()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


class TestRunSql(unittest.TestCase):
    """Tests for DBIntegritySuite.run_sql()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()

    @patch("db_integrity_suite.subprocess.run")
    def test_returns_stripped_stdout_on_success(self, mock_run):
        mock_run.return_value = _make_proc(0, "  on  \n")
        result = self.suite.run_sql("SHOW data_checksums;")
        self.assertEqual(result, "on")

    @patch("db_integrity_suite.subprocess.run")
    def test_returns_none_on_failure(self, mock_run):
        mock_run.return_value = _make_proc(1, "")
        result = self.suite.run_sql("SELECT 1")
        self.assertIsNone(result)


class TestChecksumsEnabled(unittest.TestCase):
    """Tests for test_checksums_enabled()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()

    def test_pass_when_on(self):
        with patch.object(self.suite, "run_sql", return_value="on"):
            result = self.suite.test_checksums_enabled()
        self.assertTrue(result)
        self.assertEqual(self.suite.results["passed"], 1)
        self.assertEqual(self.suite.results["failed"], 0)

    def test_warning_when_off(self):
        with patch.object(self.suite, "run_sql", return_value="off"):
            result = self.suite.test_checksums_enabled()
        self.assertFalse(result)
        self.assertEqual(self.suite.results["passed"], 0)
        self.assertEqual(len(self.suite.results["warnings"]), 1)

    def test_fail_when_query_fails(self):
        with patch.object(self.suite, "run_sql", return_value=None):
            result = self.suite.test_checksums_enabled()
        self.assertFalse(result)
        self.assertEqual(self.suite.results["failed"], 1)
        self.assertIn("Cannot query data_checksums", self.suite.results["issues"])


class TestPgAmcheck(unittest.TestCase):
    """Tests for test_pg_amcheck()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()

    @patch("db_integrity_suite.subprocess.run")
    def test_skip_when_not_installed(self, mock_run):
        mock_run.return_value = _make_proc(1)  # 'which pg_amcheck' fails
        result = self.suite.test_pg_amcheck()
        self.assertIsNone(result)
        self.assertEqual(self.suite.results["tests"]["amcheck"]["status"], "SKIP")

    @patch("db_integrity_suite.subprocess.run")
    def test_warning_when_extension_missing(self, mock_run):
        # which pg_amcheck succeeds, but extension count = 0
        mock_run.return_value = _make_proc(0, "0\n")
        with patch.object(self.suite, "run_sql", return_value="0"):
            result = self.suite.test_pg_amcheck()
        self.assertIsNone(result)

    @patch("db_integrity_suite.subprocess.run")
    def test_pass_when_clean(self, mock_run):
        # which succeeds, amcheck run succeeds
        mock_run.side_effect = [
            _make_proc(0),          # which pg_amcheck
            _make_proc(0, "ok\n"),  # pg_amcheck --verbose
        ]
        with patch.object(self.suite, "run_sql", return_value="1"):
            result = self.suite.test_pg_amcheck()
        self.assertTrue(result)
        self.assertEqual(self.suite.results["passed"], 1)

    @patch("db_integrity_suite.subprocess.run")
    def test_fail_on_corruption(self, mock_run):
        mock_run.side_effect = [
            _make_proc(0),                         # which pg_amcheck
            _make_proc(1, "", "corruption found"),  # pg_amcheck fails
        ]
        with patch.object(self.suite, "run_sql", return_value="1"):
            result = self.suite.test_pg_amcheck()
        self.assertFalse(result)
        self.assertEqual(self.suite.results["failed"], 1)

    @patch("db_integrity_suite.subprocess.run")
    def test_warning_on_no_relations(self, mock_run):
        mock_run.side_effect = [
            _make_proc(0),
            _make_proc(1, "", "no relations to check"),
        ]
        with patch.object(self.suite, "run_sql", return_value="1"):
            result = self.suite.test_pg_amcheck()
        self.assertIsNone(result)
        self.assertIn("pg_amcheck found no relations to check", self.suite.results["warnings"])


class TestBaselineComparison(unittest.TestCase):
    """Tests for test_baseline_comparison()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()

    def _baseline(self, total=100, contacts=10, graph=5):
        return {
            "total_records": total,
            "contacts": contacts,
            "contact_graph_contacts": graph,
            "timestamp": "2026-01-01T00:00:00",
        }

    def _current(self, total=100, contacts=10, graph=5, recent=2):
        return {
            "total_records": total,
            "contacts": contacts,
            "contact_graph_contacts": graph,
            "recent_24h": recent,
            "connected": True,
            "timestamp": "2026-01-02T00:00:00",
        }

    @patch("db_integrity_suite.BASELINE_FILE")
    def test_warning_when_no_baseline(self, mock_bf):
        mock_bf.exists.return_value = False
        result = self.suite.test_baseline_comparison()
        self.assertIsNone(result)
        self.assertIn("No baseline file", self.suite.results["warnings"][0])

    @patch("db_integrity_suite.get_db_stats")
    @patch("db_integrity_suite.BASELINE_FILE")
    def test_passes_when_healthy(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline()))):
            mock_stats.return_value = self._current()
            result = self.suite.test_baseline_comparison()
        self.assertTrue(result)

    @patch("db_integrity_suite.get_db_stats")
    @patch("db_integrity_suite.BASELINE_FILE")
    def test_fails_on_record_loss(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline(total=100)))):
            mock_stats.return_value = self._current(total=50)
            result = self.suite.test_baseline_comparison()
        self.assertFalse(result)
        self.assertTrue(any("Lost 50 records" in i for i in self.suite.results["issues"]))

    @patch("db_integrity_suite.get_db_stats")
    @patch("db_integrity_suite.BASELINE_FILE")
    def test_fails_on_contact_loss(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline(contacts=10)))):
            mock_stats.return_value = self._current(contacts=5)
            result = self.suite.test_baseline_comparison()
        self.assertFalse(result)

    @patch("db_integrity_suite.get_db_stats")
    @patch("db_integrity_suite.BASELINE_FILE")
    def test_warning_on_no_recent_activity(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline()))):
            mock_stats.return_value = self._current(recent=0)
            result = self.suite.test_baseline_comparison()
        self.assertTrue(result)
        self.assertIn("No records created in last 24h", self.suite.results["warnings"])


class TestSendAlert(unittest.TestCase):
    """Tests for _send_alert()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()
        self.suite.results["failed"] = 2
        self.suite.results["issues"] = ["Issue A", "Issue B"]

    @patch("db_integrity_suite.subprocess.run")
    def test_calls_openclaw_system_event(self, mock_run):
        mock_run.return_value = _make_proc(0)
        self.suite._send_alert()
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], "openclaw")
        self.assertIn("system", args)
        self.assertIn("event", args)
        self.assertIn("FAILED", mock_run.call_args[0][0][4])

    @patch("db_integrity_suite.subprocess.run")
    def test_does_not_raise_if_openclaw_missing(self, mock_run):
        mock_run.side_effect = FileNotFoundError("openclaw not found")
        # Should not propagate
        try:
            self.suite._send_alert()
        except FileNotFoundError:
            self.fail("_send_alert() raised FileNotFoundError")


class TestRunAll(unittest.TestCase):
    """Tests for run_all()."""

    def setUp(self):
        self.suite = dis.DBIntegritySuite()

    @patch("db_integrity_suite.REPORT_FILE")
    def test_exits_0_on_all_pass(self, mock_rf):
        mock_rf.__str__ = lambda s: "/tmp/report.json"
        with patch.object(self.suite, "test_checksums_enabled", return_value=True), \
             patch.object(self.suite, "test_pg_amcheck", return_value=True), \
             patch.object(self.suite, "test_baseline_comparison", return_value=True), \
             patch("builtins.open", mock_open()):
            with self.assertRaises(SystemExit) as cm:
                self.suite.run_all()
        self.assertEqual(cm.exception.code, 0)

    @patch("db_integrity_suite.REPORT_FILE")
    def test_exits_1_on_failure(self, mock_rf):
        mock_rf.__str__ = lambda s: "/tmp/report.json"
        self.suite.results["failed"] = 1
        with patch.object(self.suite, "test_checksums_enabled", return_value=False), \
             patch.object(self.suite, "test_pg_amcheck", return_value=None), \
             patch.object(self.suite, "test_baseline_comparison", return_value=None), \
             patch.object(self.suite, "_send_alert"), \
             patch("builtins.open", mock_open()):
            with self.assertRaises(SystemExit) as cm:
                self.suite.run_all()
        self.assertEqual(cm.exception.code, 1)

    @patch("db_integrity_suite.REPORT_FILE")
    def test_saves_report_file(self, mock_rf):
        mock_rf.__str__ = lambda s: "/tmp/report.json"
        m = mock_open()
        with patch.object(self.suite, "test_checksums_enabled", return_value=True), \
             patch.object(self.suite, "test_pg_amcheck", return_value=True), \
             patch.object(self.suite, "test_baseline_comparison", return_value=True), \
             patch("builtins.open", m):
            try:
                self.suite.run_all()
            except SystemExit:
                pass
        m.assert_called()


class TestMain(unittest.TestCase):
    """Tests for main() dispatch."""

    def _run_main(self, args: list[str]) -> int:
        with patch.object(sys, "argv", ["db-integrity-suite.py"] + args):
            try:
                dis.main()
                return 0
            except SystemExit as e:
                return e.code if isinstance(e.code, int) else 0

    def test_no_args_exits_1(self):
        code = self._run_main([])
        self.assertEqual(code, 1)

    def test_unknown_command_exits_1(self):
        code = self._run_main(["--unknown"])
        self.assertEqual(code, 1)

    def test_checksums_dispatches(self):
        suite_mock = MagicMock()
        with patch("db_integrity_suite.DBIntegritySuite", return_value=suite_mock):
            self._run_main(["--checksums"])
        suite_mock.test_checksums_enabled.assert_called_once()

    def test_amcheck_dispatches(self):
        suite_mock = MagicMock()
        with patch("db_integrity_suite.DBIntegritySuite", return_value=suite_mock):
            self._run_main(["--amcheck"])
        suite_mock.test_pg_amcheck.assert_called_once()

    @patch("db_integrity_suite.REPORT_FILE")
    def test_report_prints_when_exists(self, mock_rf):
        mock_rf.exists.return_value = True
        report = {"passed": 3, "failed": 0}
        with patch("builtins.open", mock_open(read_data=json.dumps(report))):
            self._run_main(["--report"])  # should not raise

    @patch("db_integrity_suite.REPORT_FILE")
    def test_report_message_when_missing(self, mock_rf):
        mock_rf.exists.return_value = False
        # Should print "No report found" without raising
        self._run_main(["--report"])


if __name__ == "__main__":
    unittest.main()
