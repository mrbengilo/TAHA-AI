import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('guard_metrics',Path(__file__).resolve().parents[1]/'deploy/vps/runtime-guard.py')
g=importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

class MetricsTests(unittest.TestCase):
    def test_pid_aware_command_and_rss(self):
        item={'Config':{'Image':'test'}}
        with patch.object(g,'run',return_value='PID PPID COMMAND RSS\n111 1 workerd 100\n112 1 workerd 200') as command, patch.object(Path,'read_text',return_value='MemAvailable: 1000 kB'), patch.object(g,'emit') as log:
            g.metrics(item)
            self.assertEqual(command.call_args.args[0],['docker','top','taha-ai','-eo','pid,ppid,comm,rss'])
            self.assertEqual(log.call_args.kwargs['rssKiB'],{'workerd':300})

    def test_metrics_failure_is_not_application_failure(self):
        with patch.object(g,'run',side_effect=RuntimeError('COMMAND_FAILED_docker')), patch.object(g,'emit') as log:
            g.metrics({'Config':{'Image':'test'}})
            self.assertEqual(log.call_args.args[0],'METRICS_UNAVAILABLE')

if __name__=='__main__': unittest.main()
