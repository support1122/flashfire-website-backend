import { InterestedClientsModel } from "../Schema_Models/InterestedClients.js";
import { SessionModel } from "../Schema_Models/Sessions.js";
import { DiscordConnect } from "./DiscordConnect.js";


export const  GetMeetDetails = async (req, res) => {
  const { event, payload } = req.body;
  console.log(req.body);
  try {
    if (event === "invitee.created") {
    const { name, email, cancel_url, reschedule_url, questions_and_answers } = payload.invitee;
    const { start_time, end_time, location } = payload.event;

    const meetingDetails = {
      name,
      email,
      start_time,
      end_time,
      location: location.location,
      cancel_url,
      reschedule_url,
    };
    let findMobile = await InterestedClientsModel.findOne({email, name})
    console.log("📅 New Meeting Booked:\n", meetingDetails);
    await SessionModel.create({StudentName :name,
                        StudentEmail:email,
                        StudentMobile: findMobile.mobile ,
                        SessionStartTiming:start_time,
                        SessionEndTiming : end_time,
                        SessionBookingTime: new Date,
                        CancelUrl: cancel_url,
                        RescheduleUrl : reschedule_url,
                        comments: questions_and_answers
                        })
    DiscordConnect(JSON.stringify({"Message" : "A NEW SESSION/ METTING HAS BEEN SCHEDULED :-",
                                    "StudentName" :name,
                                    "StudentEmail":email,
                                    "StudentMobile": findMobile.mobile ,
                                    "SessionStartTiming":start_time,
                                    "SessionEndTiming" : end_time,
                                    "SessionBookingTime": new Date,
                                    "CancelUrl": cancel_url,
                                    "RescheduleUrl" : reschedule_url,
                                    "comments": questions_and_answers                             
                                },null,2 ));
    // TODO: Save to DB or send to Discord
    console.log('Meeting details sent to descord.')

    return res.status(200).json({message : "Webhook received- meeting details saved to DB and sent to Discord"});
  } else {
    return res.status(200).send("Event ignored");
  }
    
  } catch (error) {
    console.log(error);
  }

  
};


