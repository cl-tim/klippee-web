"""systemctl stand-in for upgrade tests: logs calls, honours agent-state test env vars."""
import json, os, sys
arguments = sys.argv[1:]
with open(os.environ['KLIPPEE_SYSTEMCTL_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps(arguments) + '\n')
if arguments[:2] == ['--user', 'is-active']:
    state = os.environ.get('KLIPPEE_AGENT_TEST_STATE', 'active')
    print(state)
    raise SystemExit(0 if state == 'active' else 3)
if arguments[:2] == ['--user', 'try-restart'] and os.environ.get('KLIPPEE_AGENT_TEST_RESTART_FAIL') == '1':
    print('simulated restart failure', file=sys.stderr)
    raise SystemExit(1)
