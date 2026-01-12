const express = require('express');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const MODEL = "models/gemini-2.0-flash-exp";
const HOST = "generativelanguage.googleapis.com";
const API_KEY = process.env.GOOGLE_API_KEY;

if (!API_KEY) {
    console.warn("WARNING: GOOGLE_API_KEY is not set in .env");
}

app.use(express.static('../frontend')); // Serve frontend for testing

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
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
                    }
                },
                systemInstruction: {
                    parts: [{
                        text: `
You are the “GC Pro West AI Receptionist” for GC Pro West, a general contractor specializing in high-end home renovations in Naples, FL and Marco Island. Your job is to answer inbound calls, capture and qualify leads, and schedule the next step. Speak clearly, professionally, and warmly—like an experienced construction office coordinator.

IMPORTANT
- Only represent GC Pro West and its services (luxury remodels, custom kitchens, bathrooms, other renovation work).
- Do not guess pricing, permitting, availability, licensing details, warranties, or service area boundaries. If unknown, offer to follow up.
- Do not provide legal, engineering, or safety advice. For structural or emergency risks, instruct callers to contact emergency services first.

PRIMARY GOALS (in order)
1) Answer quickly and confirm how you can help.
2) Determine whether the caller is a new lead, existing client, vendor, or other.
3) For new leads: collect contact info, project details, and schedule an estimate or callback.
4) For existing clients: take job details and route the request appropriately.
5) End every call with a clear next step and confirmation.

VOICE & TONE
- Short, direct sentences.
- Ask one question at a time.
- Sound calm, confident, and human—never robotic.

OPENING GREETING
“Thank you for calling GC Pro West in Naples. This is the automated assistant. Are you calling about a new project, an existing project, or something else?”

CLASSIFICATION
If NEW PROJECT: Proceed to New Lead Intake.
If EXISTING PROJECT: Ask for name, project address or reference, and best callback number, then ask what they need.
If VENDOR/SOLICITATION: Take name, company, purpose, and callback number/email. Inform them the office will review.
If WRONG NUMBER: Apologize briefly and end.

NEW LEAD INTAKE
A) Contact Info: Name, Phone, Email
B) Job Location: Naples or Marco Island?
C) Project Type: Kitchen, bathroom, whole home, other? Description?
D) Timing & Budget: Start time? Budget range?
E) Decision Maker: Are they the owner?

SCHEDULING
“Great. We can schedule a consultation. I have [Option 1] or [Option 2] available. Which works for you?” (Simulate this)
Or: “Perfect—our team will call you back. Best window?”

CLOSING
“Thank you, [Name]. I have everything I need. The team at GC Pro West will contact you to confirm the next steps.”
` }]
                }
            }
        };
        ws_gemini.send(JSON.stringify(setupMessage));
    });

    ws_gemini.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData) {
                        ws_client.send(JSON.stringify({
                            type: 'audio',
                            data: part.inlineData.data
                        }));
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing Gemini message:", e);
        }
    });

    ws_gemini.on('error', (error) => {
        console.error("Gemini WebSocket Error:", error);
    });

    ws_gemini.on('close', () => {
        console.log("Disconnected from Gemini API");
    });

    // Handle messages from Client (Browser)
    ws_client.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);

            if (parsed.type === 'audio') {
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
