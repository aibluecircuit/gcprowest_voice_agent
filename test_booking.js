require('dotenv').config({ path: './backend/.env' });
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

async function testBooking() {
    console.log("--- TEST BOOKING ---");

    const msalConfig = {
        auth: {
            clientId: process.env.MS_CLIENT_ID,
            authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
            clientSecret: process.env.MS_CLIENT_SECRET,
        }
    };

    const cca = new ConfidentialClientApplication(msalConfig);

    try {
        const tokenRequest = {
            scopes: ['https://graph.microsoft.com/.default'],
        };

        const response = await cca.acquireTokenByClientCredential(tokenRequest);
        const client = Client.init({
            authProvider: (done) => {
                done(null, response.accessToken);
            },
        });

        const now = new Date();
        const startTime = new Date(now.getTime() + 1000 * 60 * 60); // In 1 hour
        const endTime = new Date(startTime.getTime() + 1000 * 60 * 60); // 1 hour duration

        const event = {
            subject: `GC Pro West AI TEST BOOKING`,
            body: {
                contentType: 'HTML',
                content: `<b>Diagnostic Test:</b> This event was created by the AI Voice Agent to verify connection.`
            },
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'UTC'
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'UTC'
            },
            location: {
                displayName: "System Test"
            }
        };

        console.log(`Booking test event for ${startTime.toISOString()}...`);
        const result = await client.api(`/users/${process.env.MS_USER_EMAIL}/events`)
            .post(event);

        console.log("✅ SUCCESS! Test booking created in Outlook.");
        console.log("Event ID:", result.id);
        console.log("\nALL SYSTEMS GREEN. The agent is fully integrated with your Microsoft Outlook Calendar.");

    } catch (error) {
        console.error("\n❌ BOOKING FAILED:", error.message);
    }
}

testBooking();
