#!/usr/bin/env python3
"""
Unit tests for db-health-check.py

All subprocess and filesystem calls are mocked — no live DB or real files required.

Run:
    python3 -m unittest scripts.test_db_health_check -v
    # or from scripts/:
    python3 -m unittest test_db_health_check -v
"""

import json
import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

# ---------------------------------------------------------------------------
# Import target (works whether run from repo root or scripts/)
# ---------------------------------------------------------------------------
import importlib, os

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))
import db_health_check as dhc  # type: ignore


def _make_proc(returncode: int = 0, stdout: str = "") -> MagicMock:
    p = MagicMock()
    p.returncode = returncode
    p.stdout = stdout
    return p


class TestGetDbStats(unittest.TestCase):
    """Tests for get_db_stats()."""

    @patch("db_health_check.subprocess.run")
    @patch("db_health_check._WORKSPACE", new_callable=lambda: type("P", (), {"__truediv__": lambda s, o: Path("/no/contact-graph.json")})())
    def test_all_queries_succeed(self, _ws, mock_run):
        # Return sensible values for each query in order
        mock_run.side_effect = [
            _make_proc(0, "100\n"),            # total_records
            _make_proc(0, "contacts|50\n"),    # by_category
            _make_proc(0, "3\n"),              # recent_24h
            _make_proc(0, "My Title|2026-01-01"),  # last_record
            _make_proc(0, "1\n"),              # connected
            _make_proc(0, "0\n"),              # id_gaps
            _make_proc(0, "1|9999\n"),         # id_range
        ]
        with patch("db_health_check._WORKSPACE", Path("/tmp")):
            with patch.object(Path, "exists", return_value=False):
                stats = dhc.get_db_stats()

        self.assertEqual(stats["total_records"], 100)
        self.assertEqual(stats["contacts"], 50)
        self.assertEqual(stats["recent_24h"], 3)
        self.assertTrue(stats["connected"])

    @patch("db_health_check.subprocess.run")
    def test_failed_queries_default_to_zero(self, mock_run):
        mock_run.return_value = _make_proc(1, "")
        with patch.object(Path, "exists", return_value=False):
            stats = dhc.get_db_stats()
        self.assertEqual(stats["total_records"], 0)
        self.assertEqual(stats["contacts"], 0)
        self.assertEqual(stats["recent_24h"], 0)
        self.assertFalse(stats["connected"])

    @patch("db_health_check.subprocess.run")
    def test_contact_graph_loaded_when_present(self, mock_run):
        mock_run.return_value = _make_proc(1, "")
        graph_data = json.dumps({"contacts": [{"name": "Alice"}, {"name": "Bob"}]})
        with patch.object(Path, "exists", return_value=True):
            with patch("builtins.open", mock_open(read_data=graph_data)):
                stats = dhc.get_db_stats()
        self.assertEqual(stats["contact_graph_contacts"], 2)

    @patch("db_health_check.subprocess.run")
    def test_contact_graph_zero_when_missing(self, mock_run):
        mock_run.return_value = _make_proc(1, "")
        with patch.object(Path, "exists", return_value=False):
            stats = dhc.get_db_stats()
        self.assertEqual(stats["contact_graph_contacts"], 0)


class TestCreateBaseline(unittest.TestCase):
    """Tests for create_baseline()."""

    @patch("db_health_check.get_db_stats")
    def test_writes_baseline_file(self, mock_stats):
        mock_stats.return_value = {
            "total_records": 42,
            "contacts": 5,
            "contact_graph_contacts": 3,
            "id_gaps": 0,
            "timestamp": "2026-01-01T00:00:00",
        }
        m = mock_open()
        with patch("builtins.open", m):
            result = dhc.create_baseline()
        self.assertTrue(result)
        written = "".join(c.args[0] for c in m().write.call_args_list)
        data = json.loads(written)
        self.assertEqual(data["total_records"], 42)

    @patch("db_health_check.get_db_stats")
    def test_returns_true_on_success(self, mock_stats):
        mock_stats.return_value = {
            "total_records": 0, "contacts": 0,
            "contact_graph_contacts": 0, "id_gaps": 0,
            "timestamp": "2026-01-01",
        }
        with patch("builtins.open", mock_open()):
            self.assertTrue(dhc.create_baseline())


class TestCheckHealth(unittest.TestCase):
    """Tests for check_health()."""

    def _baseline(self, total=100, contacts=10, graph=5) -> dict:
        return {
            "total_records": total,
            "contacts": contacts,
            "contact_graph_contacts": graph,
            "recent_24h": 2,
            "timestamp": "2026-01-01T00:00:00",
        }

    def _current(self, total=100, contacts=10, graph=5, recent=2, connected=True) -> dict:
        return {
            "total_records": total,
            "contacts": contacts,
            "contact_graph_contacts": graph,
            "recent_24h": recent,
            "connected": connected,
            "timestamp": "2026-01-02T00:00:00",
        }

    @patch("db_health_check.BASELINE_FILE")
    def test_returns_false_when_no_baseline(self, mock_bf):
        mock_bf.exists.return_value = False
        result = dhc.check_health()
        self.assertFalse(result)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_passes_when_healthy(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline()))):
            mock_stats.return_value = self._current()
            result = dhc.check_health()
        self.assertTrue(result)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_fails_on_record_loss(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline(total=100)))):
            mock_stats.return_value = self._current(total=80)
            result = dhc.check_health()
        self.assertFalse(result)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_fails_when_not_connected(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline()))):
            mock_stats.return_value = self._current(connected=False)
            result = dhc.check_health()
        self.assertFalse(result)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_passes_with_24h_warning_only(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        with patch("builtins.open", mock_open(read_data=json.dumps(self._baseline()))):
            mock_stats.return_value = self._current(recent=0)
            result = dhc.check_health()
        # 24h inactivity is a warning, not a failure
        self.assertTrue(result)


class TestMain(unittest.TestCase):
    """Tests for main() dispatch."""

    def _run_main(self, args: list[str]) -> int:
        with patch.object(sys, "argv", ["db-health-check.py"] + args):
            try:
                dhc.main()
                return 0
            except SystemExit as e:
                return e.code if isinstance(e.code, int) else 0

    @patch("db_health_check.create_baseline", return_value=True)
    def test_baseline_dispatches(self, mock_cb):
        self._run_main(["--baseline"])
        mock_cb.assert_called_once()

    @patch("db_health_check.check_health", return_value=True)
    def test_check_exits_0_on_success(self, _):
        code = self._run_main(["--check"])
        self.assertEqual(code, 0)

    @patch("db_health_check.check_health", return_value=False)
    def test_check_exits_1_on_failure(self, _):
        code = self._run_main(["--check"])
        self.assertEqual(code, 1)

    def test_unknown_command_exits_1(self):
        code = self._run_main(["--unknown"])
        self.assertEqual(code, 1)

    @patch("db_health_check.BASELINE_FILE")
    def test_cron_exits_1_when_no_baseline(self, mock_bf):
        mock_bf.exists.return_value = False
        code = self._run_main(["--cron"])
        self.assertEqual(code, 1)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_cron_exits_0_when_healthy(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        baseline = {"total_records": 100, "contacts": 10, "timestamp": "2026-01-01"}
        with patch("builtins.open", mock_open(read_data=json.dumps(baseline))):
            mock_stats.return_value = {
                "total_records": 100, "contacts": 10,
                "connected": True, "timestamp": "2026-01-02",
            }
            code = self._run_main(["--cron"])
        self.assertEqual(code, 0)

    @patch("db_health_check.get_db_stats")
    @patch("db_health_check.BASELINE_FILE")
    def test_cron_exits_1_on_record_loss(self, mock_bf, mock_stats):
        mock_bf.exists.return_value = True
        baseline = {"total_records": 100, "contacts": 10, "timestamp": "2026-01-01"}
        with patch("builtins.open", mock_open(read_data=json.dumps(baseline))):
            mock_stats.return_value = {
                "total_records": 80, "contacts": 10,
                "connected": True, "timestamp": "2026-01-02",
            }
            code = self._run_main(["--cron"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
