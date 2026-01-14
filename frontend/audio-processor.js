class AudioProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input.length > 0) {
            const float32Data = input[0];
            const targetRate = 16000;
            const currentRate = sampleRate; // Global in AudioWorklet

            let finalData = float32Data;

            // Simple Downsampling (Decimation)
            if (currentRate > targetRate) {
                const ratio = Math.floor(currentRate / targetRate);
                const newLength = Math.floor(float32Data.length / ratio);
                const downsampled = new Float32Array(newLength);
                for (let i = 0; i < newLength; i++) {
                    downsampled[i] = float32Data[i * ratio];
                }
                finalData = downsampled;
            }

            const int16Data = this.float32ToInt16(finalData);
            this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
        }
        return true;
    }

    float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }
}

registerProcessor('audio-processor', AudioProcessor);
