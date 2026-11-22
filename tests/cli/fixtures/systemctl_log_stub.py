"""systemctl stand-in that only records its arguments to KLIPPEE_SYSTEMCTL_LOG."""
import json, os, sys
with open(os.environ['KLIPPEE_SYSTEMCTL_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps(sys.argv[1:]) + '\n')
