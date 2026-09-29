"""Regression checks for launcher parsing and backup validation; isolated data only."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_fitai import server


class BackupValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fitai-review-")
        self.old_db = server.DB_PATH
        server.DB_PATH = str(Path(self.tmp.name) / "test.db")
        server.init_db()
        with server.db() as c:
            c.execute("INSERT INTO weights(date, weight) VALUES (?, ?)",
                      (server.date.today().isoformat(), 70.2))

    def tearDown(self):
        server.DB_PATH = self.old_db
        self.tmp.cleanup()

    def test_invalid_backup_never_erases_records(self):
        good = server.build_export()
        variants = [{}, {"unrelated": True}]
        for key, value in (("meals", {}), ("weights", None), ("day_flags", "bad"),
                           ("app", "Other"), ("schema_version", 1.5),
                           ("energy_unit", None)):
            variants.append(dict(good, **{key: value}))
        bad_weight = copy.deepcopy(good)
        bad_weight["weights"][0]["weight"] = -1
        variants.append(bad_weight)
        bad_profile = copy.deepcopy(good)
        bad_profile["profile"]["height"] = float("nan")
        variants.append(bad_profile)
        for payload in variants:
            with self.subTest(payload=payload):
                with self.assertRaises(server.ApiError):
                    server.apply_import(payload)
                after = server.build_export()
                self.assertEqual(after["weights"], good["weights"])
                self.assertEqual(after["profile"], good["profile"])

    def test_backup_roundtrip_to_a_new_database(self):
        source = server.build_export()
        server.DB_PATH = str(Path(self.tmp.name) / "restored.db")
        server.init_db()
        server.apply_import(source)
        restored = server.build_export()
        for key in ("meals", "exercises", "weights", "day_flags", "energy_unit", "display_unit"):
            self.assertEqual(restored[key], source[key])

    def test_exercise_invalid_energy_is_not_silently_estimated(self):
        for value in (-100, float("nan"), float("inf"), "bad"):
            with self.subTest(value=value), self.assertRaises(server.ApiError):
                server.validate_ex_items([{"type": "walk", "minutes": 30, "energy_kj": value}], 70)
        result = server.validate_ex_items([{"type": "walk", "minutes": 30}], 70)
        self.assertGreater(result[0]["energy_kj"], 0)


@unittest.skipUnless(os.name == "nt", "Windows batch launcher")
class LauncherTests(unittest.TestCase):
    def test_crlf_and_cmd_launch_from_unicode_space_directory(self):
        root = Path(__file__).resolve().parents[1]
        script = next(root.glob("*.bat")).read_bytes()
        self.assertFalse(script.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\n", script.replace(b"\r\n", b""))
        with tempfile.TemporaryDirectory(prefix="fitai-launch-") as tmp:
            folder = Path(tmp) / "中文 space"
            folder.mkdir()
            bat = folder / "启动 渐渐飞.bat"
            bat.write_bytes(script)
            (folder / "server.py").write_text(
                "import sys\nprint('LAUNCH_OK', sys.argv[1:])\nsys.exit(7)\n", encoding="utf-8")
            result = subprocess.run(["cmd.exe", "/d", "/c", str(bat), "--no-browser"],
                                    input=b"", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    timeout=20, cwd=tmp)
            output = result.stdout.decode("utf-8", errors="replace")
            self.assertIn("LAUNCH_OK ['--no-browser']", output)
            self.assertEqual(result.returncode, 7, output)
            self.assertNotIn("is not recognized", output)


TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class PhotoMacroOpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fitai-feat-")
        self.old_db = server.DB_PATH
        server.DB_PATH = str(Path(self.tmp.name) / "test.db")
        server.init_db()

    def tearDown(self):
        server.DB_PATH = self.old_db
        self.tmp.cleanup()

    def test_op_id_rollback_allows_retry(self):
        try:
            with server.db() as c:
                self.assertEqual(server.claim_op(c, "op-fail", "meal", "aaa"), "new")
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        with server.db() as c:
            self.assertEqual(server.claim_op(c, "op-fail", "meal", "aaa"), "new")

    def test_op_id_rejects_different_payload(self):
        with server.db() as c:
            self.assertEqual(server.claim_op(c, "op-x", "meal", "digest-a"), "new")
        with self.assertRaises(server.ApiError):
            with server.db() as c:
                server.claim_op(c, "op-x", "meal", "digest-b")
        with server.db() as c:
            self.assertEqual(server.claim_op(c, "op-x", "meal", "digest-a"), "replay")

    def test_macro_targets_and_weekly_estimate(self):
        d = server.date.today().isoformat()
        server.save_profile({
            "gender": "female", "age": 30, "height": 165, "activity": 1.2,
            "target_weight": 55, "weekly_loss": 0.5, "completed": True,
        })
        with server.db() as c:
            c.execute("INSERT INTO weights(date, weight) VALUES (?, ?)", (d, 70))
            server.insert_meal_row(c, d, "早餐", {
                "name": "粥", "amount": "1碗", "kcal": 800, "energy_kj": 800,
                "protein": 5, "carb": 40, "fat": 1, "grams": 250, "item_source": "manual",
                "from_label": False, "note": "", "energy_mode": "scaled",
            }, "", "manual", "now")
        s = server.day_summary(d)
        self.assertEqual(s["meal_status"], "logged")
        self.assertIsNone(s["predict_delta"])
        self.assertIsNotNone(s["logged_weekly_kg"])
        mt = s["macro_targets"]
        self.assertAlmostEqual(mt["protein_g"], 70 * 1.6, places=1)
        self.assertGreater(mt["fat_g"], 0)
        self.assertGreater(mt["carb_g"], 0)
        self.assertIn("蛋白质", mt["note"])
        with server.db() as c:
            c.execute("INSERT OR REPLACE INTO day_flags(date, meals_complete, updated_at) VALUES (?,?,?)",
                      (d, 1, "now"))
        done = server.day_summary(d)
        self.assertEqual(done["meal_status"], "logged")
        self.assertIsNone(done["predict_delta"])
        self.assertEqual(done["intake"], s["intake"])
        self.assertEqual(server.history(1, end_date=d)[0]["meal_status"], "logged")
        ctx = server.agent_context(d, done, server.history(1, end_date=d), "分析记录")
        self.assertEqual(ctx["趋势统计"]["有记录日平均已记录摄入_kJ"], done["intake"])
        self.assertNotIn("确认完整天数", ctx["趋势统计"])

    def test_meal_photo_is_kept_and_exported(self):
        d = server.date.today().isoformat()
        fname, mime = server.write_photo_file(TINY_PNG)
        now = "now"
        with server.db() as c:
            pid = server.insert_photo_row(c, d, "午餐", fname, mime, now)
            server.insert_meal_row(c, d, "午餐", {
                "name": "鸡胸", "amount": "150g", "kcal": 500, "energy_kj": 500,
                "protein": 30, "carb": 0, "fat": 5, "grams": 150, "item_source": "ai",
                "from_label": False, "note": "", "energy_mode": "scaled",
            }, "", "ai", now, pid)
        s = server.day_summary(d)
        self.assertEqual(s["meals"][0]["photo_id"], pid)
        path = server.photo_file_path(fname)
        self.assertTrue(path and Path(path).is_file())
        data = server.build_export()
        self.assertEqual(len(data["photos"]), 1)
        self.assertTrue(data["photos"][0]["data_url"].startswith("data:image/png"))
        other = Path(self.tmp.name) / "restored.db"
        server.DB_PATH = str(other)
        server.init_db()
        server.apply_import(data)
        again = server.build_export()
        self.assertEqual(len(again["photos"]), 1)
        self.assertEqual(again["meals"][0]["name"], "鸡胸")
        self.assertIsNotNone(again["meals"][0]["photo_id"])
