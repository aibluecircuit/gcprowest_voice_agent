require('dotenv').config({ path: './backend/.env' });
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

// Helper to decode JWT roles
function decodeTokenRoles(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        const payload = JSON.parse(jsonPayload);
        return payload.roles || [];
    } catch (e) {
        return ["Error decoding roles"];
    }
}

async function testAuth() {
    console.log("--- ADVANCED DIAGNOSTICS ---");

    const msalConfig = {
        auth: {
            clientId: process.env.MS_CLIENT_ID,
            authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
            clientSecret: process.env.MS_CLIENT_SECRET,
        }
    };

    const cca = new ConfidentialClientApplication(msalConfig);

    try {
        const tokenRequest = {
            scopes: ['https://graph.microsoft.com/.default'],
        };

        const response = await cca.acquireTokenByClientCredential(tokenRequest);
        console.log("✅ Token Acquired.");

        const roles = decodeTokenRoles(response.accessToken);
        console.log("✅ Token Roles:", roles.length > 0 ? roles.join(', ') : "NONE FOUND (This is the problem!)");

        const client = Client.init({
            authProvider: (done) => {
                done(null, response.accessToken);
            },
        });

        console.log("\n1. Checking organization details...");
        try {
            // Some tenants don't allow /organization but allow /tenantRelationships/findTenantInformationByDomainName
            const org = await client.api('/organization').get();
            console.log("✅ Org Name:", org.value[0].displayName);
        } catch (e) {
            console.log("❌ Could not read /organization. This requires 'Organization.Read.All' or 'Directory.Read.All'.");
        }

        console.log("\n2. Trying to list first 3 users in tenant...");
        try {
            const users = await client.api('/users').select('displayName,userPrincipalName,mail').top(3).get();
            console.log("✅ Users found in tenant:");
            users.value.forEach(u => console.log(`   - ${u.userPrincipalName} (Mail: ${u.mail || 'N/A'})`));
        } catch (e) {
            console.log("❌ Could not list users. Error:", e.message);
        }

        console.log(`\n3. Testing Calendar Access for: ${process.env.MS_USER_EMAIL}...`);
        try {
            // Try accessing by ID if we can't find by email
            const cal = await client.api(`/users/${process.env.MS_USER_EMAIL}/calendar`).get();
            console.log("✅ Calendar access verified!");
        } catch (e) {
            console.log("❌ Calendar Error:", e.message);
        }

    } catch (error) {
        console.error("\n❌ FATAL ERROR:", error.message);
    }
}

testAuth();
