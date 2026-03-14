// src/routes/twilio.js
'use strict';

async function twilioRoutes(fastify) {
  /**
   * POST /call
   *
   * Twilio Voice Webhook. Returns TwiML to start a BIDIRECTIONAL media stream.
   *
   * KEY: <Connect><Stream> = bidirectional (send + receive audio)
   *      <Start><Stream>   = unidirectional (receive only, outbound media ignored)
   *
   * NOTE: With <Connect><Stream>, Twilio blocks on this verb and does NOT
   * execute any subsequent TwiML until the WebSocket is closed by your server.
   * No <Pause> needed — the call stays alive as long as the WS is open.
   */
  fastify.post('/call', async (request, reply) => {
    const { CallSid, From, To, CallStatus } = request.body || {};

    fastify.log.info({
      event: 'incoming_call',
      callSid: CallSid,
      from: From,
      to: To,
      status: CallStatus
    });

    // Build WebSocket URL dynamically — works in any environment
    const host = process.env.SERVER_HOST ||
                 request.headers['x-forwarded-host'] ||
                 request.hostname;

    const wsUrl = `wss://${host}/media-stream`;

    fastify.log.info(`[TWILIO] Bidirectional stream URL: ${wsUrl}`);

    // <Connect><Stream> = BIDIRECTIONAL
    // Twilio will send inbound audio AND accept outbound audio from your server.
    // The call stays alive until your server closes the WebSocket connection.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${CallSid || ''}"/>
      <Parameter name="from"    value="${From    || ''}"/>
      <Parameter name="to"      value="${To      || ''}"/>
    </Stream>
  </Connect>
</Response>`;

    reply
      .code(200)
      .header('Content-Type', 'text/xml; charset=utf-8')
      .send(twiml);
  });

  /**
   * POST /call/status
   * Twilio StatusCallback — logs call lifecycle events.
   */
  fastify.post('/call/status', async (request, reply) => {
    const { CallSid, CallStatus, CallDuration, From, To } = request.body || {};

    fastify.log.info({
      event: 'call_status_update',
      callSid: CallSid,
      status: CallStatus,
      duration: CallDuration,
      from: From,
      to: To
    });

    reply.code(204).send();
  });
}

module.exports = twilioRoutes;
