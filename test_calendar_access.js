const { google } = require('googleapis');
require('dotenv').config();

async function testCalendar() {
    console.log("1. Loading Service Account...");
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: './service-account.json',
            scopes: ['https://www.googleapis.com/auth/calendar']
        });

        const client = await auth.getClient();
        console.log("2. Auth Successful. Authenticated as:", client.email);

        const calendar = google.calendar({ version: 'v3', auth });

        console.log("3. Attempting to list events for: aibluecircuit@gmail.com");

        const events = await calendar.events.list({
            calendarId: 'aibluecircuit@gmail.com',
            timeMin: new Date().toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });

        console.log("SUCCESS! Found " + events.data.items.length + " events.");
        if (events.data.items.length > 0) {
            console.log("First event:", events.data.items[0].summary);
        }

    } catch (error) {
        console.error("\n!!! ACCESS DENIED or API ERROR !!!");
        console.error("Error Message:", error.message);
        console.error("Full Trace:", error);
    }
}

testCalendar();
