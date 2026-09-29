"""Local console administration. Secrets are read from a hidden prompt."""
import argparse
import getpass
import os
import json
from pathlib import Path

import security


def main():
    parser = argparse.ArgumentParser(description="渐渐飞 account / invitation administration")
    parser.add_argument("command", choices=["invite", "close-registration", "users", "reset-password", "export-legacy"])
    parser.add_argument("--data-dir", default=os.environ.get("FITAI_DATA_DIR", "data"))
    parser.add_argument("--uses", type=int, default=5)
    parser.add_argument("--username")
    parser.add_argument("--output", default="legacy-export.json")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "export-legacy":
        import server
        source = Path(args.data_dir).resolve() / "fitai.db"
        if not source.is_file():
            parser.error("旧版 fitai.db 不存在")
        server.DB_PATH = str(source)
        server.init_db()
        # Exclusive create protects a previously exported backup from overwrite.
        with open(args.output, "x", encoding="utf-8") as output:
            json.dump(server.build_export(), output, ensure_ascii=False)
        print("旧版数据已导出（不含 API Key）：", args.output)
        return
    accounts = security.Accounts(args.data_dir)
    if args.command == "invite":
        if not 1 <= args.uses <= 1000:
            parser.error("--uses must be 1..1000")
        value = getpass.getpass("设置新邀请码（至少 16 字符，建议密码管理器随机生成）: ")
        if not 16 <= len(value) <= 128:
            parser.error("邀请码必须为 16–128 个字符")
        if value != getpass.getpass("再次输入邀请码: "):
            parser.error("两次输入不一致")
        with accounts.connect() as c:
            c.execute("INSERT OR REPLACE INTO config VALUES('invite_hash',?)", (security.password_hash(value),))
            c.execute("INSERT OR REPLACE INTO config VALUES('invite_remaining',?)", (str(args.uses),))
        print("邀请码已更新；旧邀请码立即失效。可用次数：", args.uses)
    elif args.command == "close-registration":
        with accounts.connect() as c:
            c.execute("INSERT OR REPLACE INTO config VALUES('invite_remaining','0')")
        print("服务器注册已关闭（不影响现有用户登录）。")
    elif args.command == "users":
        with accounts.connect() as c:
            for row in c.execute("SELECT username,id FROM users ORDER BY created"):
                print(row[0], row[1])
            row = c.execute("SELECT value FROM config WHERE key='invite_remaining'").fetchone()
            print("邀请码剩余次数:", row[0] if row else 0)
    else:
        name = args.username or input("用户名: ")
        name, password = security.credentials({"username": name, "password": getpass.getpass("新密码: ")})
        if password != getpass.getpass("再次输入新密码: "):
            parser.error("两次输入不一致")
        with accounts.connect() as c:
            row = c.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
            if not row:
                parser.error("用户不存在")
            c.execute("UPDATE users SET password=? WHERE id=?", (security.password_hash(password), row[0]))
            c.execute("DELETE FROM sessions WHERE uid=?", (row[0],))
        print("密码已更新，该用户所有登录会话已注销。")


if __name__ == "__main__":
    main()
