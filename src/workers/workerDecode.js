// src/workers/workerDecode.js
'use strict';

const { parentPort } = require('worker_threads');
const alawmulaw     = require('alawmulaw');

/**
 * alawmulaw API:
 *   alawmulaw.mulaw.decode(Uint8Array)  → Int16Array
 *   alawmulaw.mulaw.encode(Int16Array)  → Uint8Array
 *
 * IMPORTANT about worker_threads postMessage:
 *   - Plain objects, Buffers, strings → copied (structured clone)
 *   - ArrayBuffer → can be TRANSFERRED (zero-copy) via transfer list
 *   - Int16Array / Uint8Array → NOT directly transferable, must send .buffer
 *
 * We send back the raw ArrayBuffer and reconstruct Int16Array on the other side.
 */
parentPort.on('message', (msg) => {
  const { payloadBase64, streamSid, timestamp, taskId } = msg;

  try {
    if (!payloadBase64) throw new Error('Missing payloadBase64');

    if (!/^[A-Za-z0-9+/=]+$/.test(payloadBase64)) {
      throw new Error('Invalid base64 payload');
    }

    // Step 1: base64 → Uint8Array (µ-law bytes)
    const mulawBytes = new Uint8Array(Buffer.from(payloadBase64, 'base64'));

    if (mulawBytes.length < 80 || mulawBytes.length > 320) {
      throw new Error(`Unexpected µ-law size: ${mulawBytes.length} bytes`);
    }

    // Step 2: µ-law Uint8Array → PCM Int16Array
    const pcmInt16 = alawmulaw.mulaw.decode(mulawBytes);

    // Step 3: Extract the underlying ArrayBuffer to transfer (zero-copy)
    // We MUST use .slice() to get an owned ArrayBuffer —
    // pcmInt16.buffer may be shared/pooled inside the library
    const pcmArrayBuffer = pcmInt16.buffer.slice(
      pcmInt16.byteOffset,
      pcmInt16.byteOffset + pcmInt16.byteLength
    );

    // Step 4: Post back with ArrayBuffer in transfer list (zero-copy)
    parentPort.postMessage(
      { streamSid, pcmArrayBuffer, timestamp, taskId, ok: true },
      [pcmArrayBuffer]   // ← transfer list: moves ownership, no copy
    );

  } catch (err) {
    parentPort.postMessage({ streamSid, timestamp, taskId, err: err.message });
  }
});
