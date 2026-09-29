"""Real HTTP confirmation, bounded reads and atomic record management."""
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
import server


class ManagementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv=server.ReuseServer(('127.0.0.1',0),server.Handler)
        cls.port=cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.old_db=server.DB_PATH
        server.DB_PATH=str(Path(tempfile.mkdtemp())/'management.db')
        server.init_db()
        with server.db() as c:
            c.execute("UPDATE settings SET api_key='model-test-key' WHERE id=1")
        self.token=self.request('GET','/api/state')[1]['session_token']
        self.d=server.date.today().isoformat()
        with server.db() as c:
            server.insert_meal_row(c,self.d,'午餐',server.validate_meal_items([{
                'name':'牛奶','grams':200,'amount':'200g','kj':800,'protein':8,'carb':12,'fat':10,'note':'包装标签','from_label':True}])[0],'','agent',self.now())
            self.mid=c.execute('SELECT last_insert_rowid()').fetchone()[0]
            server.insert_ex_row(c,self.d,server.validate_ex_items([{'type':'跑步','minutes':30,'met':6,'kj':900,'note':'跑步机'}],70)[0],self.now())
            self.eid=c.execute('SELECT last_insert_rowid()').fetchone()[0]
            c.execute('INSERT INTO weights(date,weight,note) VALUES(?,?,?)',(self.d,70,'早起'))
            self.wid=c.execute('SELECT last_insert_rowid()').fetchone()[0]

    def tearDown(self):
        server.DB_PATH=self.old_db

    def now(self):
        return server.datetime.now().isoformat(timespec='seconds')

    def request(self,method,path,body=None):
        conn=HTTPConnection('127.0.0.1',self.port,timeout=5)
        headers={'Host':'127.0.0.1:%d'%self.port,'Connection':'close'}
        raw=None
        if body is not None:
            raw=json.dumps(body).encode()
            headers.update({'Content-Type':'application/json','X-FitAI-Token':self.token})
        conn.request(method,path,body=raw,headers=headers)
        resp=conn.getresponse();out=json.loads(resp.read());code=resp.status;conn.close()
        return code,out

    def propose(self,name,args):
        sid=self.request('POST','/api/coach/session/create',{'date':self.d})[1]['session']['id']
        out={'content':json.dumps({'reply':'请确认这些操作','tool_calls':[{'name':name,'arguments':args}]})}
        with mock.patch.object(server,'call_model',return_value=out):
            code,answer=self.request('POST','/api/agent',{'session_id':sid,'date':self.d,'question':'管理我的记录'})
        self.assertEqual(code,200,answer)
        return sid,answer

    def confirm(self,sid,answer,**extra):
        return self.request('POST','/api/agent/tool',{'session_id':sid,'message_id':answer['message_id'],'call_id':answer['tool_calls'][0]['id'],**extra})

    def test_meal_update_pending_then_scale_and_preserve_source(self):
        sid,answer=self.propose('update_meal',{'id':self.mid,'changes':{'grams':100}})
        call=answer['tool_calls'][0]
        self.assertEqual(call['before']['grams'],200)
        self.assertEqual(call['after']['protein'],4)
        self.assertEqual(server.day_summary(self.d)['meals'][0]['grams'],200)
        code,result=self.confirm(sid,answer)
        self.assertEqual(code,200,result)
        meal=server.day_summary(self.d)['meals'][0]
        self.assertEqual(meal['energy_kj'],400)
        self.assertEqual(meal['id'],self.mid)
        self.assertEqual(meal['note'],'包装标签')
        self.assertTrue(meal['from_label'])
        self.assertEqual(self.confirm(sid,answer)[0],409)

    def test_delete_and_restore_every_kind(self):
        for kind,rid in [('meal',self.mid),('exercise',self.eid),('weight',self.wid)]:
            sid,answer=self.propose('delete_'+kind,{'id':rid})
            self.assertEqual(self.confirm(sid,answer)[0],200)
            active=server.execute_agent_read('query_records',{'kind':kind},self.d)['records']
            self.assertEqual(active,[])
            deleted=server.execute_agent_read('query_records',{'kind':kind,'deleted':True},self.d)['records']
            self.assertEqual(deleted[0]['id'],rid)
            sid,answer=self.propose('restore_record',{'kind':kind,'id':rid})
            self.assertEqual(self.confirm(sid,answer)[0],200)
            self.assertEqual(server.execute_agent_read('query_records',{'kind':kind},self.d)['records'][0]['id'],rid)

    def test_exercise_and_weight_updates(self):
        sid,answer=self.propose('update_exercise',{'id':self.eid,'changes':{'minutes':60}})
        self.assertEqual(answer['tool_calls'][0]['after']['energy_kj'],1800)
        self.assertEqual(self.confirm(sid,answer)[0],200)
        sid,answer=self.propose('update_weight',{'id':self.wid,'changes':{'weight':69.5}})
        self.assertEqual(self.confirm(sid,answer)[0],200)
        self.assertEqual(server.resolve_weight(self.d)['calc_weight'],69.5)

    def test_macro_only_update_preview_and_confirmation_recalculate_energy(self):
        sid,answer=self.propose('update_meal',{'id':self.mid,'changes':{'protein':9}})
        self.assertEqual(answer['tool_calls'][0]['after']['energy_kj'],727)
        self.assertEqual(self.confirm(sid,answer)[0],200)
        self.assertEqual(server.day_summary(self.d)['meals'][0]['energy_kj'],727)

    def test_atomic_replace_deletes_old_and_adds_correct_items(self):
        args={'operations':[{'name':'delete_meal','arguments':{'id':self.mid}},
                           {'name':'log_meal','arguments':{'date':self.d,'meal_type':'午餐','items':[
                               {'name':'卤豆干','amount':'40g','grams':40,'kj':300,'protein':5,'carb':4,'fat':2,'from_label':True}]}}]}
        sid,answer=self.propose('manage_records',args)
        self.assertEqual(server.day_summary(self.d)['meals'][0]['name'],'牛奶')
        self.assertEqual(self.confirm(sid,answer)[0],200)
        meals=server.day_summary(self.d)['meals']
        self.assertEqual(len(meals),1)
        self.assertEqual(meals[0]['name'],'卤豆干')
        self.assertEqual(self.confirm(sid,answer)[0],409)

    def test_atomic_failure_rolls_back_earlier_deletion(self):
        sid,answer=self.propose('manage_records',{'operations':[
            {'name':'delete_meal','arguments':{'id':self.mid}},
            {'name':'update_exercise','arguments':{'id':self.eid,'changes':{'minutes':60}}}]})
        with server.db() as c:
            c.execute("UPDATE exercises SET note='手动已修改' WHERE id=?",(self.eid,))
        self.assertEqual(self.confirm(sid,answer)[0],409)
        self.assertEqual(len(server.day_summary(self.d)['meals']),1)
        with server.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM trash').fetchone()[0],0)

    def test_stale_and_retargeted_confirmations_are_rejected(self):
        sid,answer=self.propose('delete_meal',{'id':self.mid})
        self.assertEqual(self.confirm(sid,answer,arguments={'id':999,'date':self.d})[0],409)
        with server.db() as c:
            c.execute('UPDATE meals SET grams=150 WHERE id=?',(self.mid,))
        self.assertEqual(self.confirm(sid,answer)[0],409)
        self.assertEqual(len(server.day_summary(self.d)['meals']),1)

    def test_reject_does_not_mutate_records(self):
        sid,answer=self.propose('delete_exercise',{'id':self.eid})
        self.assertEqual(self.confirm(sid,answer,decision='reject')[0],200)
        self.assertEqual(len(server.day_summary(self.d)['exercises']),1)

    def test_manual_delete_and_undo_food_and_exercise(self):
        for kind,rid in [('meal',self.mid),('exercise',self.eid)]:
            code,result=self.request('POST','/api/'+kind+'/delete',{'id':rid,'date':self.d})
            self.assertEqual(code,200)
            self.assertEqual(result['undo'],{'kind':kind,'id':rid})
            self.assertEqual(server.execute_agent_read('query_records',{'kind':kind},self.d)['records'],[])
            self.assertEqual(self.request('POST','/api/'+kind+'/delete',{'id':rid,'date':self.d})[0],400)
            self.assertEqual(self.request('POST','/api/restore',{'kind':kind,'id':rid,'date':self.d})[0],200)
            self.assertEqual(server.execute_agent_read('query_records',{'kind':kind},self.d)['records'][0]['id'],rid)

    def test_queries_history_pagination_and_summary_have_real_ids(self):
        with server.db() as c:
            c.execute("UPDATE meals SET date='2026-01-01' WHERE id=?",(self.mid,))
        result=server.execute_agent_read('query_records',{'kind':'meal','start_date':'2026-01-01','end_date':self.d,'keyword':'牛奶'},self.d)
        self.assertEqual(result['records'][0]['id'],self.mid)
        result=server.execute_agent_read('query_records',{'limit':1},self.d)
        self.assertTrue(result['has_more'])
        summary=server.execute_agent_read('get_day_summary',{'date':self.d},self.d)
        self.assertEqual(summary['当前日期记录明细']['exercises'][0]['id'],self.eid)

    def test_model_reads_history_then_generates_pending_management(self):
        first={'content':json.dumps({'reply':'查询中','tool_calls':[{'name':'query_records','arguments':{'kind':'meal'}}]})}
        second={'content':json.dumps({'reply':'请确认删除','tool_calls':[{'name':'delete_meal','arguments':{'id':self.mid}}]})}
        settings=server.get_settings();settings['_record_date']=self.d
        with mock.patch.object(server,'call_model',side_effect=[first,second]) as model:
            out,_=server.run_agent_model('url','key','model',[{'role':'system','content':server.AGENT_SYSTEM},{'role':'user','content':'删除牛奶'}],settings)
        self.assertEqual(model.call_count,2)
        self.assertIn('牛奶',model.call_args.args[3][-1]['content'])
        self.assertEqual(server.parse_agent_output(out['content'],self.d)['tool_calls'][0]['name'],'delete_meal')
        self.assertEqual(len(server.day_summary(self.d)['meals']),1)

    def test_unknown_id_invalid_fields_and_nested_batch_are_rejected(self):
        for name,args in [('delete_meal',{'id':999}),('update_meal',{'id':self.mid,'changes':{'source':'evil'}}),('delete_meal',{'id':1.5}),('manage_records',{'operations':[{'name':'manage_records','arguments':{'operations':[]}}]})]:
            with self.assertRaises(server.ApiError):
                server.normalize_agent_tool_call({'name':name,'arguments':args},self.d)

    def test_weight_restore_never_overwrites_new_weight_on_same_date(self):
        sid,answer=self.propose('delete_weight',{'id':self.wid})
        self.assertEqual(self.confirm(sid,answer)[0],200)
        with server.db() as c:
            c.execute('INSERT INTO weights(date,weight,note) VALUES(?,?,?)',(self.d,68,'新数据'))
        with self.assertRaises(server.ApiError):
            server.normalize_agent_tool_call({'name':'restore_record','arguments':{'kind':'weight','id':self.wid}},self.d)
