"""Streaming and nutrition checks with an isolated database and no external API."""
import json
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ReplyDecoderTests(unittest.TestCase):
    def test_every_boundary_including_escaped_unicode(self):
        reply = '你好，"份量"\n半碗米饭 🥣'
        raw = json.dumps({'reply': reply, 'tool_calls': []}, ensure_ascii=True)
        for i in range(len(raw) + 1):
            partial = server.partial_agent_reply(raw[:i])
            self.assertTrue(reply.startswith(partial), (i, partial))
        self.assertEqual(server.partial_agent_reply(raw), reply)

    def test_nested_reply_is_never_exposed(self):
        raw = '{"tool_calls":[{"arguments":{"reply":"secret"}}],"reply":"你好"}'
        self.assertEqual(server.partial_agent_reply(raw), '你好')
        self.assertEqual(server.partial_agent_reply(raw[:45]), '')

    def test_reasoning_and_json_are_not_sent_to_ui(self):
        events = []
        def model(*args, **kwargs):
            delta = kwargs['on_delta']
            delta('reasoning', 'private reasoning')
            delta('content', '{"reply":"中文')
            delta('content', '回复","tool_calls":[]}')
            return {'content': '{"reply":"中文回复","tool_calls":[]}'}
        with mock.patch.object(server, 'call_model', side_effect=model):
            server.run_agent_model('', '', '', [{'role':'system','content':''}], {},
                                   on_event=lambda kind,data: events.append((kind,data)))
        self.assertIn(('reply', {'text':'中文'}), events)
        self.assertIn(('reply', {'text':'中文回复'}), events)
        self.assertNotIn('private reasoning', str(events))


class NutritionQualityTests(unittest.TestCase):
    def payload(self, **changes):
        return {'tool_calls':[{'name':'log_meal','arguments':{'items':[
            dict(name='测试食物', grams=100, kj=370, protein=0, carb=0, fat=10, **changes)
        ]}}]}

    def test_mass_validation_also_applies_to_labels_and_batches(self):
        item = {'name':'测试食物','grams':10,'kj':3700,'protein':0,'carb':0,'fat':100,'from_label':True}
        payload = {'tool_calls':[{'name':'manage_records','arguments':{'operations':[
            {'name':'log_meal','arguments':{'items':[item]}}
        ]}}]}
        self.assertTrue(any('总质量' in x for x in server._agent_meal_quality_issues(payload)))

    def test_missing_or_negative_macros_are_not_silently_zeroed(self):
        for value in (None, -1, 'unknown', float('nan')):
            payload = self.payload()
            payload['tool_calls'][0]['arguments']['items'][0]['protein'] = value
            self.assertTrue(server._agent_meal_quality_issues(payload))

    def test_missing_grams_does_not_become_100g(self):
        payload = self.payload()
        del payload['tool_calls'][0]['arguments']['items'][0]['grams']
        self.assertTrue(any('克重' in x for x in server._agent_meal_quality_issues(payload)))

    def test_grounding_is_exact_and_confirmation_keeps_user_edits(self):
        d = server.date.today().isoformat()
        call = {'name':'log_meal','arguments':{'date':d,'meal_type':'午餐','items':[
            {'name':'米饭','grams':200,'kj':100,'protein':1,'carb':1,'fat':1}
        ]}}
        parsed = server.parse_agent_output(json.dumps({'reply':'待确认','tool_calls':[call]}), d)
        item = parsed['tool_calls'][0]['arguments']['items'][0]
        self.assertEqual(item['energy_kj'], round(server.food_per_100g('米饭')[0] * 2, 1))
        item['kj'] = item['energy_kj'] = 999
        confirmed = server.normalize_agent_tool_call(parsed['tool_calls'][0], d)
        self.assertEqual(confirmed['arguments']['items'][0]['energy_kj'], 999)
        for name, label in [('番茄炒蛋',False), ('某品牌米饭',False), ('米饭',True)]:
            candidate = {'name':name,'grams':200,'kj':100,'protein':1,'carb':1,'fat':1,'from_label':label}
            server._ground_agent_calls([{'name':'log_meal','arguments':{'items':[candidate]}}])
            self.assertEqual(candidate['kj'], 100)


class StreamingHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = server.DB_PATH
        server.DB_PATH = str(Path(self.tmp.name) / 'qa.db')
        server.init_db()
        with server.db() as c:
            c.execute("UPDATE settings SET api_key='synthetic' WHERE id=1")
            c.execute("INSERT INTO coach_sessions(id,date,title,created_at,updated_at) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'新对话',?,?)",
                      (server.date.today().isoformat(), '2026-09-18T12:00:00', '2026-09-18T12:00:00'))
        self.http = server.ReuseServer(('127.0.0.1',0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        server.DB_PATH = self.old_db
        self.tmp.cleanup()

    def connect(self, **extra):
        conn = HTTPConnection('127.0.0.1', self.http.server_address[1], timeout=5)
        conn.request('POST', '/api/agent', json.dumps(dict(session_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',question='测试流式',stream=True,**extra)),
                     {'Content-Type':'application/json','X-FitAI-Token':server.SESSION_TOKEN})
        return conn, conn.getresponse()

    def test_first_event_arrives_before_model_completes_then_done_is_saved(self):
        entered, release = threading.Event(), threading.Event()
        def model(*args, **kwargs):
            entered.set()
            release.wait(4)
            kwargs['on_event']('reply', {'text':'实时中文'})
            return {'content':'{"reply":"实时中文","tool_calls":[]}'}, None
        with mock.patch.object(server, 'run_agent_model', side_effect=model):
            conn, response = self.connect()
            try:
                self.assertEqual(response.status, 200)
                self.assertIn('event-stream', response.getheader('Content-Type'))
                self.assertEqual(response.readline().decode().strip(), 'event: status')
                self.assertTrue(entered.wait(2))
                with server.db() as c:
                    self.assertEqual(c.execute('SELECT count(*) FROM coach_messages').fetchone()[0], 0)
            finally:
                release.set()
            body = response.read().decode()
            conn.close()
        self.assertIn('event: reply', body)
        self.assertIn('event: done', body)
        with server.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM coach_messages').fetchone()[0], 2)

    def test_model_failure_sends_sse_error_without_saving_messages(self):
        with mock.patch.object(server, 'run_agent_model', side_effect=RuntimeError('模拟模型失败')):
            conn, response = self.connect()
            body = response.read().decode()
            conn.close()
        self.assertIn('event: error', body)
        self.assertNotIn('event: done', body)
        with server.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM coach_messages').fetchone()[0], 0)

    def test_validation_errors_remain_regular_http_errors(self):
        conn, response = self.connect(images=['invalid-image'])
        self.assertEqual(response.status, 400)
        self.assertIn('application/json', response.getheader('Content-Type'))
        response.read()
        conn.close()


if __name__ == '__main__':
    unittest.main()
