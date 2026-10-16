"""Monthly record counts use actual, undeleted records, including zero energy."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import server


class HistoryHeatmapTests(unittest.TestCase):
    def test_counts_and_calendar_boundaries(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(server, 'DB_PATH', str(Path(folder) / 'history.db')):
            server.init_db()
            with server.db() as conn:
                conn.execute("UPDATE profile SET start_weight=75 WHERE id=1")
                conn.execute("INSERT INTO weights(date,weight) VALUES('2024-02-28',70)")
                conn.execute("INSERT INTO meals(date,name,kcal) VALUES('2024-02-29','one',0)")
                conn.execute("INSERT INTO meals(date,name,kcal) VALUES('2024-02-29','two',100)")
                conn.execute("INSERT INTO meals(date,name,kcal,deleted_at) VALUES('2024-02-29','deleted',100,'2024-03-01')")
                conn.execute("INSERT INTO exercises(date,type,kcal) VALUES('2024-02-29','zero energy',0)")
                conn.execute("INSERT INTO exercises(date,type,kcal,deleted_at) VALUES('2024-02-29','deleted',100,'2024-03-01')")
                conn.execute("INSERT INTO meals(date,name,kcal) VALUES('2024-03-01','outside',100)")
            rows = server.history(29, '2024-02-29')
            self.assertEqual(len(rows), 29)
            self.assertEqual(rows[0]['date'], '2024-02-01')
            self.assertEqual(rows[0]['record_counts'], dict(meal=0, exercise=0, weight=0))
            self.assertEqual(rows[-2]['record_counts'], dict(meal=0, exercise=0, weight=1))
            self.assertEqual(rows[-1]['record_counts'], dict(meal=2, exercise=1, weight=0))
            self.assertEqual(rows[-1]['intake'], 100)
            self.assertEqual(rows[-1]['exercise'], 0)
            self.assertEqual(rows[-1]['weight_source'], 'last_measured')


if __name__ == '__main__':
    unittest.main()
