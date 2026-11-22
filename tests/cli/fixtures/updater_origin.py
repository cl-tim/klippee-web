"""Print upgrade/install base URLs from a workspace. argv: <installer path> <workspace dir>."""
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("klippee_client", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
os.chdir(sys.argv[2])
print(module.upgrade_base_url())
print(module.install_base_url())
