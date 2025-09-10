export default async function TwilioReminder(req, res) {
  try{
    console.log('twilio reminder hitt..');
    const meetingTime = req.query.meetingTime || 'your scheduled time';
    const role = req.query.role || 'participant';
    const twiml = new Twilio.twiml.VoiceResponse();

    const gather = twiml.gather({
      numDigits: 1,
      action: '/twilio/response',
      method: 'POST'
    });

    gather.say(`Hello! This is a reminder for your meeting scheduled with Flashfire at ${meetingTime}.`);

    twiml.say('Thank you. Goodbye.');
    res.type('text/xml');
    res.send(twiml.toString());

  }
  catch(error){
    console.log('twilio error,', error)
  }
  
}