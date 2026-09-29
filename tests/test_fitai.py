# -*- coding: utf-8 -*-
"""渐渐飞 回归检查：临时库 + mock，不调用真实模型、不用真实个人数据。"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ["FITAI_DB"] = str(Path(tempfile.mkdtemp()) / "fitai-test.db")

import server  # noqa: E402


def _fresh_db():
    path = Path(tempfile.mkdtemp()) / "fitai.db"
    server.DB_PATH = str(path)
    server.init_db()
    return path


class DirectTests(unittest.TestCase):
    def setUp(self):
        _fresh_db()

    def test_t01_empty_no_fake_weight(self):
        d = server.date.today().isoformat()
        s = server.day_summary(d)
        self.assertIsNone(s["weight"])
        self.assertIn(s["weight_source"], ("none", "estimate", "profile", "profile_target"))
        self.assertNotEqual(s["weight_source"], "measured")
        self.assertEqual(s["meal_status"], "none")
        self.assertTrue(s["target_is_estimate"] or s["needs_setup"])
        self.assertIsNone(s["predict_delta"])
        self.assertIsNone(s["net"])

    def test_t02_explicit_kj_not_guessed(self):
        items = server._normalize_items([{
            "name": "标签酸奶", "kj": 100, "protein": 10, "carb": 10, "fat": 0, "grams": 100, "from_label": True,
        }])
        self.assertAlmostEqual(items[0]["energy_kj"], 100, places=1)
        saved = server.validate_meal_items([{
            "name": "标签酸奶", "energy_kj": 100, "protein": 10, "carb": 10, "fat": 0, "grams": 100, "from_label": True,
        }])
        self.assertAlmostEqual(saved[0]["energy_kj"], 100, places=1)

    def test_t02_kcal_label_converts(self):
        items = server._normalize_items([{
            "name": "x", "kcal": 100, "protein": 0, "carb": 0, "fat": 0, "grams": 100,
        }])
        self.assertAlmostEqual(items[0]["energy_kj"], 100 * 4.184, delta=0.2)

    def test_t03_migrate_twice(self):
        path = Path(server.DB_PATH)
        with server.db() as c:
            c.execute("DELETE FROM meta WHERE key='energy_unit'")
            c.execute("DELETE FROM meals")
            c.execute(
                "INSERT INTO meals(date,meal_type,name,amount,kcal,protein,carb,fat,source,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("2026-01-01", "早餐", "旧数据", "100g", 100, 1, 1, 1, "manual", "2026-01-01"),
            )
        server.migrate_all()
        with server.db() as c:
            v = c.execute("SELECT kcal FROM meals").fetchone()["kcal"]
            unit = c.execute("SELECT value FROM meta WHERE key='energy_unit'").fetchone()["value"]
        self.assertEqual(unit, "kJ")
        self.assertAlmostEqual(v, 418.4, delta=0.2)
        server.migrate_all()
        with server.db() as c:
            v2 = c.execute("SELECT kcal FROM meals").fetchone()["kcal"]
        self.assertAlmostEqual(v2, v, places=1)
        self.assertTrue(path.exists())

    def test_coach_schema_migration_preserves_existing_data(self):
        d = server.date.today().isoformat()
        with server.db() as c:
            c.execute("DROP TABLE coach_messages")
            c.execute("DROP TABLE coach_sessions")
            c.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
            c.execute("INSERT INTO weights(date,weight) VALUES(?,?)", (d, 70.1))
        server.migrate_all()
        with server.db() as c:
            self.assertEqual(c.execute("SELECT weight FROM weights WHERE date=?", (d,)).fetchone()[0], 70.1)
            self.assertEqual(c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "5")
            self.assertIsNotNone(c.execute("SELECT name FROM sqlite_master WHERE name='coach_sessions'").fetchone())
        backups = list((Path(server.DB_PATH).parent / "backups").glob("fitai-migrate-v5-*.db"))
        self.assertTrue(backups)
        server.migrate_all()
        self.assertEqual(len(list((Path(server.DB_PATH).parent / "backups").glob("fitai-migrate-v5-*.db"))), len(backups))
        self.assertNotEqual(server.backup_db("manual"), server.backup_db("manual"))

    def test_image_payload_rejects_spoofed_format(self):
        fake = "data:image/png;base64," + server.base64.b64encode(b"not an image" * 3).decode()
        with self.assertRaises(server.ApiError):
            server.decode_image_payload(fake)

    def test_t04_rejects_bad_input(self):
        with self.assertRaises(server.ApiError):
            server.parse_date("2026-02-30", strict=True)
        with self.assertRaises(server.ApiError):
            server.parse_date("not-a-date", strict=True)
        with self.assertRaises(server.ApiError):
            server.validate_meal_items([{"name": "x", "energy_kj": -1, "protein": 0, "carb": 0, "fat": 0, "grams": 1}])
        with self.assertRaises(server.ApiError):
            server.validate_meal_items([{"name": "x", "energy_kj": float("nan"), "protein": 0, "carb": 0, "fat": 0, "grams": 1}])
        with self.assertRaises(server.ApiError):
            server.validate_meal_items("nope")
        with self.assertRaises(server.ApiError):
            server.validate_meal_items([{"name": "x", "energy_kj": 1, "protein": 0, "carb": 0, "fat": 0, "grams": 1}, "bad"])
        with self.assertRaises(server.ApiError):
            server.validate_meal_items([{"name": "x" * 500, "energy_kj": 1, "protein": 0, "carb": 0, "fat": 0, "grams": 1}])
        zero = server.validate_meal_items([{
            "name": "水", "energy_kj": 0, "protein": 0, "carb": 0, "fat": 0, "grams": 200,
        }])
        self.assertEqual(zero[0]["energy_kj"], 0)
        p = server.save_profile({"gender": "female", "age": 30, "height": 165, "activity": 1.2,
                                 "target_weight": 55, "weekly_loss": 0})
        self.assertEqual(p["weekly_loss"], 0)

    def test_t08_partial_not_full_day(self):
        d = server.date.today().isoformat()
        with server.db() as c:
            server.insert_meal_row(c, d, "早餐", {
                "name": "粥", "amount": "1碗", "kcal": 800, "energy_kj": 800,
                "protein": 5, "carb": 40, "fat": 1, "grams": 250, "item_source": "manual",
                "from_label": False, "note": "", "energy_mode": "scaled",
            }, "", "manual", "now")
        s = server.day_summary(d)
        self.assertEqual(s["meal_status"], "logged")
        self.assertTrue(s["has_meals"])
        self.assertIsNone(s["predict_delta"])
        self.assertIsNotNone(s["net"])

    def test_t09_natural_7_days(self):
        today = server.date.today()
        old = (today - server.timedelta(days=20)).isoformat()
        recent = (today - server.timedelta(days=1)).isoformat()
        with server.db() as c:
            for day, kj in ((old, 1000), (recent, 2000)):
                server.insert_meal_row(c, day, "午餐", {
                    "name": "饭", "amount": "1", "kcal": kj, "energy_kj": kj,
                    "protein": 10, "carb": 40, "fat": 5, "grams": 200, "item_source": "manual",
                    "from_label": False, "note": "", "energy_mode": "scaled",
                }, "", "manual", "now")
        hist = server.history(7)
        self.assertEqual(len(hist), 7)
        logged = [h for h in hist if h["has_meals"]]
        self.assertEqual(len(logged), 1)
        self.assertEqual(logged[0]["date"], recent)
        hist_old = server.history(14, end_date=old)
        self.assertTrue(all(h["date"] <= old for h in hist_old))

    def test_local_estimate_portions_and_composite(self):
        items = server.local_estimate("米饭 200g 鸡蛋 50g")
        by = {it["name"]: it for it in items}
        self.assertIn("米饭", by)
        self.assertIn("鸡蛋", by)
        self.assertAlmostEqual(by["米饭"]["grams"], 200)
        self.assertAlmostEqual(by["鸡蛋"]["grams"], 50)
        comp = server.local_estimate("番茄炒蛋")
        names = [it["name"] for it in comp]
        self.assertFalse(any(n == "番茄" for n in names), names)

    def test_export_schema(self):
        data = server.build_export()
        self.assertEqual(data["schema_version"], server.SCHEMA_VERSION)
        self.assertEqual(data["energy_unit"], "kJ")
        self.assertIn("exported_at", data)
        self.assertIn("display_unit", data)
        self.assertNotIn("api_key", json.dumps(data))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _fresh_db()
        cls.srv = server.ReuseServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.15)
        cls.token = cls.get("/api/state")["session_token"]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    @classmethod
    def raw(cls, method, path, body=None, headers=None, token=True):
        conn = HTTPConnection("127.0.0.1", cls.port, timeout=8)
        hdrs = {"Host": "127.0.0.1:%d" % cls.port, "Connection": "close"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
            if token:
                hdrs["X-FitAI-Token"] = cls.token
        if headers:
            hdrs.update(headers)
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            obj = raw.decode("utf-8", "ignore")
        return resp.status, obj

    @classmethod
    def get(cls, path):
        code, obj = cls.raw("GET", path, token=False)
        if code >= 400:
            raise AssertionError("%s %s %s" % (code, path, obj))
        return obj

    @classmethod
    def post(cls, path, body, expect=200):
        code, obj = cls.raw("POST", path, body)
        if code != expect:
            raise AssertionError("%s %s %s" % (code, path, obj))
        return obj

    def test_health(self):
        h = self.get("/api/health")
        self.assertTrue(h["ok"])
        self.assertEqual(h["app"], "渐渐飞")

    def test_coach_sessions_and_image_roundtrip(self):
        d = server.date.today().isoformat()
        tiny = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        with server.db() as c:
            c.execute("UPDATE settings SET api_key='text-key',base_url='https://text.example/v1',"
                      "text_model='text-model',vision_enabled=1,vision_mode='custom',"
                      "vision_api_key='vision-key',vision_base_url='https://vision.example/v1',"
                      "vision_model='vision-model' WHERE id=1")
        first = self.post("/api/coach/session/create", {"date": d})["session"]["id"]
        second = self.post("/api/coach/session/create", {"date": d})["session"]["id"]
        self.assertNotEqual(first, second)
        with mock.patch.object(server, "call_model", return_value={"content": "看到了图片", "reasoning": ""}) as call:
            self.post("/api/coach", {"session_id": first, "question": "这是什么？", "images": [tiny, tiny, tiny]})
        self.assertEqual(call.call_args.args[:3], ("https://vision.example/v1", "vision-key", "vision-model"))
        self.assertEqual(len(call.call_args.args[3][-1]["content"]), 4)
        self.assertTrue(all(part["type"] == "image_url" for part in call.call_args.args[3][-1]["content"][1:]))
        message = self.get("/api/coach/session?id=" + first)["messages"][0]
        self.assertEqual(message["content"], "这是什么？")
        self.assertEqual(len(message["image_urls"]), 3)
        with mock.patch.object(server, "call_model", return_value={"content": "继续看图回答", "reasoning": ""}) as call:
            self.post("/api/coach", {"session_id": first, "question": "图里还有什么？"})
        self.assertEqual(call.call_args.args[:3], ("https://vision.example/v1", "vision-key", "vision-model"))
        self.assertEqual(len(call.call_args.args[3][1]["content"]), 4)
        self.assertEqual(self.get("/api/coach/session?id=" + second)["messages"], [])
        with mock.patch.object(server, "call_model", return_value={"content": "文字回答", "reasoning": ""}) as call:
            self.post("/api/coach", {"session_id": second, "question": "独立问题"})
        self.assertEqual(call.call_args.args[:3], ("https://text.example/v1", "text-key", "text-model"))
        self.assertEqual(len(call.call_args.args[3]), 2)  # system + current user, no other session history
        with mock.patch.object(server, "call_model", side_effect=RuntimeError("mock failure")):
            self.assertEqual(self.raw("POST", "/api/coach", {"session_id": second, "question": "失败问题"})[0], 502)
        self.assertEqual(len(self.get("/api/coach/session?id=" + second)["messages"]), 2)
        for url in message["image_urls"]:
            code, raw = self.raw("GET", url, token=False)
            self.assertEqual(code, 200)
            self.assertTrue(raw)
        self.assertEqual(self.raw("GET", message["image_urls"][0].replace("index=0", "index=8"), token=False)[0], 404)
        self.assertEqual(self.raw("POST", "/api/coach", {"session_id": first, "images": [tiny] * 5})[0], 400)
        backup = self.get("/api/export")
        self.assertEqual(len(backup["coach_sessions"]), 2)
        self.assertEqual(len(backup["coach_messages"]), 6)
        self.assertEqual(len(backup["coach_messages"][0]["images"]), 3)
        self.post("/api/import", backup)
        restored = self.get("/api/coach/session?id=" + first)["messages"]
        self.assertEqual(len(restored), 4)
        self.assertEqual(len(restored[0]["image_urls"]), 3)
        old_backup = json.loads(json.dumps(backup))
        old_backup["schema_version"] = 4
        for turn in old_backup["coach_messages"]:
            turn["image"] = (turn["images"] or [None])[0]
            del turn["images"]
        self.post("/api/import", old_backup)
        self.assertEqual(len(self.get("/api/coach/session?id=" + first)["messages"][0]["image_urls"]), 1)
        self.post("/api/import", backup)
        self.post("/api/coach/session/delete", {"session_id": first})
        self.assertEqual(self.raw("GET", "/api/coach/session?id=" + first, token=False)[0], 404)
        legacy = {"date": d, "messages": [{"role": "user", "content": "旧提问"}]}
        legacy_id = self.post("/api/coach/session/import_legacy", legacy)["session_id"]
        self.assertEqual(self.post("/api/coach/session/import_legacy", legacy)["session_id"], legacy_id)
        self.assertEqual(len(self.get("/api/coach/session?id=" + legacy_id)["messages"]), 1)

    def test_t04_http_validation(self):
        code, obj = self.raw("POST", "/api/meal", {
            "date": "2026-02-30", "meal_type": "早餐",
            "items": [{"name": "x", "energy_kj": 10, "protein": 0, "carb": 0, "fat": 0, "grams": 1}],
        })
        self.assertEqual(code, 400)
        self.assertIn("date", str(obj))
        code, obj = self.raw("POST", "/api/meal", {
            "date": server.date.today().isoformat(), "meal_type": "宵夜",
            "items": [{"name": "x", "energy_kj": 10, "protein": 0, "carb": 0, "fat": 0, "grams": 1}],
        })
        self.assertEqual(code, 400)
        d = server.date.today().isoformat()
        code, obj = self.raw("POST", "/api/exercise", {
            "date": d, "items": [
                {"type": "跑步", "minutes": 20, "energy_kj": 100},
                {"type": "坏", "minutes": -3},
            ],
        })
        self.assertEqual(code, 400)
        today = self.get("/api/state?date=" + d)["today"]
        self.assertEqual(today["exercises"], [])

    def test_t10_save_delete_restore(self):
        d = server.date.today().isoformat()
        r = self.post("/api/meal", {
            "date": d, "meal_type": "午餐", "op_id": "op-meal-1",
            "items": [{"name": "鸡胸", "energy_kj": 500, "protein": 30, "carb": 0, "fat": 5, "grams": 150,
                       "item_source": "manual"}],
        })
        self.assertTrue(r["ok"])
        mid = r["today"]["meals"][0]["id"]
        n1 = len(r["today"]["meals"])
        r2 = self.post("/api/meal", {
            "date": d, "meal_type": "午餐", "op_id": "op-meal-1",
            "items": [{"name": "鸡胸", "energy_kj": 500, "protein": 30, "carb": 0, "fat": 5, "grams": 150,
                       "item_source": "manual"}],
        })
        self.assertTrue(r2.get("idempotent"))
        self.assertEqual(len(r2["today"]["meals"]), n1)
        gone = self.post("/api/meal/delete", {"id": mid, "date": d})
        self.assertEqual(len(gone["today"]["meals"]), n1 - 1)
        back = self.post("/api/restore", {"kind": "meal", "id": mid, "date": d})
        self.assertEqual(len(back["today"]["meals"]), n1)

    def test_t11_copy_idempotent(self):
        d = server.date.today().isoformat()
        y = (server.date.today() - server.timedelta(days=1)).isoformat()
        self.post("/api/meal", {
            "date": y, "meal_type": "早餐", "op_id": "op-y",
            "items": [{"name": "蛋", "energy_kj": 300, "protein": 12, "carb": 1, "fat": 8, "grams": 50}],
        })
        a = self.post("/api/copy_day", {"from": y, "date": d, "op_id": "copy-1"})
        b = self.post("/api/copy_day", {"from": y, "date": d, "op_id": "copy-1"})
        self.assertTrue(b.get("idempotent"))
        self.assertEqual(a["copied"], 1)

    def test_t13_vision_mode_persists(self):
        s = self.post("/api/settings", {
            "base_url": "https://example.com/v1",
            "text_model": "main-model",
            "api_key": "sk-main-key-123456",
            "api_key_action": "replace",
            "vision_mode": "custom",
            "vision_enabled": 1,
            "vision_base_url": "https://vision.example.com/v1",
            "vision_model": "vision-model",
            "vision_api_key": "sk-main-key-123456",
            "vision_api_key_action": "replace",
        })["settings"]
        self.assertEqual(s["vision_mode"], "custom")
        self.assertEqual(s["vision_model"], "vision-model")
        self.assertEqual(s["vision_base_url"], "https://vision.example.com/v1")
        again = self.get("/api/state")["settings"]
        self.assertEqual(again["vision_mode"], "custom")
        self.assertEqual(again["vision_model"], "vision-model")
        keep = self.post("/api/settings", {
            "vision_mode": "custom",
            "vision_model": "vision-model",
            "vision_base_url": "https://vision.example.com/v1",
            "api_key_action": "keep",
            "vision_api_key_action": "keep",
        })["settings"]
        self.assertEqual(keep["vision_mode"], "custom")
        self.assertEqual(keep["vision_model"], "vision-model")
        self.assertTrue(keep["has_key"])

    def test_t14_job_cap_and_local(self):
        d = server.date.today().isoformat()
        r = self.post("/api/analyze_text", {"text": "米饭 200g 鸡蛋 50g", "local": True})
        self.assertIn("job_id", r)
        for _ in range(40):
            snap = self.get("/api/job?id=" + r["job_id"])
            if snap["status"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(snap["status"], "done")
        names = [it["name"] for it in snap["result"]["items"]]
        self.assertTrue("米饭" in names or "鸡蛋" in names)
        orig = server.JOB_MAX_RUNNING
        server.JOB_MAX_RUNNING = 1
        try:
            with server.JOBS_LOCK:
                server.JOBS["busy"] = {"status": "running", "ts": time.time(), "started": time.time()}
            code, obj = self.raw("POST", "/api/analyze_text", {"text": "米饭", "local": True})
            self.assertEqual(code, 429)
        finally:
            server.JOB_MAX_RUNNING = orig
            with server.JOBS_LOCK:
                server.JOBS.pop("busy", None)

    def test_t15_export_import(self):
        d = server.date.today().isoformat()
        self.post("/api/weight", {"date": d, "weight": 70.2})
        self.post("/api/meal", {
            "date": d, "meal_type": "晚餐", "op_id": "exp1",
            "items": [{"name": "鱼", "energy_kj": 900, "protein": 22, "carb": 0, "fat": 8, "grams": 120,
                       "item_source": "label", "from_label": True}],
        })
        data = self.get("/api/export")
        self.assertEqual(data["energy_unit"], "kJ")
        other = Path(tempfile.mkdtemp()) / "b.db"
        old = server.DB_PATH
        server.DB_PATH = str(other)
        server.init_db()
        server.DB_PATH = old
        code, obj = self.raw("POST", "/api/import", {"not": "fitai", "schema_version": 99})
        self.assertEqual(code, 400)
        after_fail = self.get("/api/export")
        self.assertEqual(len(after_fail["meals"]), len(data["meals"]))
        ok = self.post("/api/import", data)
        self.assertEqual(ok["meals"], len(data["meals"]))
        again = self.get("/api/export")
        self.assertEqual(len(again["meals"]), len(data["meals"]))
        self.assertAlmostEqual(again["meals"][0]["energy_kj"], data["meals"][0]["energy_kj"], places=1)

    def test_t16_origin_and_probe(self):
        d = server.date.today().isoformat()
        code, obj = self.raw("POST", "/api/weight", {"date": d, "weight": 68},
                             headers={"Origin": "http://evil.example", "Content-Type": "application/json",
                                      "X-FitAI-Token": self.token})
        self.assertEqual(code, 403)
        code, obj = self.raw("POST", "/api/weight", {"date": d, "weight": 68},
                             headers={"X-FitAI-Token": "wrong", "Content-Type": "application/json"})
        self.assertEqual(code, 403)
        self.assertTrue(server._probe_port(self.port))
        other = server.ReuseServer(("127.0.0.1", 0), _OtherHandler)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        time.sleep(0.05)
        self.assertFalse(server._probe_port(other.server_address[1]))
        other.shutdown()
        other.server_close()

    def test_meal_update_needs_no_complete_step(self):
        d = server.date.today().isoformat()
        r = self.post("/api/meal", {
            "date": d, "meal_type": "加餐", "op_id": "upd1",
            "items": [{"name": "苹果", "energy_kj": 400, "protein": 1, "carb": 20, "fat": 0, "grams": 200,
                       "base_grams": 200, "base_kj": 400, "base_protein": 1, "base_carb": 20, "base_fat": 0}],
        })
        mid = r["today"]["meals"][-1]["id"]
        u = self.post("/api/meal/update", {
            "id": mid, "date": d, "meal_type": "加餐", "name": "苹果",
            "grams": 100, "energy_kj": 200, "protein": 0.5, "carb": 10, "fat": 0, "energy_mode": "scaled",
        })
        apple = [m for m in u["today"]["meals"] if m["id"] == mid][0]
        self.assertAlmostEqual(apple["energy_kj"], 200, places=1)
        self.assertEqual(u["today"]["meal_status"], "logged")
        self.assertIsNone(u["today"]["predict_delta"])
        self.assertIn("macro_targets", u["today"])
        self.assertIn("protein_g", u["today"]["macro_targets"])
        code, _ = self.raw("POST", "/api/day_complete", {"date": d, "complete": True})
        self.assertEqual(code, 410)

    def test_save_meal_keeps_photo(self):
        d = server.date.today().isoformat()
        tiny = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        r = self.post("/api/meal", {
            "date": d, "meal_type": "午餐", "op_id": "photo-1",
            "image": tiny,
            "items": [{"name": "沙拉", "energy_kj": 400, "protein": 10, "carb": 20, "fat": 8, "grams": 200,
                       "item_source": "ai"}],
        })
        self.assertTrue(r["ok"])
        meal = r["today"]["meals"][-1]
        self.assertIsNotNone(meal.get("photo_id"))
        code, raw = self.raw("GET", "/api/photo?id=%s" % meal["photo_id"], token=False)
        self.assertEqual(code, 200)
        self.assertTrue(isinstance(raw, str) or raw)  # parsed or binary decoded
        replay = self.post("/api/meal", {
            "date": d, "meal_type": "午餐", "op_id": "photo-1",
            "image": tiny,
            "items": [{"name": "沙拉", "energy_kj": 400, "protein": 10, "carb": 20, "fat": 8, "grams": 200,
                       "item_source": "ai"}],
        })
        self.assertTrue(replay.get("idempotent"))
        self.assertEqual(len(replay["today"]["meals"]), len(r["today"]["meals"]))
        code, obj = self.raw("POST", "/api/meal", {
            "date": d, "meal_type": "晚餐", "op_id": "photo-1",
            "items": [{"name": "汤", "energy_kj": 100, "protein": 1, "carb": 10, "fat": 1, "grams": 200}],
        })
        self.assertEqual(code, 400)


class _OtherHandler(server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"hello"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
