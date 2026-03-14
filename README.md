# twilio-test-ec2

Production-ready Fastify WebSocket server for Twilio Media Streams.  
Decodes µ-law audio non-blocking via a shared worker-thread pool.

## Project Structure

```
twilio-test-ec2/
├── server.js                  ← entry point
├── src/
│   ├── app.js                 ← Fastify app factory + shutdown logic
│   ├── routes/
│   │   ├── twilio.js          ← POST /call  (TwiML) + POST /call/status
│   │   └── health.js          ← GET  /health
│   ├── websocket/
│   │   └── mediaStream.js     ← WebSocket /media-stream handler
│   ├── pool/
│   │   └── workerPool.js      ← Singleton worker-thread pool
│   └── workers/
│       └── workerDecode.js    ← µ-law → PCM decoder (runs in worker thread)
├── .env.example
├── package.json
└── README.md
```

## Installation

```bash
npm install
cp .env.example .env
```

## Usage

```bash
npm run dev   # development (nodemon)
npm start     # production
```

## Twilio Configuration

Point your Twilio phone number's **Voice Webhook** to:

```
POST https://your-server.com/call
```

The server responds with TwiML that starts a Media Stream and keeps  
the call alive with a `<Pause>`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/call` | Twilio Voice Webhook – returns TwiML with WS stream URL |
| `POST` | `/call/status` | Twilio StatusCallback – logs call status updates |
| `GET` | `/media-stream` | WebSocket endpoint for Twilio Media Streams |
| `GET` | `/health` | Health check with pool stats and memory usage |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `production` | Environment |
| `LOG_LEVEL` | `info` | Pino log level |
| `SERVER_HOST` | _(request host)_ | Override WS hostname in TwiML |

## WebSocket Close Codes

| Code | Meaning |
|------|---------|
| `1000` | Normal – call ended by Twilio/caller |
| `1006` | Abnormal – check network / proxy timeouts |
| `1008` | Policy violation – malformed frame |
| `1011` | Internal error – check server logs |

## Production (NGINX)

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

## License

MIT
