// workerDecode.js
const { parentPort } = require('worker_threads');
const { decode } = require('alawmulaw');

/**
 * Worker thread for decoding µ-law audio to PCM
 *
 * Expected message from main thread:
 *   {
 *     payloadBase64: <string>,  // base64-encoded µ-law audio
 *     streamSid: <string>,      // Twilio stream identifier
 *     timestamp: <number>,      // media timestamp from Twilio
 *     taskId: <string>          // unique task ID for exact promise matching
 *   }
 *
 * Reply sent back to main thread:
 *   Success: { streamSid, pcm: Buffer, timestamp, taskId, ok: true }
 *   Error:   { streamSid, timestamp, taskId, err: string }
 */
parentPort.on('message', (msg) => {
  try {
    const { payloadBase64, streamSid, timestamp, taskId } = msg;

    if (!payloadBase64) {
      throw new Error('Missing payloadBase64');
    }

    // Validate base64 format
    if (!/^[A-Za-z0-9+/=]+$/.test(payloadBase64)) {
      throw new Error('Invalid base64 format in payload');
    }

    // Step 1: base64 → raw µ-law Buffer
    const mulawBuf = Buffer.from(payloadBase64, 'base64');

    // Step 2: Validate expected Twilio payload size
    // Twilio sends ~160 bytes per 20ms frame at 8kHz
    if (mulawBuf.length < 80 || mulawBuf.length > 320) {
      throw new Error(`Unexpected µ-law buffer size: ${mulawBuf.length} bytes (expected 80-320)`);
    }

    // Step 3: µ-law → 16-bit signed linear PCM
    // This is CPU-bound work that runs safely in this worker thread
    const pcmBuf = decode(mulawBuf);

    // Step 4: Send result back to main thread with taskId for exact matching
    parentPort.postMessage({
      streamSid,
      pcm: pcmBuf,
      timestamp,
      taskId,
      ok: true
    });
  } catch (e) {
    // Return error instead of crashing the worker thread
    parentPort.postMessage({
      streamSid: msg.streamSid || 'unknown',
      timestamp: msg.timestamp,
      taskId: msg.taskId,
      err: e.message
    });
  }
});
