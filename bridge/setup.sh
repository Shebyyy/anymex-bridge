#!/bin/bash
cd /home/z/my-project/bridge

# Remove old db to start fresh
rm -f data/bridge.db data/bridge.db-shm data/bridge.db-wal

# Start bridge in background
bun run index.ts &
BRIDGE_PID=$!

# Wait for it to be ready
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8081/health >/dev/null 2>&1; then
    echo "Bridge ready after ${i}s"
    break
  fi
  sleep 1
done

# Register user
echo "=== Registering user ==="
curl -s -X POST http://127.0.0.1:8081/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"test1234"}'
echo ""

# Add yuzono/anime-repo
echo "=== Adding yuzono/anime-repo ==="
curl -s -X POST http://127.0.0.1:8081/addRepo \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"test1234","url":"https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json"}'
echo ""

# Add keiyoushi/extensions
echo "=== Adding keiyoushi/extensions ==="
curl -s -X POST http://127.0.0.1:8081/addRepo \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"test1234","url":"https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb"}'
echo ""

# Check results
echo "=== Health ==="
curl -s http://127.0.0.1:8081/health
echo ""

echo "=== Extensions count ==="
curl -s 'http://127.0.0.1:8081/data?section=extensions' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Total extensions: {len(d)}')"

echo "=== Done ==="

# Keep bridge running
wait $BRIDGE_PID 2>/dev/null
