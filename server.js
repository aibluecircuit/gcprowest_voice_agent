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

// --- Global Cache for Microsoft Graph ---
let cachedGraphClient = null;
let tokenExpiry = 0;

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

const getSystemInstructions = () => {
    const options = { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Intl.DateTimeFormat('en-US', options).format(new Date());

    return `
You are the “GC Pro West AI Receptionist”. Your job is to answer calls, qualify leads, and schedule appointments.
You have access to a Microsoft Outlook calendar. 
- When asked for availability, use the 'checkAvailability' tool.
- When the user confirms a time, use the 'bookAppointment' tool.
- NOTIFICATIONS: You automatically send an Email confirmation via Outlook immediately after booking.
Always confirm the details before booking.
IMPORTANT RULES:
- TODAY'S DATE: ${today} (Timezone: Naples, FL / EST).
- DATE AWARENESS: DO NOT ask the user for the current date or time. You already know it. 
- Use the date above to interpret "today", "tomorrow", or "next week".
- We ONLY do outcall appointments (we go to the customer).
- You MUST ask for the customer's ADDRESS before booking an appointment.
- Operating Hours are 8:00 AM to 5:00 PM (EST), Monday to Friday.
- PERSONALITY: Be energetic, friendly, and "real". Use natural language and contractions.
- KNOWLEDGE BASE: GC Pro West Renovation Center. 5746 Woodmere Lake Cir, Naples, FL 34112.
- GUARDRAILS: You must ONLY answer questions about GC Pro West services and appointments.
IMPORTANT: Do NOT write Python code. Return valid Tool/Function calls.
`;
};

const msalConfig = {
    auth: {
        clientId: MS_CLIENT_ID || "MISSING",
        authority: `https://login.microsoftonline.com/${MS_TENANT_ID || 'common'}`,
        clientSecret: MS_CLIENT_SECRET || "MISSING",
    }
};

const cca = new ConfidentialClientApplication(msalConfig);

async function getGraphClient() {
    // Return cached client if it exists and token is likely still valid (Graph tokens last 60m)
    if (cachedGraphClient && Date.now() < tokenExpiry) {
        return cachedGraphClient;
    }

    console.log("[MS GRAPH] Acquiring new access token...");
    const tokenRequest = { scopes: ['https://graph.microsoft.com/.default'] };
    const response = await cca.acquireTokenByClientCredential(tokenRequest);

    // Set expiry to 5 minutes before actual expiry to be safe (response.expiresOn is a Date object)
    tokenExpiry = new Date(response.expiresOn).getTime() - (5 * 60 * 1000);

    cachedGraphClient = Client.init({
        authProvider: (done) => done(null, response.accessToken)
    });

    return cachedGraphClient;
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

    const options = { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const todayFormatted = new Intl.DateTimeFormat('en-US', options).format(new Date());

    return {
        _SYSTEM_MESSAGE_: `Today's current date is ${todayFormatted}. Use this to interpret "tomorrow" or "next week".`,
        today: todayFormatted,
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

    // Robust parsing for common time strings
    let cleanTime = time;
    if (time.toLowerCase().includes("am") || time.toLowerCase().includes("pm")) {
        // Simple conversion if needed, but new Date() often handles it.
    }

    const startDateTimeStr = `${sanitizedDate}T${time.includes(':') && time.length === 5 ? time : time.padStart(5, '0')}:00`;
    console.log(`[DEBUG] Attempting to create Date with: ${sanitizedDate} ${time}`);
    const startTime = new Date(`${sanitizedDate} ${time}`);

    if (isNaN(startTime.getTime())) {
        console.error("INVALID DATE DETECTED:", sanitizedDate, time);
        throw new Error(`The provided time "${time}" is not in a valid format. Please use HH:mm (e.g., 14:00).`);
    }

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
        console.log(`[OUTLOOK] Posting event for ${name} at ${sanitizedDate} ${time}...`);
        const response = await client.api(`/users/${process.env.MS_USER_EMAIL}/events`).post(event);
        console.log("OUTLOOK BOOKING SUCCESS:", response.id);

        // --- BACKGROUND: Automatic Email Confirmation (Non-blocking) ---
        (async () => {
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
                        toRecipients: [{ emailAddress: { address: process.env.MS_USER_EMAIL } }]
                    },
                    saveToSentItems: "true"
                };
                await client.api(`/users/${process.env.MS_USER_EMAIL}/sendMail`).post(mail);
                console.log("[BG] CONFIRMATION EMAIL SENT");
            } catch (mailErr) {
                console.error("[BG] FAILED TO SEND EMAIL:", mailErr.message);
            }
        })();

        return { status: "confirmed", id: response.id, message: "Appointment booked." };
    } catch (err) {
        console.error("OUTLOOK BOOKING ERROR:", err.message);
        if (err.body) console.error("Error Body:", err.body);
        throw err;
    }
}

async function getCurrentTimeLogic() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: true,
        weekday: 'long', month: 'long', day: 'numeric'
    });
    const estTime = formatter.format(new Date());
    return {
        currentTime: estTime,
        message: `The current time and date in Naples, FL is ${estTime}.`
    };
}

// --- Unified Tool Execution Logic ---
async function handleOneToolCall(funcName, args) {
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), 9000)
    );

    try {
        console.log(`[EXEC] ${funcName}`, args);
        let result;
        if (funcName === 'checkAvailability') {
            result = await Promise.race([checkAvailabilityLogic(args.date), timeoutPromise]);
        } else if (funcName === 'bookAppointment') {
            result = await Promise.race([bookAppointmentLogic(args), timeoutPromise]);
        } else if (funcName === 'getCurrentTime') {
            result = await Promise.race([getCurrentTimeLogic(), timeoutPromise]);
        } else {
            result = { error: "Unknown function" };
        }
        return result;
    } catch (err) {
        console.error(`[TOOL ERROR] ${funcName}:`, err.message);
        return { error: err.message === 'TIMEOUT' ? "Service busy, try again." : err.message };
    }
}

app.post('/webhook', async (req, res) => {
    const body = req.body;
    const message = body?.message;

    // Handle Assistant Request / Conversation Start (Dynamic Date Injection for Vapi)
    if (message?.type === 'assistant-request' || message?.type === 'conversation-start' || message?.type === 'vapi-request') {
        const fullInstructions = getSystemInstructions();
        console.log(`[VAPI] Injecting dynamic instructions for message type: ${message.type}`);

        // Return redundant structure for maximum compatibility
        return res.status(200).json({
            assistant: {
                model: {
                    messages: [{ role: "system", content: fullInstructions }]
                }
            },
            assistantOverrides: {
                model: {
                    messages: [{ role: "system", content: fullInstructions }]
                }
            }
        });
    }

    if (!message || message.type !== 'tool-calls') {
        return res.status(200).json({ status: "processed" });
    }

    const toolCalls = message.toolCalls || [];
    const results = await Promise.all(toolCalls.map(async (tc) => {
        const funcName = tc.function.name;
        let args = tc.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { } }

        const result = await handleOneToolCall(funcName, args);
        return { toolCallId: tc.id, result: JSON.stringify(result) };
    }));

    return res.status(200).json({ results });
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
        console.log(`[WIDGET] Connecting to Gemini Bidi: ${MODEL}`);
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
                    parts: [{ text: getSystemInstructions() }]
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

        ws_gemini.send(JSON.stringify(setupMessage));
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

            if (response.setupComplete) {
                console.log("[WIDGET] Setup Complete received. Triggering welcome...");
                const initialTrigger = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "User connected. Say exactly: 'Welcome to GC Pro West Renovation Center. I am a virtual assistant. How can I help you today?'" }]
                        }],
                        turnComplete: true
                    }
                };
                if (ws_gemini.readyState === WebSocket.OPEN) ws_gemini.send(JSON.stringify(initialTrigger));
            }

            if (functionCall) {
                const funcName = functionCall.name;
                const args = functionCall.args || {};

                // Show thinking status in UI
                if (funcName !== "getCurrentTime") {
                    ws_client.send(JSON.stringify({ type: 'text', text: `📅 Accessing Outlook for ${funcName}...` }));
                }

                const result = await handleOneToolCall(funcName, args);

                const toolResponse = {
                    toolResponse: {
                        functionResponses: [{
                            id: functionCall.id,
                            name: funcName,
                            response: { result: result }
                        }]
                    }
                };
                if (ws_gemini.readyState === WebSocket.OPEN) ws_gemini.send(JSON.stringify(toolResponse));
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
            console.error("[WIDGET] Error parsing Gemini message:", e);
            console.error("[WIDGET] Raw Data:", data.toString().substring(0, 500));
        }
    });

    ws_client.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'audio') {
                const audioMessage = {
                    realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: parsed.data }] }
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
