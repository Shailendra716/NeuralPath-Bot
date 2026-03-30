// ============================================
// NeuralPath Academy - Telegram Bot Server
// ============================================
// Flow:
// 1. User sends message on Telegram
// 2. Telegram forwards it to our webhook (this server)
// 3. We send the message to Grok AI with product context
// 4. Grok generates a smart reply
// 5. We send that reply back to Telegram
// 6. We log everything to Google Sheets
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { google } = require('googleapis');
const productDetails = require('./product-details.json');

// ---- Express Setup ----
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Telegram Bot Setup ----
// polling: false because we use webhooks in production (Render)
// Polling = bot keeps asking Telegram "any new messages?"
// Webhook = Telegram PUSHES messages to us (better for servers)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false
});

// ---- Grok AI Setup ----
// Grok uses OpenAI-compatible API format
// So we use the openai library but point it to xAI's server
const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

// ---- Google Sheets Setup ----
// Service Account = a "robot" Google account that doesn't need human login
// We gave it edit access to our spreadsheet earlier
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ---- System Prompt for Grok ----
// This tells Grok WHO it is and WHAT it knows
// We inject ALL product details so it can answer any question
const systemPrompt = `${productDetails.bot_instructions.persona}

TONE: ${productDetails.bot_instructions.tone}

YOUR GOALS:
${productDetails.bot_instructions.goals.map(g => '- ' + g).join('\n')}

RULES (NEVER BREAK THESE):
${productDetails.bot_instructions.do_not.map(d => '- ' + d).join('\n')}

LEAD COLLECTION: ${productDetails.bot_instructions.lead_collection_flow}

ESCALATION: ${productDetails.bot_instructions.escalation_trigger}

=== COMPANY INFO ===
Company: ${productDetails.company.name}
Tagline: ${productDetails.company.tagline}
Website: ${productDetails.company.website}
Email: ${productDetails.company.email}
Phone: ${productDetails.company.phone}
About: ${productDetails.company.about}

=== COURSES ===
${productDetails.courses.map(c => `
${c.name} (${c.id})
   Level: ${c.level} | Duration: ${c.duration}
   Price: Rs.${c.price} -> Rs.${c.discounted_price} (EMI: ${c.emi_amount || 'N/A'})
   ${c.description}
   Topics: ${c.topics.join(', ')}
   Projects: ${c.projects.join(', ')}
   Certificate: ${c.certificate ? 'Yes' : 'No'} | Job Assistance: ${c.job_assistance ? 'Yes' : 'No'}
   Tutor: ${c.tutor.name} - ${c.tutor.title}
   Next Batch: ${c.next_batch} | Seats Left: ${c.seats_left}/${c.total_seats}
   Rating: ${c.rating}/5 (${c.reviews_count} reviews, ${c.students_enrolled} students)
   ${c.extras ? 'Extras: ' + c.extras.join(', ') : ''}
`).join('\n')}

=== TESTIMONIALS ===
${productDetails.testimonials.map(t => `"${t.text}" - ${t.name}, ${t.role} (${t.course})`).join('\n')}

=== FAQ ===
${productDetails.faq.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}

IMPORTANT FORMATTING RULES:
- Keep replies SHORT (under 300 words) - this is Telegram, not email
- Use emojis naturally but don't overdo it
- Use line breaks for readability
- When listing courses, use a clean format
- If someone asks about pricing, ALWAYS mention the discounted price and EMI option
- If someone seems interested, gently start the lead collection flow
- When you detect the user has shared their name, email, phone, or course interest, include a JSON block at the END of your message in this exact format (the user won't see this, our system extracts it):
  <!--LEAD:{"name":"...","email":"...","phone":"...","course_interest":"..."}-->
  Only include fields that the user has actually provided.
`;

// ---- Conversation Memory ----
// Store recent messages per user so Grok remembers context
// Example: User says "tell me about AI courses" then "how much?"
// Grok needs to know "how much?" refers to the courses it just mentioned
const conversationHistory = {};
const MAX_HISTORY = 20; // Keep last 20 messages per user

function getHistory(userId) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [];
  }
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---- Chat with Grok ----
async function chatWithGrok(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);

  try {
    const response = await grok.chat.completions.create({
      model: 'grok-3-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...getHistory(userId)
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const reply = response.choices[0].message.content;
    addToHistory(userId, 'assistant', reply);
    return reply;
  } catch (error) {
    console.error('Grok API error:', error.message);
    return "I'm having a small technical issue right now. Please try again in a moment, or reach out to us at hello@neuralpath.academy";
  }
}

// ---- Log to Google Sheets ----
async function logToSheet(sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [values]
      }
    });
  } catch (error) {
    console.error(`Error logging to ${sheetName}:`, error.message);
  }
}

// ---- Setup Sheets with Headers ----
// Runs once on server start - creates sheets if they don't exist
async function setupSheets() {
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });
    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    const requiredSheets = {
      'Conversations': ['Timestamp', 'User ID', 'Username', 'First Name', 'Message', 'Bot Reply'],
      'Leads': ['Timestamp', 'User ID', 'Username', 'Name', 'Email', 'Phone', 'Course Interest', 'Source']
    };

    for (const [sheetName, headers] of Object.entries(requiredSheets)) {
      if (!existingSheets.includes(sheetName)) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [{
              addSheet: { properties: { title: sheetName } }
            }]
          }
        });

        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] }
        });
        console.log(`Created sheet: ${sheetName}`);
      }
    }
    console.log('Google Sheets ready');
  } catch (error) {
    console.error('Sheets setup error:', error.message);
  }
}

// ---- Extract Lead Data from Grok's Reply ----
// Grok hides lead info in <!--LEAD:{...}--> tags
// We extract it, save to Sheets, then remove the tag before sending to user
async function extractAndSaveLead(userId, username, botReply) {
  const leadMatch = botReply.match(/<!--LEAD:(.*?)-->/);
  if (leadMatch) {
    try {
      const leadData = JSON.parse(leadMatch[1]);
      await logToSheet('Leads', [
        new Date().toISOString(),
        userId,
        username || '',
        leadData.name || '',
        leadData.email || '',
        leadData.phone || '',
        leadData.course_interest || '',
        'Telegram Bot'
      ]);
      console.log('Lead saved:', leadData);
    } catch (e) {
      console.error('Lead parse error:', e.message);
    }
  }
}

function cleanReply(reply) {
  return reply.replace(/<!--LEAD:.*?-->/g, '').trim();
}

// ---- WEBHOOK ENDPOINT ----
// Telegram sends ALL messages to this URL
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const username = update.message.from.username || '';
      const firstName = update.message.from.first_name || '';
      const userMessage = update.message.text;

      console.log(`[${firstName}/@${username}]: ${userMessage}`);

      let botReply;

      // /start = first message when user opens bot
      if (userMessage === '/start') {
        botReply = `Hey ${firstName}! Welcome to NeuralPath Academy!\n\nI'm Neura, your AI learning assistant. I can help you with:\n\nExplore our AI courses\nPricing & EMI options\nUpcoming batch dates\nAny questions about learning AI\n\nWhat would you like to know?`;
        addToHistory(userId, 'user', userMessage);
        addToHistory(userId, 'assistant', botReply);
      } else {
        botReply = await chatWithGrok(userId, userMessage);
      }

      // Save lead if Grok detected one
      await extractAndSaveLead(userId, username, botReply);

      // Remove lead tag before sending to user
      const cleanedReply = cleanReply(botReply);

      // Send reply on Telegram
      await bot.sendMessage(chatId, cleanedReply);

      // Log to Google Sheets
      await logToSheet('Conversations', [
        new Date().toISOString(),
        userId,
        username,
        firstName,
        userMessage,
        cleanedReply
      ]);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.sendStatus(200);
  }
});

// ---- Health Check ----
// Render pings this to know our server is alive
app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    bot: 'NeuralPath Academy Telegram Bot',
    version: '1.0.0'
  });
});

// ---- Webhook Setup ----
// Hit this URL once after deploying to tell Telegram where to send messages
app.get('/setup-webhook', async (req, res) => {
  const webhookUrl = req.query.url;
  if (!webhookUrl) {
    return res.json({
      error: 'Provide ?url=YOUR_RENDER_URL/webhook',
      example: 'https://your-app.onrender.com/setup-webhook?url=https://your-app.onrender.com/webhook'
    });
  }

  try {
    const result = await bot.setWebHook(webhookUrl);
    res.json({ success: true, webhook_set_to: webhookUrl });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ---- Start Server ----
app.listen(PORT, async () => {
  console.log(`\nNeuralPath Bot running on port ${PORT}`);
  console.log(`Webhook endpoint: /webhook`);
  console.log(`Setup webhook: /setup-webhook?url=YOUR_URL/webhook`);
  console.log(`Health check: /\n`);

  await setupSheets();
});
