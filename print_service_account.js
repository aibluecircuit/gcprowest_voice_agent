const fs = require('fs');
try {
    const json = fs.readFileSync('./service-account.json', 'utf8');
    console.log("COPY THE LINE BELOW FOR SERVICE_ACCOUNT_JSON:");
    console.log(JSON.stringify(JSON.parse(json)));
} catch (e) {
    console.error("Error reading service-account.json:", e.message);
}
