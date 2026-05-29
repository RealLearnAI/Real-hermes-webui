import sqlite3
import json
import sys

try:
    conn = sqlite3.connect(r'C:\Users\Administrator\.hermes\state.db')
    r = conn.execute(
        'SELECT input_tokens, output_tokens FROM sessions '
        'WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).fetchone()
    conn.close()
    result = {
        'input_tokens': r[0] if r else 0,
        'output_tokens': r[1] if r else 0,
    }
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
