#!/bin/sh
PORT=${PORT:-8080}

# Write TLS certs from environment variables
echo "$TLS_CERT" | base64 -d > /tmp/server.crt
echo "$TLS_KEY"  | base64 -d > /tmp/server.key
echo "$CA_CERT"  | base64 -d > /tmp/ca.crt

cat > /tmp/ft-config.json << EOF
{
  "host": "0.0.0.0",
  "port": $PORT,
  "namespace": "tesla_telemetry",
  "tls": {
    "server_cert": "/tmp/server.crt",
    "server_key": "/tmp/server.key",
    "ca_cert": "/tmp/ca.crt"
  },
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
fleet-telemetry -config /tmp/ft-config.json | node consumer.js
