"""Verify individual profile exports with the production plugin and native restart."""
import argparse
from pathlib import Path
from run_restore_probe import run

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orca", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--export", dest="exported", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.orca.resolve(), args.source, args.exported, args.report, individual=True)
    print(result)
    raise SystemExit(0 if result["passed"] else 1)
