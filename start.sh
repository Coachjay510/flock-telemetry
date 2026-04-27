#!/bin/sh
PORT=${PORT:-8080}

cat > /tmp/ft-config.json << EOF
{
  "host": "0.0.0.0",
  "port": $PORT,
  "namespace": "tesla_telemetry",
  "transmit_decoded_records": true,
  "records": {
    "V":      ["logger"],
    "errors": ["logger"]
  },
  "log_level": "info",
  "json_log_handler": true
}
EOF

echo "fleet-telemetry starting on port $PORT"
fleet-telemetry -config /tmp/ft-config.json 2>&1 | node consumer.js
