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

// Config - Replace with your deployed backend URL in production
const BACKEND_URL = 'wss://gcprowest-voice-agent.onrender.com';


async function initCall() {
    try {
        STATUS_TEXT.textContent = "Connecting...";
        STATUS_TEXT.style.color = "#666";

        // 1. Setup Audio Context
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

        // 2. Load AudioWorklet
        const processorUrl = window.VOICE_AGENT_PROCESSOR_URL || 'audio-processor.js';
        try {
            await audioContext.audioWorklet.addModule(processorUrl);
        } catch (e) {
            throw new Error(`Audio Error: Could not load '${processorUrl}'.`);
        }

        // 3. Connect to WebSocket
        ws = new WebSocket(BACKEND_URL);

        ws.onopen = () => {
            console.log("WebSocket connected");
            startRecording();
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
            // Convert Float32 to Int16 PCM
            const pcm16 = floatTo16BitPCM(event.data);
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

function handleServerMessage(event) {
    const data = JSON.parse(event.data);

    if (data.type === 'audio') {
        // Queue audio for playback
        responseQueue.push(data.data); // Expecting base64
        if (!isPlaying) {
            playNextChunk();
        }
    } else if (data.type === 'interrupted') {
        // Clear queue if AI was interrupted
        responseQueue = [];
        isPlaying = false;
    }
    else if (data.type === 'text') {
        console.log("AI:", data.text);
    }
}

async function playNextChunk() {
    if (responseQueue.length === 0) {
        isPlaying = false;
        STATUS_TEXT.textContent = "Listening...";
        return;
    }

    isPlaying = true;
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
    // We assume backend sends PCM16 24kHz or similar, or WAV. 
    // If raw PCM, we need to manually create buffer.
    // If backend sends standard WAV container, decodeAudioData works.
    // For simplicity, let's assume backend converts to WAV or sends valid format.
    // Actually, Gemini sends PCM. We need to create an AudioBuffer.

    // float32 conversion from int16
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

    const buffer = audioContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    return buffer;
}


function stopCall() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (audioContext) audioContext.close();
    if (ws) ws.close();

    CARD.classList.remove('active');
    FAB.style.display = 'flex';
    responseQueue = [];
    isPlaying = false;
}

// Helpers
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Event Listeners
FAB.addEventListener('click', initCall);
STOP_BTN.addEventListener('click', stopCall);
