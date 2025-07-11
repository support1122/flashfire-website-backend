import { google } from 'googleapis';
import path from 'path';

const auth = new google.auth.GoogleAuth({
  // keyFile: path.join(process.cwd(), 'google-service-key.json'),
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_ID = '12ZWHYbhvorVkPIQ1zfVVxMBhL0yS6s8BUO98r4L-l-I'; // e.g. from https://docs.google.com/spreadsheets/d/THIS_ID/edit
const SHEET_NAME ='Sheet1'; // Change if you renamed the tab in your sheet

export async function appendToGoogleSheet({ name, email, mobile, timestamp }) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range:`${SHEET_NAME}!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[name, email, mobile, timestamp]],
    },
  });
}
