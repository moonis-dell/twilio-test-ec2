# Twilio Media Stream - Fastify WebSocket Server

Production-ready Fastify WebSocket server for Twilio Media Streams with worker-thread pool for non-blocking µ-law audio processing.

## Features

- Never closes connections from server side
- Worker-thread pool for non-blocking µ-law → PCM conversion
- Fixed race condition using taskId-based promise matching
- Serialized socket writes to prevent concurrent write collisions
- Inactivity detection based on Twilio media/mark messages (not WebSocket ping/pong)
- Backpressure handling to prevent queue overflow
- Comprehensive close event logging with codes and reasons
- Graceful shutdown with proper cleanup
- Health check endpoint

## Architecture

- **Main thread**: Handles all WebSocket I/O, timers, connection management
- **Worker pool**: CPU-bound µ-law decoding runs in parallel on separate threads
- **Pool size**: Automatically sized to `os.cpus().length`
- **Shared pool**: All calls share the same workers for optimal resource usage
- **taskId matching**: Prevents race conditions with multiple concurrent frames per stream

## Installation

```bash
npm install
cp .env.example .env
```

## Usage

```bash
# Development
npm run dev

# Production
npm start
```

## TwiML Configuration

```xml
<Response>
    <Start>
        <Stream url="wss://your-domain.com/media-stream"/>
    </Start>
    <Pause length="60"/>
</Response>
```

## Health Check

```bash
curl http://localhost:8000/health
```

## WebSocket Close Codes

| Code | Meaning | Action |
|------|---------|--------|
| 1000 | Normal closure | Call ended by Twilio/caller |
| 1006 | Abnormal closure | Check network/proxy timeouts |
| 1008 | Policy violation | Verify message format |
| 1011 | Internal error | Check server logs |

## Production Deployment

### NGINX Configuration

```nginx
location /media-stream {
    proxy_pass http://localhost:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

### OS-Level TCP Keep-Alive

```bash
sysctl -w net.ipv4.tcp_keepalive_time=60
sysctl -w net.ipv4.tcp_keepalive_intvl=10
sysctl -w net.ipv4.tcp_keepalive_probes=6
```

## License

MIT
