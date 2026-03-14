// src/workers/workerDecode.js
// Runs inside a Worker thread – never on the main event loop.
'use strict';

const { parentPort } = require('worker_threads');
const alawmulaw     = require('alawmulaw');

/**
 * alawmulaw API:
 *   alawmulaw.mulaw.decode(Uint8Array)  → Int16Array  (mulaw → PCM)
 *   alawmulaw.mulaw.encode(Int16Array)  → Uint8Array  (PCM → mulaw)
 *
 * Incoming message:
 *   { payloadBase64, streamSid, timestamp, taskId }
 *
 * Reply (success):
 *   { streamSid, pcm: Buffer, int16: Int16Array, timestamp, taskId, ok: true }
 *
 * Reply (error):
 *   { streamSid, timestamp, taskId, err: string }
 */
parentPort.on('message', (msg) => {
  const { payloadBase64, streamSid, timestamp, taskId } = msg;

  try {
    if (!payloadBase64) throw new Error('Missing payloadBase64');

    // Validate base64
    if (!/^[A-Za-z0-9+/=]+$/.test(payloadBase64)) {
      throw new Error('Invalid base64 payload');
    }

    // Step 1: base64 → raw µ-law bytes as Uint8Array
    // IMPORTANT: alawmulaw.mulaw.decode() requires Uint8Array, not Buffer
    const mulawBytes = new Uint8Array(Buffer.from(payloadBase64, 'base64'));

    // Validate size: Twilio 8kHz µ-law = 160 bytes per 20ms frame
    if (mulawBytes.length < 80 || mulawBytes.length > 320) {
      throw new Error(`Unexpected µ-law size: ${mulawBytes.length} bytes`);
    }

    // Step 2: µ-law (Uint8Array) → PCM (Int16Array)
    // decode() returns Int16Array — keep it as Int16Array for re-encoding
    const pcmInt16 = alawmulaw.mulaw.decode(mulawBytes);

    // Step 3: Also expose as Buffer for consumers that need Buffer API
    const pcmBuf = Buffer.from(pcmInt16.buffer);

    parentPort.postMessage({
      streamSid,
      pcm:    pcmBuf,     // Buffer  ← for WAV writers, file I/O, etc.
      int16:  pcmInt16,   // Int16Array ← for re-encoding back to µ-law
      timestamp,
      taskId,
      ok: true
    });

  } catch (err) {
    parentPort.postMessage({ streamSid, timestamp, taskId, err: err.message });
  }
});
