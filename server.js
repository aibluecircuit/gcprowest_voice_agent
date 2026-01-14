const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const { google } = require('googleapis');

// --- DEPLOYMENT HELPER: Create service-account.json from ENV if missing ---
if (!fs.existsSync('./service-account.json') && process.env.SERVICE_ACCOUNT_JSON) {
    console.log("Creating service-account.json from environment variable...");
    fs.writeFileSync('./service-account.json', process.env.SERVICE_ACCOUNT_JSON);
}

const cors = require('cors');
const app = express();
app.use(cors()); // Enable CORS for all routes (important for Worklet loading from external sites)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const MODEL = "models/gemini-2.0-flash-exp";
const HOST = "generativelanguage.googleapis.com";
const API_KEY = process.env.GOOGLE_API_KEY;

if (!API_KEY) {
    console.warn("WARNING: GOOGLE_API_KEY is not set in .env");
}

app.use(express.static(path.join(__dirname, 'frontend'))); // Serve frontend using absolute path

app.get('/', (req, res) => {
    res.send('GC Pro West Voice Agent Backend is running. Frontend available at /index.html');
});

wss.on('connection', (ws_client) => {
    console.log('Client connected');

    // Connect to Google Gemini API
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

        // Initial Setup Message with Config & System Prompt
        const setupMessage = {
            setup: {
                model: MODEL,
                generationConfig: {
                    responseModalities: ["AUDIO", "TEXT"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
                    }
                },
                systemInstruction: {
                    parts: [{
                        text: `
You are the “GC Pro West AI Receptionist”. Your job is to answer calls, qualify leads, and schedule appointments.
You have access to a calendar. 
- When asked for availability, use the 'checkAvailability' tool.
- When the user confirms a time, use the 'bookAppointment' tool.
- NOTIFICATIONS: You automatically send an Email confirmation to the customer immediately after booking. You can assure them of this.
- When the user confirms a time, use the 'bookAppointment' tool.
- When the user confirms a time, use the 'bookAppointment' tool.
Always confirm the details before booking.
IMPORTANT RULES:
- We ONLY do outcall appointments (we go to the customer).
- You MUST ask for the customer's ADDRESS before booking an appointment.
- Operating Hours are 8:00 AM to 5:00 PM, Monday to Friday.
- PERSONALITY: Be energetic, friendly, and "real". Use natural language, contractions (don't, can't), and sound like a helpful human assistant. Show enthusiasm for renovations!
- KNOWLEDGE BASE: You are the AI for "GC Pro West Renovation Center".
    - Location: 5746 Woodmere Lake Cir, Naples, FL 34112.
    - Service Areas: Naples and Marco Island.
    - Services: High-end renovations, custom kitchen remodels, luxury bathroom upgrades, cabinets.
    - Contact: 239-307-8020, info@gcprowest.com.
- GUARDRAILS: You must ONLY answer questions about GC Pro West services and appointments. If asked about anything else (weather, general knowledge, other companies), politely refuse and steer the conversation back to renovations.
IMPORTANT: Do NOT write Python code or "executableCode". You must valid "functionCall" objects.
Today's date is ${new Date().toISOString().split('T')[0]}. Use this as the reference for "today", "tomorrow", etc.
` }]
                },
                tools: [{
                    functionDeclarations: [
                        {
                            name: "checkAvailability",
                            description: "Check if a specific date is available for an appointment.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    date: { type: "STRING", description: "Date to check. YOU MUST CONVERT relative dates (like 'tomorrow') to YYYY-MM-DD format." }
                                },
                                required: ["date"]
                            }
                        },
                        {
                            name: "bookAppointment",
                            description: "Book an appointment for the user.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    date: { type: "STRING", description: "Date of appointment in YYYY-MM-DD format." },
                                    time: { type: "STRING", description: "Time of appointment" },
                                    name: { type: "STRING", description: "Name of the customer" },
                                    phone: { type: "STRING", description: "Phone number of the customer" },
                                    address: { type: "STRING", description: "Address for the outcall appointment" }
                                },
                                required: ["date", "time", "name", "address"]
                            }
                        }
                    ]
                }]
            }
        };
        ws_gemini.send(JSON.stringify(setupMessage));

        // Delay the initial trigger slightly to ensure Gemini is ready
        setTimeout(() => {
            if (ws_gemini.readyState === WebSocket.OPEN) {
                const initialTrigger = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "User connected. Say exactly: 'Welcome to GC Pro West Renovation Center. I am a virtual assistant. How can I help you?'" }]
                        }],
                        turnComplete: true
                    }
                };
                ws_gemini.send(JSON.stringify(initialTrigger));
                console.log("Sent initial greeting trigger to Gemini");
            } else {
                console.warn("Gemini socket not open, skipped initial trigger");
            }
        }, 3000);
    });

    ws_gemini.on('message', async (data) => {
        try {
            const response = JSON.parse(data.toString());
            console.log("FULL GEMINI RESPONSE:", JSON.stringify(response, null, 2)); // VERBOSE DEBUG

            // console.log("FULL GEMINI RESPONSE:", JSON.stringify(response, null, 2)); // Squelch verbose

            let functionCall = null;
            if (response.toolCall && response.toolCall.functionCalls && response.toolCall.functionCalls.length > 0) {
                functionCall = response.toolCall.functionCalls[0];
            } else if (response.toolCall && response.toolCall.functionCall) {
                functionCall = response.toolCall.functionCall;
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
                console.log("!!! FUNCTION CALL RECEIVED !!!", functionCall.name); // High visibility log
                console.time("ToolExecution");

                let result = {};

                if (functionCall.name === "checkAvailability") {
                    ws_client.send(JSON.stringify({ type: 'text', text: '📅 Checking availability in Google Calendar...' }));
                    try {
                        console.log("1. Initializing Auth...");
                        const auth = new google.auth.GoogleAuth({
                            keyFile: './service-account.json',
                            scopes: ['https://www.googleapis.com/auth/calendar']
                        });

                        console.log("2. Fetching Client...");
                        // Add timeout to auth client fetch too
                        const authClientPromise = auth.getClient();
                        const authTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Auth Timeout")), 5000));
                        const client = await Promise.race([authClientPromise, authTimeout]);

                        console.log("3. Auth successful. Email:", client.email);

                        const calendar = google.calendar({ version: 'v3', auth });

                        // Parse date argument (simple validation)
                        const dateArg = functionCall.args.date || new Date().toISOString().split('T')[0];

                        // Check the whole day (Operating hours 08:00 to 17:00)
                        const timeMin = new Date(dateArg + 'T08:00:00').toISOString();
                        const timeMax = new Date(dateArg + 'T17:00:00').toISOString();

                        console.log(`4. Querying events from ${timeMin} to ${timeMax}...`);

                        // TIMEOUT RACE: If API takes > 5s, fail.
                        const apiCall = calendar.events.list({
                            calendarId: 'aibluecircuit@gmail.com',
                            timeMin: timeMin,
                            timeMax: timeMax,
                            singleEvents: true,
                            orderBy: 'startTime',
                        });

                        const apiTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("List Events API Timeout")), 5000));

                        const events = await Promise.race([apiCall, apiTimeout]);

                        console.log("5. Events found:", events.data.items.length);

                        const busyTimes = events.data.items.map(event => {
                            const start = event.start.dateTime || event.start.date;
                            return start.split('T')[1]?.substring(0, 5); // Extract HH:MM
                        });

                        result = {
                            message: `Found ${events.data.items.length} existing appointments.`,
                            busyTimes: busyTimes // Agent will use this to deduce free slots
                        };

                    } catch (error) {
                        console.error("!!! CALENDAR ERROR !!!", error.message);
                        result = { error: "Calendar check failed: " + error.message };
                    }

                } else if (functionCall.name === "bookAppointment") {
                    ws_client.send(JSON.stringify({ type: 'text', text: '📅 Booking appointment...' }));
                    try {
                        console.log("1. Init Auth for Booking...");
                        const auth = new google.auth.GoogleAuth({
                            keyFile: './service-account.json',
                            scopes: ['https://www.googleapis.com/auth/calendar']
                        });
                        const calendar = google.calendar({ version: 'v3', auth });

                        const { date, time, name, phone, address } = functionCall.args;
                        console.log(`2. Booking for ${name} at ${date} ${time} Location: ${address}`);

                        // Construct DateTime
                        // Assume time is like "14:00" or "2:00 PM". Simple parsing needed.
                        // For demo, we just assume ISO or simple format string concat.
                        // Ideally you use a library like moment or date-fns.
                        // Here we'll try to be robust but basic:

                        const startTimeIdx = new Date(`${date} ${time}`);
                        const endTimeIdx = new Date(startTimeIdx.getTime() + 60 * 60 * 1000); // 1 hour slot

                        const event = {
                            summary: `Appointment with ${name}`,
                            location: address,
                            description: `Phone: ${phone}\nAddress: ${address}`,
                            start: { dateTime: startTimeIdx.toISOString() },
                            end: { dateTime: endTimeIdx.toISOString() },
                        };

                        const insertRes = await calendar.events.insert({
                            calendarId: 'aibluecircuit@gmail.com',
                            resource: event,
                        });
                        console.log("3. Booking success! Sending email...");

                        // Email removed as per user request
                        console.log("3. Booking success!");

                        console.log("3. Booking success!");

                        result = { status: "confirmed", link: insertRes.data.htmlLink };

                    } catch (error) {
                        console.error("!!! BOOKING ERROR !!!", error.message);
                        result = { status: "failed", error: error.message };
                    }
                }

                console.timeEnd("ToolExecution");

                const toolResponse = {
                    toolResponse: {
                        functionResponses: [
                            {
                                id: functionCall.id, // Include ID if present (mapped from request)
                                name: functionCall.name,
                                response: { result: result }
                            }
                        ]
                    }
                };
                console.log(">>> SENDING TOOL RESPONSE TO GEMINI <<<", JSON.stringify(result));
                ws_gemini.send(JSON.stringify(toolResponse));
            }

            if (response.serverContent && response.serverContent.turnComplete) {
                ws_client.send(JSON.stringify({ type: 'turnComplete' }));
            }

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData) {
                        ws_client.send(JSON.stringify({
                            type: 'audio',
                            data: part.inlineData.data
                        }));
                    } else if (part.text) {
                        console.log("Gemini Text Response:", part.text);
                        ws_client.send(JSON.stringify({
                            type: 'text',
                            text: part.text
                        }));
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing Gemini message:", e);
        }
    });


    ws_gemini.on('close', (code, reason) => {
        console.log(`Disconnected from Gemini API. Code: ${code}, Reason: ${reason}`);
    });

    // Handle messages from Client (Browser)
    let packetCount = 0;
    ws_client.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type !== 'audio') {
                console.log("DEBUG: Received Client Message:", parsed);
            }

            if (parsed.type === 'audio') {
                packetCount++;
                // if (packetCount % 50 === 0) console.log(`Received ${packetCount} audio packets from client`);

                const audioMessage = {
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm",
                            data: parsed.data
                        }]
                    }
                };

                if (ws_gemini.readyState === WebSocket.OPEN) {
                    ws_gemini.send(JSON.stringify(audioMessage));
                }
            } else if (parsed.type === 'text') {
                // Handle text input from client
                console.log("Received text from client:", parsed.text);
                const textMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: parsed.text }]
                        }],
                        turnComplete: true
                    }
                };
                if (ws_gemini.readyState === WebSocket.OPEN) {
                    ws_gemini.send(JSON.stringify(textMessage));
                }
            }

        } catch (e) {
            console.error("Error handling client message:", e);
        }
    });

    ws_client.on('close', () => {
        console.log('Client disconnected');
        if (ws_gemini && ws_gemini.readyState === WebSocket.OPEN) {
            ws_gemini.close();
        }
    });
});


server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log(`Test frontend at http://localhost:${PORT}/index.html`);
});
