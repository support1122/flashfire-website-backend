// import mongoose from "mongoose";
// import { InterestedClientsModel } from "../Schema_Models/InterestedClients.js";
// import { DiscordConnect } from "../Utils/DiscordConnect.js";
// import { SupabaseConnect } from "../Utils/SupabaseConnect.js";

// export default async function Register_Sessions(req, res) {
//   let { name, email, mobile, is_smtp_valid, carrier, location, workAuthorization } = req.body;

//   try {
//     console.log('from register_session', req.body);

//     // ✅ Save to MongoDB conditionally
//     if (is_smtp_valid && carrier !== '' && location !== '') {
//       await InterestedClientsModel.create({ name, email, mobile, workAuthorization });
//     } else if (!is_smtp_valid && (carrier !== '' && location !== '')) {
//       await InterestedClientsModel.create({ name, mobile, workAuthorization });
//     } else if (is_smtp_valid && (carrier === '' || location === '')) {
//       await InterestedClientsModel.create({ name, email, workAuthorization });
//     }

//     // ✅ Send to Discord
//     const discordMessage = {
//       "Message": "A New Lead Added ..!!!",
//       'Client Name': name,
//       'Client E-Mail': is_smtp_valid ? email : "<INVALID E-MAIL>",
//       'Client Mobile': (carrier !== '' && location !== '') ? mobile : "<INVALID MOBILE NO.>",
//       'Work Authorization': workAuthorization
//     };
//     DiscordConnect(JSON.stringify(discordMessage, null, 2));

//     // ✅ Insert into Supabase
//     const supabaseData = {
//       name,
//       email: is_smtp_valid ? email : null,
//       mobile: (carrier !== '' && location !== '') ? mobile : null,
//       work_authorization: workAuthorization
//     };

//     const { data, error } = await SupabaseConnect
//       .from('client_fields')  // ✅ Supabase table name (confirmed)
//       .insert([supabaseData]);

//     if (error) {
//       console.error('❌ Supabase insertion failed:');
//       console.error('Message:', error.message);
//       console.error('Details:', error.details);
//       console.error('Hint:', error.hint);
//       return res.status(500).json({ message: 'Supabase insertion failed', error });
//     }

//     console.log('✅ Inserted into Supabase:', supabaseData);
//     return res.status(201).json({ message: 'Success' });

//   } catch (error) {
//     console.error('❌ Unhandled Error:', error.message);
//     return res.status(500).json({ message: 'Server error', error });
//   }
// }




import mongoose from "mongoose";
import { InterestedClientsModel } from "../Schema_Models/InterestedClients.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { SupabaseConnect } from "../Utils/SupabaseConnect.js";

export default async function Register_Sessions(req, res) {
  let { name, email, mobile, is_smtp_valid, carrier, location, workAuthorization } = req.body;

  try {
    console.log('from register_session', req.body);

    // ✅ Save to MongoDB conditionally
    if (is_smtp_valid && carrier !== '' && location !== '') {
      await InterestedClientsModel.create({ name, email, mobile, workAuthorization });
    } else if (!is_smtp_valid && (carrier !== '' && location !== '')) {
      await InterestedClientsModel.create({ name, mobile, workAuthorization });
    } else if (is_smtp_valid && (carrier == '' || location == '')) {
      await InterestedClientsModel.create({ name, email, workAuthorization });
    }

    // ✅ Send to Discord
    const discordMessage = {
      "Message": "A New Lead Added ..!!!",
      'Client Name': name,
      'Client E-Mail': is_smtp_valid ? email : "<INVALID E-MAIL>",
      'Client Mobile': (carrier !== '' && location !== '') ? mobile : "<INVALID MOBILE NO.>",
      'Work Authorization': workAuthorization
    };
    DiscordConnect(JSON.stringify(discordMessage, null, 2));

    // ✅ Insert into Supabase
    // const supabaseData = {
    //   name,
    //   email: is_smtp_valid ? email : null,
    //   mobile: (carrier !== '' && location !== '') ? mobile : null,
    //   work_authorization: workAuthorization
    // };

    // const { data, error } = await SupabaseConnect
    //   .from('client_fields')  // ✅ Supabase table name (confirmed)
    //   .insert([supabaseData]);

    // if (error) {
    //   console.error('❌ Supabase insertion failed:');
    //   console.error('Message:', error.message);
    //   console.error('Details:', error.details);
    //   console.error('Hint:', error.hint);
    //   return res.status(500).json({ message: 'Supabase insertion failed', error });
    // }

    // console.log('✅ Inserted into Supabase:', supabaseData);
    // return res.status(201).json({ message: 'Success' });

  } catch (error) {
    console.error('❌ Unhandled Error:', error.message);
    return res.status(500).json({ message: 'Server error', error });
  }
}