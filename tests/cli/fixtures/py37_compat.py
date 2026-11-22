"""Parse the CLI source with Python 3.7 feature gating. argv: <installer path>."""
import ast
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
ast.parse(source, filename='klippee.py', feature_version=(3, 7))
