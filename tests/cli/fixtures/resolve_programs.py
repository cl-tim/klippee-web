"""Resolve helper programs from a directory of planted lookalikes. argv: <installer path> <planted dir>."""
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
os.chdir(sys.argv[2])
print(module.resolve_program('git') or '')
print(module.resolve_program('curl') or '')
print(module.resolve_program('cksum') or '')
