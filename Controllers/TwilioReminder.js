export default async function TwilioReminder(req, res) {
  const meetingTime = req.query.meetingTime || 'your scheduled time';
  const role = req.query.role || 'participant';
  const twiml = new Twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    action: '/twilio/response',
    method: 'POST'
  });

  gather.say(`Hello! This is a reminder for your meeting scheduled at ${meetingTime}.`);

  twiml.say('No input received. Goodbye.');
  res.type('text/xml');
  res.send(twiml.toString());
}