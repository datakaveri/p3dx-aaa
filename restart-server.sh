#!/bin/bash
cd /mnt/c/Users/sarav/OneDrive/Desktop/flo/p3dx-aaa
pkill -f 'node src/server.js' 2>/dev/null
sleep 1
setsid nohup node src/server.js > /tmp/p3dx-aaa.log 2>&1 < /dev/null &
disown -a
sleep 3
echo "PID_CHECK:"
pgrep -fa 'node src/server.js'
echo "LOG:"
cat /tmp/p3dx-aaa.log
