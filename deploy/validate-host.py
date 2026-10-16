"""Run on the ECS as root: validate nginx template and the latest offline backup.

Does not start a public listener, read user credentials, or overwrite live data.
"""
import pathlib
import sqlite3
import subprocess
import tarfile
import tempfile

root = pathlib.Path('/opt/fitai')
with tempfile.TemporaryDirectory(prefix='fitai-validation-') as temporary:
    folder = pathlib.Path(temporary)
    key, cert = folder / 'key.pem', folder / 'cert.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(key), '-out', str(cert), '-days', '1',
                    '-subj', '/CN=fitai.example.com'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy = folder / 'proxy.conf'
    proxy.write_text((root / 'deploy/fitai-proxy.conf').read_text())
    config = (root / 'deploy/nginx.conf').read_text()
    config = config.replace('/etc/letsencrypt/live/fitai.example.com/fullchain.pem', str(cert))
    config = config.replace('/etc/letsencrypt/live/fitai.example.com/privkey.pem', str(key))
    config = config.replace('/etc/nginx/snippets/fitai-proxy.conf', str(proxy))
    path = folder / 'nginx.conf'
    path.write_text('error_log stderr;\nevents {}\nhttp { access_log off;\n' + config + '\n}\n')
    subprocess.run(['nginx', '-t', '-c', str(path)], check=True)
    print('NGINX_TEMPLATE_OK (temporary certificate; no listener started)')

    backups = sorted(pathlib.Path('/var/backups/fitai').glob('fitai-*.tar.gz'))
    if not backups:
        raise SystemExit('No backup available')
    restored = folder / 'restore'
    restored.mkdir()
    with tarfile.open(backups[-1]) as archive:
        archive.extractall(restored, filter='data')
    for database in restored.rglob('*.db'):
        with sqlite3.connect(str(database)) as connection:
            assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    print('BACKUP_RESTORE_INTEGRITY_OK', backups[-1].name)
