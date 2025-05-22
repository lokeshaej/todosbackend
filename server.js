const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');


try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {

    console.error("Error initializing Firebase Admin SDK:", error.message);
    console.warn("Attempting to initialize with serviceAccountKey.json directly. Ensure it's present and correctly configured.");
    // Fallback if applicationDefault fails, assuming serviceAccountKey.json is in the same directory
    try {
        const serviceAccount = require('./firebaseAdminConfig.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin SDK initialized successfully using serviceAccountKey.json.");
    }
    catch (fallbackError) {
        console.error("Failed to initialize Firebase Admin SDK even with direct serviceAccountKey.json:", fallbackError.message);
        console.error("Please ensure 'serviceAccountKey.json' is in the same directory as server.js OR 'GOOGLE_APPLICATION_CREDENTIALS' environment variable is set correctly.");
        process.exit(1); // Exit if Firebase Admin SDK cannot be initialize
    }
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // Enable CORS for all origins
app.use(bodyParser.json()); // Parse JSON request bodies


const GEMINI_API_KEY = "AIzaSyDM09oq_7jzDqywdMJg4pTRwKVv62vg9P4"; 
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || 'https://hooks.slack.com/services/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';

// Middleware to log user ID (optional, for debugging/tracking)
app.use((req, res, next) => {
    req.userId = req.headers['x-user-id'] || 'anonymous'; // Get userId from header
    next();
});

// --- API Endpoints ---

// Endpoint to summarize a single todo item using Gemini LLM
app.post('/summarize-single-todo', async (req, res) => {
    const { text, dueDate, dueTime, userId } = req.body;
    let prompt = `Description Answer and Summarize  the following todo item: "${text}"`;

    if (dueDate) {
        prompt += ` due on ${dueDate}`;
    }
    if (dueTime) {
        prompt += ` at ${dueTime}`;
    }
    // Updated instructions for summary length and bullet points
    prompt += `. Provide a concise answer and summary of approximately 2 to 3 line answer and summary 4 to 5 lines, between 100 and 299 words. Format the summary as a bulleted list, ensuring each point is action-oriented.`;

    let summary = "";

    try {
        // Call Gemini LLM to generate summary using Axios
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

        const llmResponse = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        const llmResult = llmResponse.data; // Axios automatically parses JSON into .data

        if (llmResult.candidates && llmResult.candidates.length > 0 &&
            llmResult.candidates[0].content && llmResult.candidates[0].content.parts &&
            llmResult.candidates[0].content.parts.length > 0) {
            summary = llmResult.candidates[0].content.parts[0].text;
        } else {
            console.error("LLM response structure unexpected for single todo:", llmResult);
            
        }
        res.status(200).json({ message: 'Single todo summary generated successfully.', summary: summary });

    } catch (llmError) {
        console.error("Error calling Gemini LLM for single todo:", llmError.response?.data || llmError.message);
         }
});


// Endpoint to send a single todo (and its summary) to Slack
app.post('/send-single-todo-to-slack', async (req, res) => {
    const { text, dueDate, dueTime, summary, userId } = req.body; // 'summary' is now optional, as it might be pre-generated
    let slackMessage = `*New Todo Alert for User ${userId}*:\n`;
    slackMessage += `*Task*: ${text}\n`;
    if (dueDate) {
        slackMessage += `*Due Date*: ${dueDate}\n`;
    }
    if (dueTime) {
        slackMessage += `*Due Time*: ${dueTime}\n`;
    }
    if (summary) {
        slackMessage += `*Summary*: ${summary}\n`;
    } else {
        slackMessage += `_No summary provided._\n`;
    }

    try {
        if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === 'YOUR_SLACK_WEBHOOK_URL_HERE') {
            throw new Error("Slack Webhook URL is not configured in the backend.");
        }

        const slackResponse = await axios.post(SLACK_WEBHOOK_URL, { text: slackMessage }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (slackResponse.status >= 200 && slackResponse.status < 300) { // Axios throws for 4xx/5xx by default
            res.status(200).json({ message: 'Todo sent to Slack successfully!' });
        } else {
            // This block might not be reached if Axios throws an error for non-2xx codes
            console.error("Error sending to Slack:", slackResponse.status, slackResponse.data);
            res.status(slackResponse.status).json({ error: `Failed to send todo to Slack: ${slackResponse.data || 'Unknown error'}` });
        }
    } catch (slackError) {
        console.error("Error in /send-single-todo-to-slack endpoint:", slackError.response?.data || slackError.message);
        res.status(slackError.response?.status || 500).json({ error: `Internal server error: ${slackError.response?.data?.error || slackError.message}` });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
