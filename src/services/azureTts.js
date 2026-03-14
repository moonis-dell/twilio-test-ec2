// src/services/azureTts.js
// Azure TTS service — ported from twilio-tts-streaming (ESM → CJS)
// Returns a raw 8kHz µ-law Node.js Readable stream.
// Output format: raw-8khz-8bit-mono-mulaw — exactly what Twilio needs.
'use strict';

const https = require('https');

// Shared HTTPS keep-alive agent — one TCP pool per process.
// Saves ~80–120ms per utterance vs creating new connections.
const sharedAzureAgent = new https.Agent({
  keepAlive:     true,
  maxSockets:    300,
  maxFreeSockets: 100,
  timeout:       10_000
});

function destroySharedAzureAgent() {
  sharedAzureAgent.destroy();
}

class AzureTTSService {
  /**
   * @param {object} opts
   * @param {string} opts.speechKey    - Azure Speech API key
   * @param {string} opts.speechRegion - Azure region (e.g. 'eastus')
   * @param {string} [opts.voiceName]  - Azure voice name
   * @param {object} [opts.log]        - fastify logger
   */
  constructor({ speechKey, speechRegion, voiceName, log }) {
    this.speechKey    = speechKey;
    this.speechRegion = speechRegion;
    this.voiceName    = voiceName || 'en-US-JennyNeural';
    this.log          = log || console;
    this.outputFormat = 'raw-8khz-8bit-mono-mulaw';
  }

  /**
   * Synthesize text to a raw 8kHz µ-law Node.js Readable stream.
   * Stream starts flowing AS Azure synthesizes — no full-buffer wait.
   * Call stream.destroy() to abort mid-stream instantly.
   *
   * @param {string}  text    - plain text to speak
   * @param {object}  [opts]
   * @param {string}  [opts.emotion='neutral'] - SSML express-as style
   * @param {AbortSignal} [opts.signal]        - cancellation signal
   * @returns {Promise<import('stream').Readable>}
   */
  async getStream(text, { emotion = 'neutral', signal } = {}) {
    if (!text?.trim()) throw new Error('[AzureTTS] Empty text');

    this.log.info(`[AzureTTS] Synthesizing ${text.length} chars voice=${this.voiceName} emotion=${emotion}`);

    const ssml = [
      `<speak version="1.0"`,
      `  xmlns="http://www.w3.org/2001/10/synthesis"`,
      `  xmlns:mstts="http://www.w3.org/2001/mstts"`,
      `  xml:lang="en-US">`,
      `  <voice xml:lang="en-US" name="${this.voiceName}">`,
      `    <mstts:express-as style="${emotion}" styledegree="2">`,
      `      ${this._escapeXml(text)}`,
      `    </mstts:express-as>`,
      `  </voice>`,
      `</speak>`
    ].join('\n');

    const reqOpts = {
      method:   'POST',
      hostname: `${this.speechRegion}.tts.speech.microsoft.com`,
      path:     '/cognitiveservices/v1',
      headers: {
        'Ocp-Apim-Subscription-Key': this.speechKey,
        'Content-Type':              'application/ssml+xml',
        'X-Microsoft-OutputFormat':  this.outputFormat,
        'User-Agent':                'twilio-test-ec2/1.0'
      },
      agent: sharedAzureAgent
    };

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(this._abortErr());

      let settled = false;
      const done  = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      const onAbort = () => { req.destroy(this._abortErr()); done(reject, this._abortErr()); };
      signal?.addEventListener('abort', onAbort, { once: true });

      const req = https.request(reqOpts, (res) => {
        signal?.removeEventListener('abort', onAbort);

        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => done(reject, new Error(`[AzureTTS] HTTP ${res.statusCode}: ${body}`)));
          return;
        }

        res.on('close', () => { if (!req.destroyed) req.destroy(); });
        done(resolve, res);   // resolve with the Readable stream
      });

      req.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        done(reject, err);
      });

      req.write(ssml);
      req.end();
    });
  }

  _abortErr() {
    const e = new Error('[AzureTTS] Aborted'); e.name = 'AbortError'; return e;
  }

  _escapeXml(t) {
    return t
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = { AzureTTSService, destroySharedAzureAgent };
