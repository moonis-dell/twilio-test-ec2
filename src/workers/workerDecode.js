// src/workers/workerDecode.js
// Runs inside a Worker thread – never on the main event loop.
'use strict';

const { parentPort } = require('worker_threads');
const { decode }     = require('alawmulaw');

/**
 * Incoming message shape:
 *   { payloadBase64, streamSid, timestamp, taskId }
 *
 * Reply shape (success):
 *   { streamSid, pcm: Buffer, timestamp, taskId, ok: true }
 *
 * Reply shape (error):
 *   { streamSid, timestamp, taskId, err: string }
 */
parentPort.on('message', (msg) => {
  const { payloadBase64, streamSid, timestamp, taskId } = msg;

  try {
    if (!payloadBase64) throw new Error('Missing payloadBase64');

    // Validate base64 characters
    if (!/^[A-Za-z0-9+/=]+$/.test(payloadBase64)) {
      throw new Error('Invalid base64 payload');
    }

    // Step 1: base64 → raw µ-law Buffer
    const mulawBuf = Buffer.from(payloadBase64, 'base64');

    // Step 2: Sanity-check size
    // Twilio 8 kHz µ-law: 160 bytes per 20 ms frame (range 80–320 bytes)
    if (mulawBuf.length < 80 || mulawBuf.length > 320) {
      throw new Error(`Unexpected µ-law size: ${mulawBuf.length} bytes`);
    }

    // Step 3: µ-law → 16-bit signed linear PCM (CPU-bound, safe in worker)
    const pcmBuf = decode(mulawBuf);

    parentPort.postMessage({ streamSid, pcm: pcmBuf, timestamp, taskId, ok: true });
  } catch (err) {
    parentPort.postMessage({ streamSid, timestamp, taskId, err: err.message });
  }
});
