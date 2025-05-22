const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch'); // Ensure node-fetch is installed: npm install node-fetch

// NEW Firebase Admin SDK initialization for Vercel
// This block expects the FIREBASE_SERVICE_ACCOUNT_KEY environment variable
// to be set in Vercel with the Base64 encoded content of your Firebase service account JSON file.
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  try {
    // Decode the base64 encoded service account key JSON string
    const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully using Vercel environment variable.");
  } catch (error) {
    console.error("Error initializing Firebase Admin SDK from environment variable:", error.message);
    process.exit(1); // Exit if Firebase Admin SDK cannot be initialized
  }
} else {
  console.error("FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set. Firebase Admin SDK not initialized.");
  console.error("Please set this environment variable in your Vercel project settings.");
  process.exit(1); // Exit if Firebase Admin SDK cannot be initialized
}


const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000; // Vercel will typically use its own port, but 3000 is good for local testing

// NEW: CORS Configuration for Vercel deployment
// This restricts access to only your deployed frontend and local development.
const allowedOrigins = [
  'http://localhost:3000', // For local development
  'https://frontefront-7m2yrofu6-lokeshas-projects.vercel.app', // Your deployed frontend Vercel URL
  // Add any other specific frontend URLs if needed (e.g., development branches)
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests, or same-origin requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(bodyParser.json()); // Parse JSON request bodies

// Environment variables for API keys and Slack Webhook
// IMPORTANT: These values MUST be set in Vercel's project environment variables.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Initialize Gemini LLM
// This uses the @google/generative-ai library, which is the recommended way.
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Middleware to log user ID (optional, for debugging/tracking)
app.use((req, res, next) => {
  req.userId = req.headers['x-user-id'] || 'anonymous'; // Get userId from header
  next();
});

// --- API Endpoints ---

// Endpoint to summarize a single todo item using Gemini LLM
app.post('/summarize-single-todo', async (req, res) => {
  const { text, dueDate, dueTime, userId } = req.body;
  let prompt = `Description Answer and Summarize the following todo item: "${text}"`; // Keeping your specific prompt wording

  if (dueDate) {
    prompt += ` due on ${dueDate}`;
  }
  if (dueTime) {
    prompt += ` at ${dueTime}`;
  }
  // Updated instructions for summary length and bullet points
  prompt += `. Provide a concise answer and summary of approximately 2 to 3 lines, between 100 and 299 words. Format the summary as a bulleted list, ensuring each point is action-oriented.`;

  let summary = "";

  try {
    // Call Gemini LLM to generate summary using the initialized model
    const result = await model.generateContent(prompt);
    const response = result.response;
    summary = response.text();
    console.log(`Generated summary for single todo: ${summary}`);
    res.status(200).json({ message: 'Single todo summary generated successfully.', summary: summary });

  } catch (llmError) {
    console.error("Error calling Gemini LLM for single todo:", llmError);
    // More robust error message extraction for LLM errors
    const errorMessage = llmError.response?.data?.error?.message || llmError.message;
    res.status(500).json({ error: `Error generating summary for single todo: ${errorMessage}` });
  }
});


// Endpoint to send a single todo (and its summary) to Slack
app.post('/send-single-todo-to-slack', async (req, res) => {
  const { text, dueDate, dueTime, summary, userId } = req.body; // 'summary' is now optional, as it might be pre-generated
  const userAgent = req.headers['user-agent'] || 'Unknown User-Agent';

  if (!text) {
    return res.status(400).json({ error: 'Todo text is required.' });
  }

  let finalSummary = summary;

  // If a summary wasn't provided by the frontend, generate it now
  if (!finalSummary) {
    try {
      const prompt = `Summarize the following single to-do item for a Slack message. Keep it concise and action-oriented. Include the due date/time if provided.
      To-do: "${text}"
      Due Date: ${dueDate || 'Not specified'}
      Due Time: ${dueTime || 'Not specified'}`;

      const result = await model.generateContent(prompt);
      const response = result.response;
      finalSummary = response.text();
      console.log(`Generated summary for single todo: ${finalSummary}`);
    } catch (llmError) {
      console.error('Error generating summary for single todo:', llmError);
      // Proceed without summary if LLM fails, or send a specific error message
      finalSummary = `Could not generate summary for: "${text}".`;
    }
  }

  // Construct the Slack message payload (using Slack's Block Kit for richer messages)
  const slackMessage = {
    text: `*New Todo Update from ${userId} (${userAgent}):*\n${finalSummary}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New Todo Update from \`${userId}\`*:`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Todo:*\n${text}`,
          },
          {
            type: 'mrkdwn',
            text: `*Summary:*\n${finalSummary}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Due:* ${dueDate || 'N/A'} ${dueTime || 'N/A'} | *Sent by:* ${userAgent}`,
          },
        ],
      },
    ],
  };

  try {
    // Validate Slack Webhook URL
    if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === 'YOUR_SLACK_WEBHOOK_URL_HERE') {
      throw new Error("Slack Webhook URL is not configured in the backend environment variables.");
    }

    // Use node-fetch to send the Slack message
    const slackResponse = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(slackMessage),
    });

    if (slackResponse.ok) { // Check if the response status is 2xx
      res.status(200).json({ message: 'Todo summary sent to Slack successfully!' });
    } else {
      const errorData = await slackResponse.text(); // Read error response from Slack
      console.error('Slack API error:', slackResponse.status, errorData);
      res.status(slackResponse.status).json({ error: `Failed to send message to Slack: ${errorData}` });
    }
  } catch (error) {
    console.error('Error sending message to Slack:', error);
    res.status(500).json({ error: 'Internal server error: Could not send message to Slack.' });
  }
});


// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
