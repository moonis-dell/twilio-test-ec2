// src/routes/twilio.js
// Handles the POST /call endpoint that Twilio hits to get the TwiML
// with the WebSocket stream URL.
'use strict';

async function twilioRoutes(fastify) {
  /**
   * POST /call
   *
   * Twilio calls this endpoint when a call comes in (set as your
   * Twilio phone number's Voice Webhook URL).
   *
   * Twilio sends x-www-form-urlencoded body with fields like:
   *   CallSid, From, To, CallStatus, Direction, etc.
   *
   * We respond with TwiML that starts a Media Stream and keeps
   * the call alive with a long <Pause>.
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

    // Build the WebSocket URL dynamically from the incoming request host
    // so this works in any environment (dev, staging, prod) without
    // hardcoding the domain.
    const host = process.env.SERVER_HOST ||
                 request.headers['x-forwarded-host'] ||
                 request.hostname;

    const wsUrl = `wss://${host}/media-stream`;

    fastify.log.info(`[TWILIO] Returning WS URL: ${wsUrl}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${CallSid || ''}"/>
      <Parameter name="from"    value="${From    || ''}"/>
      <Parameter name="to"      value="${To      || ''}"/>
    </Stream>
  </Start>
  <!-- Keep the call alive while the WebSocket stream is active.
       Increase this value for longer expected call durations. -->
  <Pause length="120"/>
</Response>`;

    reply
      .code(200)
      .header('Content-Type', 'text/xml; charset=utf-8')
      .send(twiml);
  });

  /**
   * POST /call/status
   *
   * Optional: Twilio status-callback endpoint.
   * Configure this as the StatusCallback URL in your Twilio number settings
   * to receive real-time call status updates (initiated, ringing, answered,
   * completed, busy, no-answer, failed, canceled).
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

    // Twilio expects a 204 No Content or 200 OK for status callbacks
    reply.code(204).send();
  });
}

module.exports = twilioRoutes;
