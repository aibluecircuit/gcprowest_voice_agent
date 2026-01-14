const { google } = require('googleapis');
require('dotenv').config();

async function testCalendarWrite() {
    console.log("1. Loading Service Account...");
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: './service-account.json',
            scopes: ['https://www.googleapis.com/auth/calendar']
        });

        const client = await auth.getClient();
        console.log("2. Auth Successful. Email:", client.email);

        const calendar = google.calendar({ version: 'v3', auth });

        console.log("3. Attempting to CREATE an event for: aibluecircuit@gmail.com");

        const startTime = new Date();
        startTime.setHours(startTime.getHours() + 24); // Tomorrow
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later

        const event = {
            summary: 'Test Booking from Script',
            description: 'This is a test event to verify Write permissions.',
            start: { dateTime: startTime.toISOString() },
            end: { dateTime: endTime.toISOString() },
        };

        const res = await calendar.events.insert({
            calendarId: 'aibluecircuit@gmail.com',
            resource: event,
        });

        console.log("SUCCESS! Event created.");
        console.log("Link:", res.data.htmlLink);

    } catch (error) {
        console.error("\n!!! WRITE FAILED !!!");
        console.error("Error Message:", error.message);
        if (error.code === 403) {
            console.error("HINT: Ensure the Calendar is shared with 'Make changes to events' permission, not just 'See all event details'.");
        }
    }
}

testCalendarWrite();
