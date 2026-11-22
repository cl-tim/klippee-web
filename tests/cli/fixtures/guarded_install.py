"""Run cmd_install with module.__file__ pointing at an untrusted local candidate.

argv: <installer path> <malicious candidate path>.
"""
import importlib.util, sys
spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.__file__ = sys.argv[2]
sys.argv = ['-', 'install']
raise SystemExit(module.cmd_install([]))
