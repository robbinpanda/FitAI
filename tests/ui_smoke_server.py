"""Optional UI QA server: isolated temporary data, no real records or API keys.

Run `python -B tests/ui_smoke_server.py`, open the printed local URL, then Ctrl+C.
"""
import sys
import json
import time
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def main():
    with tempfile.TemporaryDirectory(prefix="fitai-ui-qa-") as folder:
        server.DB_PATH = str(Path(folder) / "qa.db")
        server.init_db()
        server.save_profile({"completed": True})
        if "--demo-stream" in sys.argv:
            # Synthetic key and model are limited to this temporary QA process.
            with server.db() as c:
                c.execute("UPDATE settings SET api_key='qa-only',text_model='本地模拟模型' WHERE id=1")
            def demo_model(*args, **kwargs):
                callback = kwargs.get("on_delta")
                kj, protein, carb, fat = server.food_per_100g("米饭")
                content = json.dumps({"reply":"我已按 200g 熟米饭整理了待确认记录。请核对实际吃下的份量；确认之后才会保存。",
                    "tool_calls":[{"name":"log_meal","arguments":{"date":server.date.today().isoformat(),
                    "meal_type":"午餐","items":[{"name":"米饭","grams":200,"amount":"200g",
                    "kj":kj*2,"protein":protein*2,"carb":carb*2,"fat":fat*2,"note":"熟重，可食部分；模拟测试数据"}]}}]}, ensure_ascii=False)
                if callback:
                    callback("reset", None)
                    for start in range(0,len(content),3):
                        callback("content",content[start:start+3])
                        time.sleep(.04)
                return {"content":content,"reasoning":""}
            server.call_model = demo_model
        with server.db() as c:
            c.execute("INSERT INTO weights(date,weight,note) VALUES(?,?,?)", (server.date.today().isoformat(), 70, "Synthetic UI QA"))
            if "--demo-trend" in sys.argv:
                for days, weight in [(13,71.2),(11,70.8),(8,71.0),(6,70.5),(3,70.3),(1,70.1)]:
                    d = (server.date.today()-server.timedelta(days=days)).isoformat()
                    c.execute("INSERT INTO weights(date,weight,note) VALUES(?,?,?)", (d,weight,"Synthetic trend QA"))
        http = server.ReuseServer(("127.0.0.1", 0), server.Handler)
        print("UI_QA_URL=http://127.0.0.1:%d/" % http.server_address[1], flush=True)
        try:
            http.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            http.server_close()


if __name__ == "__main__":
    main()
