#!/usr/bin/env python3
"""Query current active session's token usage from Hermes state.db."""
import json
import os
import sqlite3


def main():
    db_path = os.path.expanduser("~/.hermes/state.db")
    if not os.path.exists(db_path):
        print(json.dumps({"input_tokens": 0, "output_tokens": 0}))
        return

    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.execute(
            "SELECT input_tokens, output_tokens FROM sessions "
            "WHERE ended_at IS NULL "
            "ORDER BY started_at DESC LIMIT 1"
        )
        row = cursor.fetchone()
        if row:
            input_tokens = row[0] or 0
            output_tokens = row[1] or 0
        else:
            input_tokens = 0
            output_tokens = 0

        print(json.dumps({
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        }))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
