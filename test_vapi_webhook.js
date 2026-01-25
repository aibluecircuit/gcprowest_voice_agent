const http = require('http');

async function testVapiWebhook() {
    console.log("Testing Vapi Webhook via HTTP...");

    const payload = JSON.stringify({
        message: {
            type: "tool-calls",
            toolCalls: [
                {
                    id: "call_testing_123",
                    type: "function",
                    function: {
                        name: "checkAvailability",
                        arguments: {
                            date: "2026-02-01"
                        }
                    }
                }
            ]
        }
    });

    const options = {
        hostname: 'localhost',
        port: 8080,
        path: '/webhook',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            console.log("Status:", res.statusCode);
            console.log("Body:", data);

            try {
                const json = JSON.parse(data);
                if (json.results && json.results[0].toolCallId === "call_testing_123") {
                    console.log("\n✅ Webhook response VERIFIED successfully!");
                } else {
                    console.log("\n❌ Unexpected response format:", data);
                }
            } catch (e) {
                console.log("\n❌ Failed to parse JSON response:", data);
            }
        });
    });

    req.on('error', (error) => {
        console.error("❌ Request Error:", error.message);
    });

    req.write(payload);
    req.end();
}

testVapiWebhook();
