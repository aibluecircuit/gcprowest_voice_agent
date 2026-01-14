// Config - Dynamic URL (Local vs Production)
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const BACKEND_URL = isLocal ? 'ws://localhost:8080' : 'wss://gcprowest-voice-agent.onrender.com';
const ASSET_URL = isLocal ? '' : 'https://gcprowest-voice-agent.onrender.com';

// Inject HTML structure
const widgetContainer = document.getElementById('voice-agent-widget-container') || document.body;
widgetContainer.innerHTML += `
<div id="voice-agent-fab">
    <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
</div>
<div id="voice-agent-card">
    <div class="agent-header">
        <img src="${ASSET_URL}/agent.png" class="agent-avatar" alt="Agent">
        <div class="agent-info">
            <div class="agent-name">Andy</div>
            <div class="agent-status" style="font-size: 0.8em; color: #eee;">Voice AI Assistant</div>
        </div>
    </div>
    
    <div id="chat-history">
        <div class="chat-message agent">Welcome to GC Pro West. How can I help you today?</div>
    </div>

    <div class="visualizer-container">
        <div class="vis-bar"></div><div class="vis-bar"></div><div class="vis-bar"></div><div class="vis-bar"></div><div class="vis-bar"></div>
    </div>

    <div class="input-area">
        <input type="text" id="chat-input" placeholder="Type a message...">
        <button id="send-btn">➤</button>
    </div>

    <button id="voice-agent-stop-btn">End Call</button>
</div>
`;

const FAB = document.getElementById('voice-agent-fab');
const CARD = document.getElementById('voice-agent-card');
const STOP_BTN = document.getElementById('voice-agent-stop-btn');
const STATUS_TEXT = document.querySelector('.agent-status');

let audioContext;
let ws;
let stream;
let audioWorkletNode;
let responseQueue = [];
let isPlaying = false;
let startTime = 0;

// State flags for Echo Suppression
let isAgentTurn = false;
let serverFinishedGenerating = false;


async function initCall() {
    try {
        STATUS_TEXT.textContent = "Connecting...";
        STATUS_TEXT.style.color = "#666";

        // 1. Setup Audio Context
        // Use 16kHz for best compatibility with Speech-to-Text models
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await audioContext.resume();

        // 2. Load AudioWorklet
        const processorUrl = window.VOICE_AGENT_PROCESSOR_URL || `${ASSET_URL}/audio-processor.js`;
        try {
            await audioContext.audioWorklet.addModule(processorUrl);
        } catch (e) {
            throw new Error(`Audio Error: Could not load '${processorUrl}'.`);
        }

        // 3. Connect to WebSocket
        ws = new WebSocket(BACKEND_URL);

        ws.onopen = () => {
            console.log("WebSocket connected");
            STATUS_TEXT.textContent = "Waiting for agent...";
            startRecording();

            // Auto-disconnect after 2 minutes (120 seconds)
            setTimeout(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log("Max conversation time reached. Disconnecting.");
                    stopCall(); // consistently use stopCall() instead of endCall()
                    addChatMessage("System: Call ended (2 min limit reached).", 'agent');
                }
            }, 120000);
        };

        ws.onmessage = handleServerMessage;

        ws.onclose = (e) => {
            console.log("WebSocket Closed", e);
            if (!e.wasClean) {
                showError(`Connection failed. Server might be asleep. Refresh in 1 min.`);
            } else {
                stopCall();
            }
        };

        ws.onerror = (e) => {
            console.error("WebSocket Error:", e);
            showError("Connection Error. Check console.");
        };

        CARD.classList.add('active');
        FAB.style.display = 'none';

        // Reset flags
        isAgentTurn = false;
        serverFinishedGenerating = false;

    } catch (err) {
        console.error("Init Error:", err);
        showError(err.message || "Microphone access denied.");
    }
}

function showError(msg) {
    STATUS_TEXT.textContent = msg;
    STATUS_TEXT.style.color = "red";
    // Also log to console for depth
    console.error("Voice Agent Error UI:", msg);
}


async function startRecording() {
    STATUS_TEXT.textContent = "Listening...";

    stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true
        }
    });

    const source = audioContext.createMediaStreamSource(stream);
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-processor');

    audioWorkletNode.port.onmessage = (event) => {
        if (ws && ws.readyState === WebSocket.OPEN) {

            // Simple Echo Suppression: If playing, mute.
            if (isPlaying) return;

            const pcm16 = event.data;

            // Visualizer feedback logic
            let sum = 0;
            const int16Data = new Int16Array(pcm16);
            for (let i = 0; i < int16Data.length; i++) {
                const floatVal = int16Data[i] / 32768.0;
                sum += floatVal * floatVal;
            }
            const rms = Math.sqrt(sum / int16Data.length);

            const bars = document.querySelectorAll('.vis-bar');
            const vol = Math.min(1, rms * 10);
            bars.forEach(bar => {
                bar.style.height = (5 + vol * 20) + 'px';
                bar.style.background = '#0f9d58';
            });

            // NO Threshold check anymore. Send everything.
            // If it's silence, Gemini will handle it.

            const base64Audio = arrayBufferToBase64(pcm16);
            ws.send(JSON.stringify({
                type: 'audio',
                data: base64Audio
            }));
        }
    };

    source.connect(audioWorkletNode);
    audioWorkletNode.connect(audioContext.destination);
}

function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(i * 2, s, true);
    }
    return buffer;
}

// Helpers
function addChatMessage(text, sender) {
    const history = document.getElementById('chat-history');
    const msg = document.createElement('div');
    msg.className = `chat-message ${sender}`;
    msg.textContent = text;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}

function sendTextMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    addChatMessage(text, 'user');
    console.log("Sending text to server:", text);

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'text',
            text: text
        }));
    }
    input.value = '';
}

// Add Listeners
document.getElementById('send-btn').addEventListener('click', sendTextMessage);
document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendTextMessage();
});

// Update handleServerMessage to show text
// Update handleServerMessage to show text
function handleServerMessage(event) {
    const data = JSON.parse(event.data);
    if (data.type === 'audio') {
        responseQueue.push(data.data);
        if (!isPlaying) playNextChunk();
    }
    else if (data.type === 'text') {
        // Show AI text in chat
        addChatMessage(data.text, 'agent');
    }
}

async function playNextChunk() {
    if (responseQueue.length === 0) {
        isPlaying = false;
        STATUS_TEXT.textContent = "Listening...";
        return;
    }

    isPlaying = true; // Lock mic
    STATUS_TEXT.textContent = "Speaking...";
    const base64 = responseQueue.shift();
    const audioBuffer = await decodeAudio(base64);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();

    source.onended = () => {
        playNextChunk();
    };
}

function decodeAudio(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // float32 conversion from int16
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

    const buffer = audioContext.createBuffer(1, float32.length, 24000); // Gemini is usually 24kHz
    buffer.getChannelData(0).set(float32);
    return buffer;
}


function stopCall() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    if (ws) ws.close();

    CARD.classList.remove('active');
    FAB.style.display = 'flex';
    responseQueue = [];
    isPlaying = false;
    isAgentTurn = false;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Main Entry Points
FAB.addEventListener('click', initCall);
STOP_BTN.addEventListener('click', stopCall);

