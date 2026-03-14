// src/workers/workerDecode.js
'use strict';

const { parentPort } = require('worker_threads');
const alawmulaw     = require('alawmulaw');

/**
 * Node.js Buffer pool problem:
 *   Buffer.from(base64) allocates from an 8KB pool.
 *   The resulting Buffer's .buffer is the ENTIRE 8KB pool ArrayBuffer,
 *   not just your data. byteOffset is non-zero.
 *   Doing .buffer.slice() on a pooled Buffer can return undefined
 *   or point to wrong memory.
 *
 * Fix: use Buffer.allocUnsafe() + copy into a fresh standalone ArrayBuffer
 * so byteOffset is always 0 and .buffer is exactly our data.
 */
parentPort.on('message', (msg) => {
  const { payloadBase64, streamSid, timestamp, taskId } = msg;

  try {
    if (!payloadBase64) throw new Error('Missing payloadBase64');

    // Step 1: base64 -> raw bytes
    // Use Buffer.from then copy into a FRESH ArrayBuffer (not pool-allocated)
    const decoded   = Buffer.from(payloadBase64, 'base64');
    const byteLen   = decoded.length;

    if (byteLen < 80 || byteLen > 320) {
      throw new Error(`Unexpected mulaw size: ${byteLen} bytes`);
    }

    // Fresh standalone ArrayBuffer - no pool sharing, byteOffset always 0
    const mulawAB    = new ArrayBuffer(byteLen);
    const mulawBytes = new Uint8Array(mulawAB);
    decoded.copy(Buffer.from(mulawAB));  // copy decoded bytes in

    // Step 2: mulaw Uint8Array -> PCM Int16Array
    const pcmInt16 = alawmulaw.mulaw.decode(mulawBytes);

    // Step 3: Copy PCM into its own fresh ArrayBuffer
    // pcmInt16 from the library may share an internal buffer - copy it out
    const pcmAB     = new ArrayBuffer(pcmInt16.length * 2);
    const pcmView   = new Int16Array(pcmAB);
    pcmView.set(pcmInt16);  // copy samples into our owned buffer

    // Step 4: Transfer the owned ArrayBuffer (zero-copy transfer)
    parentPort.postMessage(
      { streamSid, pcmAB, byteLen: pcmAB.byteLength, timestamp, taskId, ok: true },
      [pcmAB]  // transfer list - moves ownership, no clone
    );

  } catch (err) {
    parentPort.postMessage({ streamSid, timestamp, taskId, err: err.message });
  }
});
