const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Look for .env in current directory or root
require('dotenv').config();

const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const MODEL = "models/gemini-2.0-flash-exp";
const HOST = "generativelanguage.googleapis.com";
const API_KEY = process.env.GOOGLE_API_KEY;

// Fail gracefully if MS credentials are missing (Render environment variables)
const MS_TENANT_ID = process.env.MS_TENANT_ID;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    console.warn("CRITICAL ERROR: Microsoft credentials (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET) are missing from Environment Variables.");
    console.warn("Make sure these are added to the Render Environment settings.");
}
if (!process.env.MS_USER_EMAIL) {
    console.warn("CRITICAL ERROR: MS_USER_EMAIL is missing. Booking will fail.");
} else {
    console.log("System configured to manage calendar for:", process.env.MS_USER_EMAIL);
}

const SYSTEM_INSTRUCTIONS = `
You are the “GC Pro West AI Receptionist”. Your job is to answer calls, qualify leads, and schedule appointments.
You have access to a Microsoft Outlook calendar. 
- When asked for availability, use the 'checkAvailability' tool.
- When the user confirms a time, use the 'bookAppointment' tool.
- NOTIFICATIONS: You automatically send an Email confirmation via Outlook immediately after booking.
Always confirm the details before booking.
IMPORTANT RULES:
- We ONLY do outcall appointments (we go to the customer).
- You MUST ask for the customer's ADDRESS before booking an appointment.
- Operating Hours are 8:00 AM to 5:00 PM (EST), Monday to Friday.
- TIMEZONE: You are operating in Naples, FL (EST).
- PERSONALITY: Be energetic, friendly, and "real". Use natural language, contractions (don't, can't), and sound like a helpful human assistant. Show enthusiasm for renovations!
- KNOWLEDGE BASE: You are the AI for "GC Pro West Renovation Center".
    - Location: 5746 Woodmere Lake Cir, Naples, FL 34112.
    - Service Areas: Naples and Marco Island.
    - Services: High-end renovations, custom kitchen remodels, luxury bathroom upgrades, cabinets.
    - Contact: 239-307-8020, info@gcprowest.com.
- GUARDRAILS: You must ONLY answer questions about GC Pro West services and appointments.
IMPORTANT: Do NOT write Python code. Return valid Tool/Function calls.
`;

const msalConfig = {
    auth: {
        clientId: MS_CLIENT_ID || "MISSING",
        authority: `https://login.microsoftonline.com/${MS_TENANT_ID || 'common'}`,
        clientSecret: MS_CLIENT_SECRET || "MISSING",
    }
};

const cca = new ConfidentialClientApplication(msalConfig);

async function getGraphClient() {
    const tokenRequest = { scopes: ['https://graph.microsoft.com/.default'] };
    const response = await cca.acquireTokenByClientCredential(tokenRequest);
    return Client.init({
        authProvider: (done) => done(null, response.accessToken)
    });
}

// --- Shared Core Logic (Reused by Widget and Vapi) ---

async function checkAvailabilityLogic(date) {
    console.log("Checking Outlook availability for input:", date);
    // Sanitize: take only YYYY-MM-DD even if full ISO string is provided
    const dateArg = (date && typeof date === 'string') ? date.split('T')[0] : new Date().toISOString().split('T')[0];

    console.log("Sanitized dateArg:", dateArg);
    const client = await getGraphClient();
    // Query the ENTIRE day in UTC to ensure no timezone gaps
    const startDateTime = `${dateArg}T00:00:00Z`;
    const endDateTime = `${dateArg}T23:59:59Z`;

    const events = await client.api(`/users/${process.env.MS_USER_EMAIL}/calendarView`)
        .query({ startDateTime, endDateTime })
        .select('start,end,subject')
        .get();

    // Map to a cleaner format showing both start and end times
    const busyBlocks = events.value.map(event => {
        return {
            start: event.start.dateTime.split('T')[1].substring(0, 5),
            end: event.end.dateTime.split('T')[1].substring(0, 5),
            subject: event.subject
        };
    });

    return {
        dateChecked: dateArg,
        timezone: "EST (Naples, FL)",
        message: `Found ${events.value.length} appointments for this date.`,
        busyBlocks: busyBlocks
    };
}

async function bookAppointmentLogic(args) {
    const { date, time, name, phone, address } = args;
    console.log("Booking Outlook appointment for:", name);

    // Sanitize date for booking as well
    const sanitizedDate = (date && typeof date === 'string') ? date.split('T')[0] : new Date().toISOString().split('T')[0];

    const client = await getGraphClient();
    const startTime = new Date(`${sanitizedDate} ${time}`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    const event = {
        subject: `GC Pro West Appointment: ${name}`,
        body: {
            contentType: 'HTML',
            content: `<b>Customer:</b> ${name}<br><b>Phone:</b> ${phone}<br><b>Address:</b> ${address}`
        },
        start: { dateTime: startTime.toISOString(), timeZone: 'UTC' },
        end: { dateTime: endTime.toISOString(), timeZone: 'UTC' },
        location: { displayName: address }
    };

    try {
        const response = await client.api(`/users/${process.env.MS_USER_EMAIL}/events`).post(event);
        console.log("OUTLOOK BOOKING SUCCESS:", response.id);

        // --- Automatic Email Confirmation ---
        try {
            const mail = {
                message: {
                    subject: `Appointment Confirmed: GC Pro West Renovation`,
                    body: {
                        contentType: 'HTML',
                        content: `
                            <h2>Hi ${name},</h2>
                            <p>Your renovation consultation with GC Pro West is confirmed!</p>
                            <p><b>Date:</b> ${sanitizedDate}<br>
                            <b>Time:</b> ${time}<br>
                            <b>Address:</b> ${address}</p>
                            <p>We look forward to seeing you then!</p>
                            <hr>
                            <p><i>GC Pro West Renovation Center</i><br>239-307-8020</p>
                        `
                    },
                    toRecipients: [{ emailAddress: { address: process.env.MS_USER_EMAIL } }] // Sending to user email as fallback/copy
                },
                saveToSentItems: "true"
            };
            await client.api(`/users/${process.env.MS_USER_EMAIL}/sendMail`).post(mail);
            console.log("CONFIRMATION EMAIL SENT");
        } catch (mailErr) {
            console.error("FAILED TO SEND EMAIL:", mailErr.message);
        }

        return { status: "confirmed", system: "Microsoft Outlook", id: response.id, message: "Appointment booked and confirmation email sent." };
    } catch (err) {
        console.error("OUTLOOK BOOKING ERROR:", err.message);
        if (err.body) console.error("Error Body:", err.body);
        throw err;
    }
}

async function getCurrentTimeLogic() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });
    const estTime = formatter.format(now);
    console.log("Current Time Requested (EST):", estTime);
    return {
        currentTime: estTime,
        timezone: "EST (Naples, FL)",
        message: `The current time in Naples, FL is ${estTime}.`
    };
}

// --- Vapi Webhook Endpoint ---

app.post('/webhook', async (req, res) => {
    console.log("RECEIVED VAPI WEBHOOK:", JSON.stringify(req.body, null, 2));

    const message = req.body.message;
    if (!message) return res.status(200).json({ status: "ignored" });

    if (message.type === 'tool-calls') {
        const toolCalls = message.toolCalls;
        const results = [];

        for (const toolCall of toolCalls) {
            let result = {};
            try {
                const funcName = toolCall.function.name;
                let args = toolCall.function.arguments;

                if (typeof args === 'string') {
                    try {
                        args = JSON.parse(args);
                    } catch (pe) {
                        console.error("Failed to parse arguments string:", args);
                    }
                }

                console.log(`EXECUTING TOOL: ${funcName}`, args);

                if (funcName === 'checkAvailability') {
                    result = await checkAvailabilityLogic(args.date);
                } else if (funcName === 'bookAppointment') {
                    result = await bookAppointmentLogic(args);
                } else if (funcName === 'getCurrentTime') {
                    result = await getCurrentTimeLogic();
                }

                results.push({
                    toolCallId: toolCall.id,
                    result: JSON.stringify(result)
                });
            } catch (error) {
                console.error("VAPI TOOL ERROR:", error.message);
                results.push({
                    toolCallId: toolCall.id,
                    result: JSON.stringify({ error: error.message })
                });
            }
        }
        return res.status(200).json({ results });
    }

    return res.status(200).json({ status: "ignored" });
});

// --- Existing Browser Widget (WebSocket) Logic ---

app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/', (req, res) => {
    res.send('GC Pro West Voice Agent Backend is running. Frontend / index.html available.');
});

wss.on('connection', (ws_client) => {
    console.log('Client connected');

    const url = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

    let ws_gemini;
    try {
        ws_gemini = new WebSocket(url);
    } catch (e) {
        console.error("Failed to connect to Gemini:", e);
        ws_client.close();
        return;
    }

    ws_gemini.on('open', () => {
        console.log("Connected to Gemini API");

        const setupMessage = {
            setup: {
                model: MODEL,
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
                    }
                },
                systemInstruction: {
                    parts: [{ text: SYSTEM_INSTRUCTIONS }]
                },
                tools: [{
                    functionDeclarations: [
                        {
                            name: "getCurrentTime",
                            description: "Get the current time in Naples, FL (EST). Use this to know what time it is right now.",
                            parameters: { type: "OBJECT", properties: {} }
                        },
                        {
                            name: "checkAvailability",
                            description: "Check if a specific date is available for an appointment in Outlook.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    date: { type: "STRING", description: "Date to check in YYYY-MM-DD format." }
                                },
                                required: ["date"]
                            }
                        },
                        {
                            name: "bookAppointment",
                            description: "Book an appointment in Outlook calendar.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    date: { type: "STRING", description: "Date of appointment in YYYY-MM-DD format." },
                                    time: { type: "STRING", description: "Time of appointment (e.g., 14:00)" },
                                    name: { type: "STRING", description: "Name of the customer" },
                                    phone: { type: "STRING", description: "Phone number" },
                                    address: { type: "STRING", description: "Address for outcall" }
                                },
                                required: ["date", "time", "name", "address"]
                            }
                        }
                    ]
                }]
            }
        };
        ws_gemini.send(JSON.stringify(setupMessage));

        setTimeout(() => {
            if (ws_gemini.readyState === WebSocket.OPEN) {
                const initialTrigger = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "User connected. Say exactly: 'Welcome to GC Pro West Renovation Center. I am a virtual assistant. How can I help you today?'" }]
                        }],
                        turnComplete: true
                    }
                };
                ws_gemini.send(JSON.stringify(initialTrigger));
            }
        }, 3000);
    });

    ws_gemini.on('message', async (data) => {
        try {
            const response = JSON.parse(data.toString());
            let functionCall = null;

            if (response.toolCall && response.toolCall.functionCalls && response.toolCall.functionCalls.length > 0) {
                functionCall = response.toolCall.functionCalls[0];
            } else if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.functionCall) {
                        functionCall = part.functionCall;
                        break;
                    }
                }
            }

            if (functionCall) {
                console.log("TOOL CALL:", functionCall.name);
                let result = {};
                try {
                    if (functionCall.name === "checkAvailability") {
                        ws_client.send(JSON.stringify({ type: 'text', text: '📅 Checking Microsoft Outlook calendar...' }));
                        result = await checkAvailabilityLogic(functionCall.args.date);
                    } else if (functionCall.name === "bookAppointment") {
                        ws_client.send(JSON.stringify({ type: 'text', text: '📅 Booking appointment in Outlook...' }));
                        result = await bookAppointmentLogic(functionCall.args);
                    } else if (functionCall.name === "getCurrentTime") {
                        result = await getCurrentTimeLogic();
                    }
                } catch (error) {
                    console.error("WIDGET TOOL ERROR:", error.message);
                    result = { error: error.message };
                }

                const toolResponse = {
                    toolResponse: {
                        functionResponses: [{
                            id: functionCall.id,
                            name: functionCall.name,
                            response: { result: result }
                        }]
                    }
                };
                ws_gemini.send(JSON.stringify(toolResponse));
            }

            if (response.serverContent && response.serverContent.turnComplete) {
                ws_client.send(JSON.stringify({ type: 'turnComplete' }));
            }

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData) {
                        ws_client.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }));
                    } else if (part.text) {
                        ws_client.send(JSON.stringify({ type: 'text', text: part.text }));
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing Gemini message:", e);
        }
    });

    ws_client.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'audio') {
                const audioMessage = {
                    realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: parsed.data }] }
                };
                if (ws_gemini.readyState === WebSocket.OPEN) ws_gemini.send(JSON.stringify(audioMessage));
            } else if (parsed.type === 'text') {
                const textMessage = {
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text: parsed.text }] }],
                        turnComplete: true
                    }
                };
                if (ws_gemini.readyState === WebSocket.OPEN) ws_gemini.send(JSON.stringify(textMessage));
            }
        } catch (e) {
            console.error("Error handling client message:", e);
        }
    });

    ws_client.on('close', () => {
        if (ws_gemini && ws_gemini.readyState === WebSocket.OPEN) ws_gemini.close();
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
