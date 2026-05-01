FROM golang:1.23-bullseye AS builder

# Install build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget build-essential pkg-config autoconf automake libtool \
    && rm -rf /var/lib/apt/lists/*

# Build libsodium (required by libzmq)
WORKDIR /build
RUN wget -q https://github.com/jedisct1/libsodium/releases/download/1.0.19-RELEASE/libsodium-1.0.19.tar.gz \
    && tar -xzf libsodium-1.0.19.tar.gz
WORKDIR /build/libsodium-stable
RUN ./configure --disable-shared --enable-static && make -j$(nproc) && make install

# Build libzmq
WORKDIR /build
RUN wget -q https://github.com/zeromq/libzmq/releases/download/v4.3.4/zeromq-4.3.4.tar.gz \
    && tar -xf zeromq-4.3.4.tar.gz
WORKDIR /build/zeromq-4.3.4
RUN ./configure --enable-static --disable-shared --disable-Werror && make -j$(nproc) && make install

# Build fleet-telemetry binary
WORKDIR /src
RUN git clone --depth=1 https://github.com/teslamotors/fleet-telemetry .
ENV CGO_ENABLED=1
ENV CGO_LDFLAGS="-lstdc++"
RUN go build --ldflags 'extldflags="-static"' -o /fleet-telemetry ./cmd/

FROM node:20-alpine
RUN apk add --no-cache ca-certificates
COPY --from=builder /fleet-telemetry /usr/local/bin/fleet-telemetry
WORKDIR /app
COPY package.json ./
RUN npm ci --production
COPY consumer.js start.sh ./
RUN chmod +x start.sh
CMD ["./start.sh"]
