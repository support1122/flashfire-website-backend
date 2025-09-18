// import twilio from "twilio";

// export default async function TwilioReminder(req, res) {
//   try{
//     console.log('twilio reminder hitt..');
//     const meetingTime = req.query.meetingTime || 'your scheduled time';
//     const role = req.query.role || 'participant';
//     const twiml = new Twilio.twiml.VoiceResponse();

//     const gather = twiml.gather({
//       numDigits: 1,
//       action: '/twilio/response',
//       method: 'POST'
//     });

//     gather.say(`Hello! This is a reminder for your meeting scheduled with Flashfire at ${meetingTime}.`);

//     twiml.say('Thank you. Goodbye.');
//     res.type('text/xml');
//     res.send(twiml.toString());

//   }
//   catch(error){
//     console.log('twilio error,', error)
//   }
  
// }

// Controllers/TwilioReminder.js
import twilio from "twilio";

export default async function TwilioReminder(req, res) {
  try {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    const meetingTime = req.query.meetingTime || req.body.meetingTime || "your scheduled time";
    const role = req.query.role || req.body.role || "participant";

    // Gather a digit (optional)
    const gather = twiml.gather({
      numDigits: 1,
      action: "/twilio/response",
      method: "POST"
    });

    twiml.say(
      `Hello! This is a reminder for your meeting scheduled with Flashfire at ${meetingTime}.`
    );

    // Fallback if no input
    twiml.say("Thank you. Goodbye.");

    res.status(200).type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("twilio error,", error);
    // Always send a TwiML error response so Twilio doesn't retry indefinitely
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const errTwiml = new VoiceResponse();
    errTwiml.say("We are sorry. The reminder could not be completed at this time.");
    res.status(200).type("text/xml").send(errTwiml.toString());
  }
}
