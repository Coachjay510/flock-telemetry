FROM golang:1.23-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /src
RUN git clone --depth=1 https://github.com/teslamotors/fleet-telemetry . && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /fleet-telemetry ./cmd/

FROM node:20-alpine
RUN apk add --no-cache ca-certificates
COPY --from=builder /fleet-telemetry /usr/local/bin/fleet-telemetry
WORKDIR /app
COPY package.json ./
RUN npm ci --production
COPY consumer.js start.sh ./
RUN chmod +x start.sh
CMD ["./start.sh"]
