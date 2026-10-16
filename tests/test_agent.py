# -*- coding: utf-8 -*-
"""Unified Agent protocol checks. Uses a temporary database and a mocked model."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["FITAI_DB"] = str(Path(tempfile.mkdtemp()) / "fitai-agent-test.db")

import server  # noqa: E402


class ModelCompatibilityTests(unittest.TestCase):
    def test_deepseek_uses_supported_json_mode(self):
        with mock.patch.object(server, "_request_stream", return_value=("", '{"ok":true}', {})) as request:
            server.call_model("https://api.deepseek.com/v1", "test-key", "deepseek-flash", [],
                              json_schema=server.AGENT_SCHEMA)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[2]["response_format"], {"type": "json_object"})

    def test_shared_key_allows_format_compatibility_retry(self):
        shared = {"api_key": "private-shared-key", "base_url": "https://example.test/v1", "text_model": "test-model"}
        with mock.patch.object(server, "shared_defaults", return_value=shared), \
                mock.patch.object(server, "_request_stream", side_effect=[
                    RuntimeError("400 unsupported response_format"), ("", '{"ok":true}', {}),
                ]) as request:
            out = server.call_model(shared["base_url"], shared["api_key"], shared["text_model"], [],
                                    json_schema=server.AGENT_SCHEMA)
        self.assertEqual(out["content"], '{"ok":true}')
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args.args[2]["response_format"], {"type": "json_object"})

    def test_shared_key_errors_remain_private_after_retries(self):
        shared = {"api_key": "private-shared-key", "base_url": "https://example.test/v1", "text_model": "test-model"}
        for code, expected_calls in [(401, 1), (402, 1), (400, 6)]:
            with self.subTest(code=code), mock.patch.object(server, "shared_defaults", return_value=shared), \
                    mock.patch.object(server, "_request_stream", side_effect=RuntimeError(
                        str(code) + " private-shared-key upstream-details")) as request:
                with self.assertRaises(RuntimeError) as error:
                    server.call_model(shared["base_url"], shared["api_key"], shared["text_model"], [],
                                      json_schema=server.AGENT_SCHEMA, want_reasoning=False)
                self.assertNotIn("private-shared-key", str(error.exception))
                self.assertNotIn("upstream-details", str(error.exception))
                self.assertIn(str(code), str(error.exception))
                self.assertEqual(request.call_count, expected_calls)

    def test_reasoning_only_response_retries_with_thinking_disabled(self):
        with mock.patch.object(server, "_request_stream", side_effect=[
            ("reasoning only", "", {"completion_tokens": 4096}),
            ("", '{"reply":"hello","tool_calls":[]}', {}),
        ]) as request:
            out = server.call_model("https://example.test/v1", "test-key", "test-model", [],
                                    json_schema=server.AGENT_SCHEMA, want_reasoning=True)
        self.assertTrue(out["content"])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[1].args[2]["thinking"], {"type": "disabled"})

    def test_non_reasoning_request_explicitly_disables_thinking(self):
        with mock.patch.object(server, "_request_stream", return_value=("", "hello", {})) as request:
            server.call_model("https://example.test/v1", "test-key", "test-model", [], want_reasoning=False)
        self.assertEqual(request.call_args.args[2]["thinking"], {"type": "disabled"})

    def test_gateway_rejecting_thinking_field_falls_back_to_omission(self):
        with mock.patch.object(server, "_request_stream", side_effect=[
            RuntimeError("400 unsupported thinking"), ("", "hello", {}),
        ]) as request:
            out = server.call_model("https://example.test/v1", "test-key", "test-model", [], want_reasoning=False)
        self.assertEqual(out["content"], "hello")
        self.assertNotIn("thinking", request.call_args.args[2])

    def test_empty_output_never_counts_as_success(self):
        with mock.patch.object(server, "_request_stream", return_value=("", "", {})):
            with self.assertRaisesRegex(RuntimeError, "未生成最终回复"):
                server.call_model("https://example.test/v1", "test-key", "test-model", [], want_reasoning=False)

    def test_streamed_provider_errors_are_not_swallowed(self):
        response = mock.MagicMock()
        response.headers.get.return_value = "text/event-stream"
        with mock.patch.object(server.urllib.request, "urlopen", return_value=response), \
                mock.patch.object(server, "_iter_sse_objects", return_value=iter([
                    {"error": {"message": "upstream unavailable"}},
                ])):
            with self.assertRaisesRegex(RuntimeError, "upstream unavailable"):
                server._request_stream("https://example.test/v1/chat/completions", "test-key", {}, 5)


class MealIntentTests(unittest.TestCase):
    def test_photo_intake_and_unresolved_quantity_followups(self):
        prior = [{"role": "assistant", "content": "是冬枣，请确认数量", "tool_calls": "[]"},
                 {"role": "user", "content": "我吃了两个", "images": '["test-image"]'}]
        self.assertTrue(server.meal_draft_request("我吃了两个", ["test-image"]))
        for question in ("行", "两颗冬枣", "就是两颗", "对的"):
            with self.subTest(question=question):
                self.assertTrue(server.meal_draft_request(question, [], prior))
        self.assertFalse(server.meal_draft_request("我吃了两个", []))

    def test_questions_cancellations_and_existing_tools_do_not_repeat_meals(self):
        prior = [{"role": "assistant", "tool_calls": "[]"},
                 {"role": "user", "content": "我吃了两颗冬枣"}]
        for question in ("还没吃", "我没吃了", "明天想吃两个", "如果我吃了两个", "两个会胖吗", "热量多少？", "不用记了", "算了", "记录饮食", "他吃了两个鸡蛋", "比如我吃了两个鸡蛋"):
            with self.subTest(question=question):
                self.assertFalse(server.meal_draft_request(question, [], prior))
        for status in ("pending", "confirmed", "rejected"):
            prior[0]["tool_calls"] = json.dumps([{"name": "log_meal", "status": status}])
            self.assertFalse(server.meal_draft_request("行", [], prior))
            self.assertFalse(server.meal_draft_request("两颗冬枣", [], prior))
        self.assertFalse(server.meal_draft_request("两颗冬枣", []))


class AgentTests(unittest.TestCase):
    def setUp(self):
        with server.db() as c:
            c.execute("UPDATE settings SET search_enabled=0,tavily_api_key='' WHERE id=1")

    @classmethod
    def setUpClass(cls):
        server.DB_PATH = str(Path(tempfile.mkdtemp()) / "fitai.db")
        server.init_db()
        with server.db() as c:
            c.execute("UPDATE settings SET api_key='test-key',text_model='test-model' WHERE id=1")
        cls.srv = server.ReuseServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.1)
        cls.token = cls.request("GET", "/api/state")[1]["session_token"]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    @classmethod
    def request(cls, method, path, body=None):
        conn = HTTPConnection("127.0.0.1", cls.port, timeout=5)
        headers = {"Host": "127.0.0.1:%d" % cls.port, "Connection": "close"}
        raw = None
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            headers.update({"Content-Type": "application/json", "X-FitAI-Token": cls.token})
        conn.request(method, path, body=raw, headers=headers)
        response = conn.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        conn.close()
        return response.status, payload

    def model_result(self):
        d = server.date.today().isoformat()
        return {"content": json.dumps({
            "reply": "我整理成一条早餐记录，请确认。",
            "tool_calls": [{"name": "log_meal", "arguments": {
                "date": d, "meal_type": "早餐", "items": [{
                    "name": "鸡蛋", "amount": "2个", "grams": 100, "kj": 620,
                    "protein": 13, "carb": 1.2, "fat": 10, "confidence": 0.8,
                    "from_label": False, "note": "按普通鸡蛋估算",
                }],
            }}],
        }, ensure_ascii=False), "reasoning": ""}

    def test_agent_prompt_makes_matching_tool_calls_mandatory(self):
        prompt = server.AGENT_SYSTEM
        self.assertIn("不要把工具调用当成可选的补充", prompt)
        self.assertIn("命中条件时不得返回空数组", prompt)
        self.assertIn("只用 reply 口头答应", prompt)
        self.assertIn("先调用 query_records", prompt)
        self.assertIn("饭剩30%表示米饭吃了70%", prompt)
        self.assertIn("中国大陆版", prompt)
        self.assertIn("相差超过20%", prompt)
        self.assertNotIn("默认不调用工具。需要写入时", prompt)

    def test_bare_record_entry_never_reuses_old_food_or_calls_model(self):
        d = server.date.today().isoformat()
        sid = self.request("POST", "/api/coach/session/create", {"date": d})[1]["session"]["id"]
        with server.db() as c:
            c.execute("INSERT INTO coach_messages(session_id,role,content,created_at) VALUES(?,?,?,?)",
                      (sid, "user", "我刚吃了两个鸡蛋和一杯豆浆", "now"))
        before = len(server.day_summary(d)["meals"])
        for question in ("记录饮食", "我要记录运动", "我要记录体重", "我要补充今天的记录", "今天记完了"):
            with self.subTest(question=question), mock.patch.object(server, "call_model", return_value=self.model_result()) as model:
                code, answer = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": question})
                self.assertEqual(code, 200)
                self.assertEqual(answer["tool_calls"], [])
                model.assert_not_called()
                self.assertEqual(len(server.day_summary(d)["meals"]), before)

    def test_recording_intent_reaches_model_without_changing_user_facts(self):
        d = server.date.today().isoformat()
        sid = self.request("POST", "/api/coach/session/create", {"date": d})[1]["session"]["id"]
        out = {"content": json.dumps({"reply": "这是热量问题，不自动录入", "tool_calls": []})}
        for question in ("这个热量多少？", "还没吃", "明天想吃苹果"):
            with self.subTest(question=question), mock.patch.object(server, "call_model", return_value=out) as model:
                code, answer = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": question, "recording_intent": "meal"})
                self.assertEqual(code, 200)
                self.assertEqual(answer["tool_calls"], [])
                messages = model.call_args.args[3]
                ctx = json.loads(messages[-1]["content"].split("\n", 1)[1])
                self.assertEqual(ctx["用户问题"], question)
                self.assertIn("准备记录饮食", ctx["本轮输入意图"])
                self.assertIn("不能覆盖明确的问题、否定、计划", messages[0]["content"])

    def test_complete_tool_removed_from_schema_and_rejected_including_batch(self):
        self.assertNotIn("mark_day_complete", server.AGENT_TOOLS)
        self.assertNotIn("mark_day_complete", server.AGENT_SCHEMA["properties"]["tool_calls"]["items"]["properties"]["name"]["enum"])
        d = server.date.today().isoformat()
        call = {"name": "mark_day_complete", "arguments": {"date": d, "complete": True}}
        with self.assertRaises(server.ApiError):
            server.normalize_agent_tool_call(call, d)
        with self.assertRaises(server.ApiError):
            server.normalize_agent_tool_call({"name": "manage_records", "arguments": {"operations": [call]}}, d)

    def test_invalid_recording_intent_rejected(self):
        d = server.date.today().isoformat()
        sid = self.request("POST", "/api/coach/session/create", {"date": d})[1]["session"]["id"]
        code, _ = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": "你好", "recording_intent": "record_fake_food"})
        self.assertEqual(code, 400)

    def test_photo_quantity_followup_produces_pending_card_without_saving(self):
        d = server.date.today().isoformat()
        sid = self.request("POST", "/api/coach/session/create", {"date": d})[1]["session"]["id"]
        image = ("data:image/png;base64,"
                 "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        with server.db() as c:
            c.execute("UPDATE settings SET vision_enabled=1,vision_mode='inherit' WHERE id=1")
            c.execute("INSERT INTO coach_messages(session_id,role,content,images,created_at) VALUES(?,?,?,?,?)",
                      (sid, "user", "我吃了两个", json.dumps([image]), "now"))
            c.execute("INSERT INTO coach_messages(session_id,role,content,tool_calls,created_at) VALUES(?,?,?,?,?)",
                      (sid, "assistant", "图片里是鸡蛋，请确认数量", "[]", "now"))
        empty = {"content": '{"reply":"确认数量后再记录","tool_calls":[]}'}
        before = len(server.day_summary(d)["meals"])
        with mock.patch.object(server, "call_model", side_effect=[empty, self.model_result()]) as model:
            code, answer = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": "两个鸡蛋"})
        self.assertEqual(code, 200)
        self.assertEqual(answer["tool_calls"][0]["status"], "pending")
        self.assertEqual(len(server.day_summary(d)["meals"]), before)
        sent = model.call_args.args[3]
        self.assertTrue(any(isinstance(m["content"], list) and any(
            p.get("image_url", {}).get("url") == image for p in m["content"]) for m in sent))
        # An acknowledgement after an existing card must not force a second card.
        with mock.patch.object(server, "call_model", return_value={"content": '{"reply":"请在卡片里确认","tool_calls":[]}'}) as model:
            code, answer = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": "行"})
        self.assertEqual(code, 200)
        self.assertEqual(answer["tool_calls"], [])
        self.assertNotIn("【本轮记录约束】", model.call_args.args[3][0]["content"])

    def test_pending_then_confirm_or_reject(self):
        d = server.date.today().isoformat()
        code, created = self.request("POST", "/api/coach/session/create", {"date": d})
        self.assertEqual(code, 200)
        sid = created["session"]["id"]
        with mock.patch.object(server, "call_model", return_value=self.model_result()):
            code, answer = self.request("POST", "/api/agent", {
                "session_id": sid, "date": d, "question": "早餐吃了两个鸡蛋", "images": [],
            })
        self.assertEqual(code, 200)
        call = answer["tool_calls"][0]
        self.assertEqual(call["status"], "pending")
        self.assertEqual(server.day_summary(d)["meals"], [])
        code, saved = self.request("POST", "/api/agent/tool", {
            "session_id": sid, "message_id": answer["message_id"],
            "call_id": call["id"], "decision": "confirm",
        })
        self.assertEqual(code, 200)
        self.assertEqual(saved["tool_call"]["status"], "confirmed")
        self.assertEqual(server.day_summary(d)["meals"][0]["name"], "鸡蛋")
        code, duplicate = self.request("POST", "/api/agent/tool", {
            "session_id": sid, "message_id": answer["message_id"],
            "call_id": call["id"], "decision": "confirm",
        })
        self.assertEqual(code, 409)
        self.assertEqual(len(server.day_summary(d)["meals"]), 1)

    def test_search_settings_keep_replace_clear_and_no_key_leak(self):
        code, _ = self.request("POST", "/api/settings", {"search_enabled": True})
        self.assertEqual(code, 400)
        code, _ = self.request("POST", "/api/settings", {
            "tavily_api_key": "tvly-private-test-secret", "tavily_api_key_action": "replace", "search_enabled": True})
        self.assertEqual(code, 200)
        self.assertTrue(server.public_settings()["search_ready"])
        self.request("POST", "/api/settings", {"search_enabled": False})
        self.assertEqual(server.get_settings()["tavily_api_key"], "tvly-private-test-secret")
        self.assertNotIn("tvly-private-test-secret", json.dumps(server.build_export()))
        self.assertNotIn("tvly-private-test-secret", json.dumps(server.public_settings()))
        self.request("POST", "/api/settings", {"search_enabled": True})
        self.request("POST", "/api/settings", {"tavily_api_key_action": "clear"})
        self.assertFalse(server.public_settings()["has_tavily_key"])
        self.assertFalse(server.public_settings()["search_enabled"])

    def test_search_then_pending_record_and_sources_survive_reload_export(self):
        d = server.date.today().isoformat()
        self.request("POST", "/api/settings", {"tavily_api_key": "tvly-test", "search_enabled": True})
        sid = self.request("POST", "/api/coach/session/create", {"date": d})[1]["session"]["id"]
        first = {"content": json.dumps({"reply": "正在查询", "tool_calls": [
            {"name": "search_web", "arguments": {"query": "中国 鸡蛋 营养"}}]})}
        before = len(server.day_summary(d)["meals"])
        with mock.patch.object(server, "call_model", side_effect=[first, self.model_result()]), \
                mock.patch.object(server, "tavily_search", return_value={"query": "中国 鸡蛋 营养",
                    "retrieved_at": "2026-09-15T12:00:00", "results": [
                    {"title": "营养资料", "url": "https://example.test/nutrition", "content": "每份能量"}]}) as search:
            code, answer = self.request("POST", "/api/agent", {"session_id": sid, "date": d, "question": "查一下早餐鸡蛋并记录"})
        self.assertEqual(code, 200)
        self.assertEqual(search.call_count, 1)
        self.assertEqual(answer["tool_calls"][0]["status"], "pending")
        self.assertEqual(len(server.day_summary(d)["meals"]), before)
        loaded = self.request("GET", "/api/coach/session?id=" + sid)[1]["messages"][-1]
        self.assertEqual(loaded["search_data"]["sources"][0]["url"], "https://example.test/nutrition")
        backup = server.build_export()
        server.apply_import(backup)
        self.assertEqual(server.coach_messages(sid)[1][-1]["search_data"], answer["search_data"])

    def test_explicit_search_connection_test_uses_saved_key(self):
        self.request("POST", "/api/settings", {"tavily_api_key": "tvly-test", "search_enabled": False})
        with mock.patch.object(server, "tavily_search", return_value={"results": []}) as search:
            code, result = self.request("POST", "/api/test_search", {})
        self.assertEqual(code, 200)
        self.assertTrue(result["ok"])
        self.assertEqual(search.call_args.args[0], "tvly-test")

    def test_manual_meal_grams_only_scales_and_preserves_provenance(self):
        d = "2026-01-01"
        code, result = self.request("POST", "/api/meal", {"date":d,"meal_type":"早餐","items":[{
            "name":"测试牛奶","grams":200,"amount":"200g","energy_kj":800,"protein":8,"carb":12,"fat":10,
            "from_label":True,"note":"包装标签","item_source":"agent"}]})
        self.assertEqual(code,200)
        rid=result["today"]["meals"][-1]["id"]
        for grams in (100, 300, 200):
            code, result=self.request("POST","/api/meal/update",{"id":rid,"grams":grams})
            self.assertEqual(code,200)
            item=next(x for x in result["today"]["meals"] if x["id"]==rid)
            self.assertEqual(item["energy_kj"],grams*4)
            self.assertEqual(item["protein"],grams*.04)
            self.assertEqual(item["fat"],grams*.05)
            self.assertEqual(item["carb"],grams*.06)
            self.assertEqual(item["note"],"包装标签")
            self.assertTrue(item["from_label"])
            self.assertEqual(item["item_source"],"agent")
        self.assertEqual(len([x for x in result["today"]["meals"] if x["id"]==rid]),1)
        for _ in range(5):
            self.request("POST","/api/meal/update",{"id":rid,"grams":133.3})
            code,result=self.request("POST","/api/meal/update",{"id":rid,"grams":200})
            item=next(x for x in result["today"]["meals"] if x["id"]==rid)
            self.assertEqual(item["fat"],10)
            self.assertEqual(item["protein"],8)
        code,result=self.request("POST","/api/meal/update",{"id":rid,"grams":100,"kj":450,"protein":9,"carb":5,"fat":2,"scale_nutrients":False})
        self.assertEqual(code,200)
        item=next(x for x in result["today"]["meals"] if x["id"]==rid)
        self.assertEqual(item["energy_kj"],450)
        self.assertEqual(item["protein"],9)
        code,result=self.request("POST","/api/meal/update",{"id":rid,"grams":200})
        item=next(x for x in result["today"]["meals"] if x["id"]==rid)
        self.assertEqual(item["energy_kj"],900)
        self.assertEqual(item["protein"],18)

    def test_manual_exercise_update_keeps_id_and_note(self):
        d="2026-01-02"
        code,result=self.request("POST","/api/exercise",{"date":d,"type":"跑步","minutes":30,"kj":800,"energy_kj":800,"met":7,"note":"跑步机","source":"agent"})
        self.assertEqual(code,200)
        rid=result["today"]["exercises"][-1]["id"]
        code,result=self.request("POST","/api/exercise/update",{"id":rid,"type":"快走","minutes":45,"kj":600,"met":4})
        self.assertEqual(code,200)
        item=next(x for x in result["today"]["exercises"] if x["id"]==rid)
        self.assertEqual(item["energy_kj"],600)
        self.assertEqual(item["type"],"快走")
        self.assertEqual(item["minutes"],45)
        self.assertEqual(item["note"],"跑步机")
        self.assertEqual(item["source"],"agent")

    def test_macro_only_meal_update_recalculates_energy_but_explicit_energy_wins(self):
        d="2026-01-04"
        code,result=self.request("POST","/api/meal",{"date":d,"meal_type":"午餐","items":[{
            "name":"测试食物","grams":100,"energy_kj":500,"protein":10,"carb":10,"fat":5}]})
        self.assertEqual(code,200)
        rid=result["today"]["meals"][-1]["id"]
        code,result=self.request("POST","/api/meal/update",{"id":rid,"protein":20})
        self.assertEqual(code,200)
        item=next(x for x in result["today"]["meals"] if x["id"]==rid)
        self.assertEqual(item["energy_kj"],695)
        code,result=self.request("POST","/api/meal/update",{"id":rid,"fat":6,"kj":777})
        self.assertEqual(code,200)
        item=next(x for x in result["today"]["meals"] if x["id"]==rid)
        self.assertEqual(item["energy_kj"],777)

    def test_invalid_manual_edit_does_not_change_saved_record(self):
        d="2026-01-03"
        code,result=self.request("POST","/api/meal",{"date":d,"meal_type":"午餐","items":[{
            "name":"测试食物","grams":100,"energy_kj":500,"protein":10,"carb":10,"fat":5}]})
        rid=result["today"]["meals"][-1]["id"]
        code,_=self.request("POST","/api/meal/update",{"id":rid,"grams":-100})
        self.assertEqual(code,400)
        item=next(x for x in server.day_summary(d)["meals"] if x["id"]==rid)
        self.assertEqual(item["grams"],100)
        self.assertEqual(item["energy_kj"],500)


class SearchTests(unittest.TestCase):
    def messages(self):
        return [{"role": "system", "content": server.AGENT_SYSTEM}, {"role": "user", "content": "查猪柳蛋麦满分"}]

    def search_reply(self, calls=1):
        return {"content": json.dumps({"reply": "", "tool_calls": [
            {"name": "search_web", "arguments": {"query": "猪柳蛋麦满分 营养 " + str(i)}} for i in range(calls)]})}

    def meal_reply(self, name="食其家烧肉饭", kj=2700, protein=25, carb=85, fat=22):
        return {"content": json.dumps({"reply": "请确认记录", "tool_calls": [{
            "name": "log_meal", "arguments": {"meal_type": "午餐", "items": [{
                "name": name, "amount": "正常份，饭剩30%", "grams": 350, "kj": kj,
                "protein": protein, "carb": carb, "fat": fat, "confidence": 0.6,
                "from_label": False, "note": "估算",
            }]},
        }]}, ensure_ascii=False)}

    def test_off_never_calls_tavily_or_advertises_search(self):
        with mock.patch.object(server, "call_model", return_value={"content": '{"reply":"估算","tool_calls":[]}'}) as model, \
                mock.patch.object(server, "tavily_search") as search:
            _, data = server.run_agent_model("url", "key", "model", self.messages(), {"search_enabled": False,"tavily_api_key":"key"})
        self.assertIsNone(data)
        search.assert_not_called()
        self.assertNotIn("search_web", model.call_args.kwargs["json_schema"]["properties"]["tool_calls"]["items"]["properties"]["name"]["enum"])

    def test_off_rejects_unexpected_search_call_without_network(self):
        with mock.patch.object(server, "call_model", return_value=self.search_reply()), mock.patch.object(server, "tavily_search") as search:
            with self.assertRaises(server.ApiError):
                server.run_agent_model("url", "key", "model", self.messages(), {})
        search.assert_not_called()

    def test_on_normal_coaching_does_not_search(self):
        with mock.patch.object(server, "call_model", return_value={"content": '{"reply":"你好","tool_calls":[]}'}) as model, mock.patch.object(server, "tavily_search") as search:
            messages = [{"role": "system", "content": server.AGENT_SYSTEM}, {"role": "user", "content": "你好"}]
            server.run_agent_model("url", "key", "model", messages, {"search_enabled":True,"tavily_api_key":"tvly"})
        self.assertEqual(model.call_count, 1)
        search.assert_not_called()

    def test_server_forces_search_when_branded_meal_model_skips_it(self):
        messages = [{"role":"system","content":server.AGENT_SYSTEM},
                    {"role":"user","content":"今天吃了中国大陆食其家烧肉饭，饭剩30%，帮我记录"}]
        reply = self.meal_reply()
        with mock.patch.object(server, "call_model", side_effect=[reply, reply]) as model, \
                mock.patch.object(server, "tavily_search", return_value={
                    "results": [{"title":"中国食其家","url":"https://www.zensho.com.cn/brand.html","content":"烧肉丼"}],
                    "retrieved_at":"now"}) as search:
            out, data = server.run_agent_model("url", "key", "model", messages,
                                               {"search_enabled":True,"tavily_api_key":"tvly"})
        self.assertEqual(model.call_count, 2)
        self.assertEqual(search.call_count, 1)
        self.assertIn("中国大陆", search.call_args.args[1])
        self.assertIn("食其家烧肉饭", search.call_args.args[1])
        self.assertEqual(data["status"], "done")
        self.assertIn("log_meal", out["content"])

    def test_server_retries_internally_inconsistent_meal(self):
        bad = self.meal_reply(kj=4200, protein=32, carb=105, fat=22)
        good = self.meal_reply(kj=3150, protein=32, carb=105, fat=22)
        with mock.patch.object(server, "call_model", side_effect=[bad, good]) as model:
            out, data = server.run_agent_model("url", "key", "model",
                                               [{"role":"system","content":server.AGENT_SYSTEM},
                                                {"role":"user","content":"午餐吃了烧肉饭"}],
                                               {"search_enabled":False,"tavily_api_key":""})
        self.assertEqual(model.call_count, 2)
        self.assertIsNone(data)
        self.assertIn("3150", out["content"])
        self.assertIn("程序质量审查未通过", model.call_args.args[3][-1]["content"])

    def test_explicit_intake_cannot_end_in_an_empty_promise(self):
        empty = {"content": json.dumps({"reply": "请确认数量，我再整理", "tool_calls": []})}
        good = self.meal_reply(name="冬枣", kj=170, protein=.4, carb=9, fat=.1)
        with mock.patch.object(server, "call_model", side_effect=[empty, good]) as model:
            out, _ = server.run_agent_model("url", "key", "model", self.messages(), {"_meal_draft_required": True})
        self.assertEqual(model.call_count, 2)
        self.assertIn("log_meal", out["content"])

    def test_nutrition_repair_cannot_discard_the_pending_meal(self):
        bad = self.meal_reply(name="冬枣", kj=90, protein=.4, carb=9, fat=.1)
        empty = {"content": json.dumps({"reply": "90 kJ 与9克碳水自洽，请称重", "tool_calls": []})}
        good = self.meal_reply(name="冬枣", kj=170, protein=.4, carb=9, fat=.1)
        with mock.patch.object(server, "call_model", side_effect=[bad, empty, good]) as model:
            out, _ = server.run_agent_model("url", "key", "model", self.messages(), {})
        self.assertEqual(model.call_count, 3)
        self.assertIn("log_meal", out["content"])
        self.assertFalse(server._agent_meal_quality_issues(json.loads(out["content"])))

    def test_missing_tool_retry_is_bounded_and_does_not_report_success(self):
        empty = {"content": '{"reply":"稍后记录","tool_calls":[]}'}
        with mock.patch.object(server, "call_model", return_value=empty) as model:
            with self.assertRaisesRegex(server.ApiError, "未生成待确认饮食记录"):
                server.run_agent_model("url", "key", "model", self.messages(), {"_meal_draft_required": True})
        self.assertEqual(model.call_count, 3)

    def test_unrecognizable_food_can_still_ask_for_its_identity(self):
        unclear = {"content": json.dumps({"reply": "照片太模糊，是哪种食物？", "tool_calls": [], "clarification": "food_identity"})}
        with mock.patch.object(server, "call_model", return_value=unclear) as model:
            out, _ = server.run_agent_model("url", "key", "model", self.messages(), {"_meal_draft_required": True})
        self.assertEqual(model.call_count, 1)
        self.assertEqual(json.loads(out["content"])["tool_calls"], [])

    def test_failed_search_does_not_interrupt_chat(self):
        with mock.patch.object(server, "call_model", side_effect=[self.search_reply(), {"content": '{"reply":"搜索失败，以下是估算","tool_calls":[]}'}]) as model, \
                mock.patch.object(server, "tavily_search", side_effect=server.ApiError("Tavily 额度已用完")):
            out, data = server.run_agent_model("url", "key", "model", self.messages(), {"search_enabled":True,"tavily_api_key":"tvly"})
        self.assertIn("估算", out["content"])
        self.assertEqual(data["status"], "failed")
        self.assertIn("额度已用完", model.call_args.args[3][-1]["content"])

    def test_search_budget_is_two_and_final_schema_excludes_search(self):
        with mock.patch.object(server, "call_model", side_effect=[self.search_reply(4), {"content": '{"reply":"结果","tool_calls":[]}'}]) as model, \
                mock.patch.object(server, "tavily_search", return_value={"results":[],"retrieved_at":"now"}) as search:
            server.run_agent_model("url", "key", "model", self.messages(), {"search_enabled":True,"tavily_api_key":"tvly"})
        self.assertEqual(search.call_count, 2)
        names=model.call_args.kwargs["json_schema"]["properties"]["tool_calls"]["items"]["properties"]["name"]["enum"]
        self.assertNotIn("search_web",names)
        self.assertIn("query_records",names)

    def test_tavily_request_and_source_filtering(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"results":[
            {"title":"official","url":"https://example.test/food","content":"nutrition"},
            {"url":"javascript:alert(1)"}]}).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(server.urllib.request, "build_opener", return_value=opener):
            result = server.tavily_search("tvly-secret", "猪柳蛋麦满分")
        req = opener.open.call_args.args[0]
        self.assertEqual(req.full_url, "https://api.tavily.com/search")
        self.assertEqual(req.get_header("Authorization"), "Bearer tvly-secret")
        self.assertEqual(json.loads(req.data)["search_depth"], "advanced")
        self.assertEqual(len(result["results"]), 1)
        self.assertNotIn("tvly-secret", json.dumps(result))

    def test_provider_error_is_localized_and_key_not_exposed(self):
        opener = mock.Mock()
        opener.open.side_effect = server.urllib.error.HTTPError("url",432,"tvly-secret",{},None)
        with mock.patch.object(server.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(server.ApiError, "额度已用完") as err:
                server.tavily_search("tvly-secret", "food")
        self.assertNotIn("tvly-secret", str(err.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
