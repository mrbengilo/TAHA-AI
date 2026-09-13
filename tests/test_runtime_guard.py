import copy
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('guard', Path(__file__).resolve().parents[1] / 'deploy/vps/runtime-guard.py')
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.item = {'Id': 'a' * 64, 'Config': {'Image': 'tahashoes-taha-ai:' + 'b' * 40},
                     'State': {'Running': True, 'OOMKilled': True, 'StartedAt': 'fixed', 'Pid': 222}}
        self.state = {'attempts': [], 'blocked': False}
        self.now = 10000

    def decide(self, statuses=None, listener=False, item=None, state=None):
        return g.decision(item or self.item, [0,0,0] if statuses is None else statuses,
                          listener, self.state if state is None else state, self.now)

    def test_healthy_never_restarted(self):
        self.assertEqual(self.decide([200,200,200]), 'healthy')

    def test_dead_oom_eligible(self):
        self.assertEqual(self.decide(), 'recover')

    def test_auth_errors_not_restarted(self):
        for status in [301,302,401,403,404,429,500,502,503]:
            with self.subTest(status=status):
                self.assertNotEqual(self.decide([0,status,0]), 'recover')

    def test_transient_failure_not_restarted(self):
        self.assertNotEqual(self.decide([0,200,0]), 'recover')
        self.assertNotEqual(self.decide([0,0]), 'recover')

    def test_listener_prevents_recovery(self):
        self.assertEqual(self.decide(listener=True), 'not-confirmed-oom')

    def test_non_oom_refused(self):
        self.item['State']['OOMKilled'] = False
        self.assertEqual(self.decide(), 'not-confirmed-oom')

    def test_stopped_container_not_started(self):
        self.item['State']['Running'] = False
        self.assertEqual(self.decide(), 'not-confirmed-oom')

    def test_failure_latch(self):
        self.state['blocked'] = True
        self.assertEqual(self.decide(), 'recovery-latched')

    def test_cooldown(self):
        self.state['attempts'] = [self.now - 599]
        self.assertEqual(self.decide(), 'recovery-rate-limited')

    def test_hourly_limit(self):
        self.state['attempts'] = [self.now - 3500, self.now - 900]
        self.assertEqual(self.decide(), 'recovery-rate-limited')

    def test_expired_attempts_dropped(self):
        self.state['attempts'] = [self.now-7200, self.now-3601]
        self.assertEqual(self.decide(), 'recover')

    def test_db_leases_and_unknown_leases(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            db = sqlite3.connect(root/'test.sqlite')
            db.executescript('CREATE TABLE publish_jobs(status TEXT,lease_expires_at INTEGER); CREATE TABLE automation_steps(status TEXT,lease_expires_at INTEGER);')
            self.assertFalse(g.database_busy(root, 1000))
            for table,status in [('publish_jobs','publishing'),('automation_steps','processing')]:
                db.execute(f'INSERT INTO {table} VALUES (?, ?)', (status, 1001)); db.commit()
                self.assertTrue(g.database_busy(root, 1000))
                db.execute(f'UPDATE {table} SET lease_expires_at=999'); db.commit()
                self.assertFalse(g.database_busy(root, 1000))
                db.execute(f'UPDATE {table} SET lease_expires_at=NULL'); db.commit()
                self.assertTrue(g.database_busy(root, 1000))
                db.execute(f'DELETE FROM {table}'); db.commit()
            db.close()

    def test_db_missing_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_NOT_FOUND'):
                g.database_busy(Path(folder))

    def test_busy_cron_cannot_restart(self):
        with patch.object(g,'cron_busy',return_value=True), patch.object(g,'run') as command, patch.object(g,'emit'):
            g.recover(self.item, 'redacted', self.state)
            command.assert_not_called()

    def test_live_lease_cannot_restart(self):
        with patch.object(g,'cron_busy',return_value=False), patch.object(g,'database_busy',return_value=True), patch.object(g,'run') as command, patch.object(g,'emit'):
            g.recover(self.item, 'redacted', self.state)
            command.assert_not_called()

    def test_changed_container_restores_timer_without_restart(self):
        changed=copy.deepcopy(self.item); changed['Id']='c'*64
        with patch.object(g,'cron_busy',return_value=False), patch.object(g,'database_busy',return_value=False), patch.object(g,'inspect',return_value=changed), patch.object(g,'run',return_value='active') as command, patch.object(g,'emit'):
            self.assertEqual(g.recover(self.item,'redacted',self.state),0)
            calls=[call.args[0] for call in command.call_args_list]
            self.assertNotIn(['docker','restart','--time','30','taha-ai'],calls)
            self.assertIn(['systemctl','start','taha-ai-cron.timer'],calls)

    def test_successful_recovery_once_and_restore_timer(self):
        recovered=copy.deepcopy(self.item); recovered['State']['OOMKilled']=False
        with patch.object(g,'cron_busy',return_value=False), patch.object(g,'database_busy',return_value=False), patch.object(g,'inspect',side_effect=[self.item,recovered]), patch.object(g,'has_listener',return_value=False), patch.object(g,'probe',side_effect=[0,200,200]), patch.object(g,'run',return_value='active') as command, patch.object(g,'preserve_evidence'), patch.object(g,'write_state') as save, patch.object(g,'emit'):
            self.assertEqual(g.recover(self.item,'redacted',self.state),0)
            calls=[call.args[0] for call in command.call_args_list]
            self.assertEqual(calls.count(['docker','restart','--time','30','taha-ai']),1)
            self.assertIn(['systemctl','start','taha-ai-cron.timer'],calls)
            self.assertEqual(save.call_count,2)
            self.assertFalse(self.state['blocked'])

    def test_failed_recovery_latched_and_timer_stays_paused(self):
        with patch.object(g,'cron_busy',return_value=False), patch.object(g,'database_busy',return_value=False), patch.object(g,'inspect',return_value=self.item), patch.object(g,'has_listener',return_value=False), patch.object(g,'probe',return_value=0), patch.object(g,'run',return_value='active') as command, patch.object(g,'preserve_evidence'), patch.object(g,'write_state'), patch.object(g.time,'sleep'), patch.object(g,'emit'):
            self.assertEqual(g.recover(self.item,'redacted',self.state),2)
            calls=[call.args[0] for call in command.call_args_list]
            self.assertEqual(calls.count(['docker','restart','--time','30','taha-ai']),1)
            self.assertNotIn(['systemctl','start','taha-ai-cron.timer'],calls)
            self.assertTrue(self.state['blocked'])

    def test_listener_parser(self):
        with patch.object(Path,'read_text',return_value='header\n 0: 00000000:2253 00000000:0000 0A\n'):
            self.assertTrue(g.has_listener(self.item))
        with patch.object(Path,'read_text',return_value='header\n 0: 00000000:2253 00000000:0000 01\n'):
            self.assertFalse(g.has_listener(self.item))

    def test_no_redirect_of_credentials(self):
        self.assertIsNone(g.NoRedirect().redirect_request(None,None,302,None,None,None))

if __name__=='__main__': unittest.main()
