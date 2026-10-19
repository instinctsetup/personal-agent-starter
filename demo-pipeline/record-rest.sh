#!/bin/bash
cd /home/sandbox/demo
R=/home/sandbox/personal-agent-starter
pgrep -f mock-model.mjs >/dev/null || { setsid nohup node mock-model.mjs >/tmp/mock.log 2>&1 < /dev/null & sleep 1; }
for s in 05-first-task 06-webfetch 07-memory 08-email 09-git 10-command 11-plugin 12-browser 13-schedule 14-daemon 15-compact 16-status 17-envref; do
  echo "=== $s $(date +%T) ==="
  rm -f $R/agent_memory.db.lock
  pkill -f "dist/index.js" 2>/dev/null
  timeout 560 python3 record.py scenes/$s.json rec/$s.jsonl
done
echo ALL_DONE
