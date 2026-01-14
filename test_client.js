const WebSocket = require('ws');

const WS_URL = 'wss://gcprowest-voice-agent.onrender.com';

console.log(`Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL);

let receivedAudio = false;
let messageCount = 0;

ws.on('open', () => {
    console.log('Connected to server');
    // We don't need to send anything, the server should trigger the greeting automatically.
    // But verify if the server expects any initial handshake? 
    // Looking at server.js: wss.on('connection') -> connects to Gemini -> sends setup -> sends initialTrigger.
    // It doesn't wait for client message.
});

ws.on('message', (data) => {
    messageCount++;
    try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'audio') {
            console.log('RECEIVED AUDIO CHUNK!');
            receivedAudio = true;
            ws.close();
            process.exit(0);
        } else {
            console.log('Received non-audio message:', parsed);
        }
    } catch (e) {
        console.log('Received raw data:', data.toString().substring(0, 50) + "...");
    }
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    process.exit(1);
});

ws.on('close', () => {
    console.log('Connection closed');
    if (!receivedAudio) {
        console.error('FAILED: Connection closed without receiving audio.');
        process.exit(1);
    }
});

// Timeout after 15 seconds (gemini can be slow to start)
setTimeout(() => {
    if (!receivedAudio) {
        console.error('TIMEOUT: Did not receive audio within 15 seconds.');
        console.log(`Total messages received: ${messageCount}`);
        ws.close();
        process.exit(1);
    }
}, 15000);
