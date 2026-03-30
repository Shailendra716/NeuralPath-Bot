// ============================================
// NeuralPath Academy - Telegram Bot Server
// ============================================
// Flow:
// 1. User sends message on Telegram
// 2. Telegram forwards it to our webhook (this server)
// 3. We send the message to Gemini AI with product context
// 4. Gemini generates a smart reply
// 5. We send that reply back to Telegram
// 6. We log everything to Google Sheets
// ============================================

// Catch any unhandled errors so we can see what crashed
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT ERROR:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED PROMISE:', err);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

// ---- Gemini AI Setup ----
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 1000
  }
});

// ---- Google Sheets Setup ----
// Service Account = a "robot" Google account that doesn't need human login
// We gave it edit access to our spreadsheet earlier
// The private key might have literal \n or real newlines depending on how
// the env var was set — we handle both cases
let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
// If the key is wrapped in quotes (from .env file), remove them
if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
  privateKey = privateKey.slice(1, -1);
}
// Replace literal \n with real newlines
privateKey = privateKey.replace(/\\n/g, '\n');

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: privateKey
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ---- System Prompt for Gemini ----
// This tells Gemini WHO it is and WHAT it knows
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
// Store recent messages per user so Gemini remembers context
// Example: User says "tell me about AI courses" then "how much?"
// Gemini needs to know "how much?" refers to the courses it just mentioned
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
  // Gemini uses 'user' and 'model' roles (not 'assistant')
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---- Simple Rate Limiting ----
// Prevent abuse: max 10 messages per user per minute
const rateLimits = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_MESSAGES_PER_WINDOW = 10;

function isRateLimited(userId) {
  const now = Date.now();
  if (!rateLimits[userId]) {
    rateLimits[userId] = [];
  }
  // Remove old timestamps
  rateLimits[userId] = rateLimits[userId].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimits[userId].length >= MAX_MESSAGES_PER_WINDOW) {
    return true;
  }
  rateLimits[userId].push(now);
  return false;
}

// ---- Chat with Gemini ----
async function chatWithGemini(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);

  try {
    // Convert our history format to Gemini's format
    const geminiHistory = getHistory(userId).slice(0, -1).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    const chat = geminiModel.startChat({
      history: geminiHistory,
      systemInstruction: systemPrompt
    });

    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();

    addToHistory(userId, 'model', reply);
    return reply;
  } catch (error) {
    console.error('Gemini API error:', error.message);
    return "I'm having a small technical issue right now. Please try again in a moment, or reach out to us at hello@neuralpath.academy 💙";
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
    console.log('✅ Google Sheets ready');
  } catch (error) {
    console.error('Sheets setup error:', error.message);
  }
}

// ---- Extract Lead Data from Gemini's Reply ----
// Gemini hides lead info in <!--LEAD:{...}--> tags
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
      console.log('📋 Lead saved:', leadData);
    } catch (e) {
      console.error('Lead parse error:', e.message);
    }
  }
}

function cleanReply(reply) {
  return reply.replace(/<!--LEAD:.*?-->/g, '').trim();
}

// ---- Telegram Inline Keyboards ----
// Interactive buttons users can click instead of typing

function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📚 View Courses', callback_data: 'courses' },
        { text: '💰 Pricing', callback_data: 'pricing' }
      ],
      [
        { text: '❓ FAQs', callback_data: 'faq' },
        { text: '🗣️ Testimonials', callback_data: 'testimonials' }
      ],
      [
        { text: '📞 Talk to a Human', callback_data: 'human_support' }
      ]
    ]
  };
}

function getCourseListKeyboard() {
  const buttons = productDetails.courses.map(c => ([{
    text: `${c.name}`,
    callback_data: `course_${c.id}`
  }]));
  buttons.push([{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]);
  return { inline_keyboard: buttons };
}

// ---- Generate Bot Replies for Commands ----

function getWelcomeMessage(firstName) {
  return `Hey ${firstName}! 👋 Welcome to *NeuralPath Academy*!

I'm *Neura*, your AI learning assistant. I can help you with:

🎓 Explore our AI courses
💰 Pricing & EMI options
📅 Upcoming batch dates
❓ Any questions about learning AI

Tap a button below or just type your question! 👇`;
}

function getHelpMessage() {
  return `Here's what I can help you with:

📚 */courses* — Browse all our AI courses
💰 */pricing* — See pricing & EMI options
❓ */help* — Show this menu again

Or just ask me anything! I know everything about NeuralPath Academy's courses, tutors, schedules, and more.

💬 Try asking:
• "Which course is right for beginners?"
• "Tell me about the GenAI course"
• "Do you offer EMI?"
• "What projects will I build?"`;
}

function getCoursesMessage() {
  let msg = '🎓 *Our AI Courses:*\n\n';
  productDetails.courses.forEach(c => {
    const stars = '⭐'.repeat(Math.round(c.rating));
    msg += `*${c.name}*\n`;
    msg += `📊 ${c.level} | ⏱️ ${c.duration}\n`;
    msg += `💰 ~₹${c.price}~ → *₹${c.discounted_price}*\n`;
    msg += `${stars} ${c.rating}/5 (${c.reviews_count} reviews)\n`;
    msg += `🪑 ${c.seats_left} seats left | 📅 Next: ${c.next_batch}\n\n`;
  });
  msg += `Tap a course below for full details! 👇`;
  return msg;
}

function getPricingMessage() {
  let msg = '💰 *Course Pricing:*\n\n';
  productDetails.courses.forEach(c => {
    msg += `*${c.name}*\n`;
    msg += `   ~₹${c.price}~ → *₹${c.discounted_price}*`;
    if (c.emi_available && c.emi_amount) {
      msg += ` (EMI: ₹${c.emi_amount})`;
    }
    msg += '\n\n';
  });
  msg += `✅ All EMI plans are *zero interest*\n`;
  msg += `🔄 *7-day full refund* — no questions asked\n\n`;
  msg += `Interested? Just tell me which course, and I'll help you enroll! 😊`;
  return msg;
}

function getCourseDetailMessage(courseId) {
  const c = productDetails.courses.find(course => course.id === courseId);
  if (!c) return null;

  let msg = `📘 *${c.name}* (${c.id})\n\n`;
  msg += `📊 Level: *${c.level}*\n`;
  msg += `⏱️ Duration: *${c.duration}*\n`;
  msg += `🎥 Mode: ${c.mode}\n`;
  msg += `💰 Price: ~₹${c.price}~ → *₹${c.discounted_price}*\n`;
  if (c.emi_available && c.emi_amount) {
    msg += `📦 EMI: ₹${c.emi_amount} (0% interest)\n`;
  }
  msg += `\n📝 *About:*\n${c.description}\n`;
  msg += `\n📋 *Topics Covered:*\n${c.topics.map(t => `  • ${t}`).join('\n')}\n`;
  msg += `\n🛠️ *Hands-on Projects:*\n${c.projects.map(p => `  • ${p}`).join('\n')}\n`;
  if (c.extras) {
    msg += `\n🎁 *Bonus Extras:*\n${c.extras.map(e => `  • ${e}`).join('\n')}\n`;
  }
  msg += `\n👨‍🏫 *Tutor:* ${c.tutor.name} — ${c.tutor.title}\n`;
  msg += `📅 *Next Batch:* ${c.next_batch}\n`;
  msg += `🪑 *Seats Left:* ${c.seats_left}/${c.total_seats}\n`;
  msg += `⭐ *Rating:* ${c.rating}/5 (${c.reviews_count} reviews)\n`;
  msg += `👥 *Students Enrolled:* ${c.students_enrolled}\n`;
  msg += `🏅 Certificate: ${c.certificate ? 'Yes ✅' : 'No'}\n`;
  msg += `💼 Job Assistance: ${c.job_assistance ? 'Yes ✅' : 'No'}\n`;
  msg += `\n🔄 7-day full refund policy — no questions asked!`;
  return msg;
}

function getFaqMessage() {
  let msg = '❓ *Frequently Asked Questions:*\n\n';
  productDetails.faq.forEach((f, i) => {
    msg += `*${i + 1}. ${f.question}*\n${f.answer}\n\n`;
  });
  msg += `Still have questions? Just ask! 😊`;
  return msg;
}

function getTestimonialsMessage() {
  let msg = '🗣️ *What Our Students Say:*\n\n';
  productDetails.testimonials.forEach(t => {
    msg += `💬 _"${t.text}"_\n`;
    msg += `— *${t.name}*, ${t.role}\n`;
    msg += `   📚 Course: ${t.course} | ⭐ ${t.rating}/5\n\n`;
  });
  msg += `Join ${productDetails.courses.reduce((sum, c) => sum + c.students_enrolled, 0).toLocaleString()}+ happy students! 🚀`;
  return msg;
}

// ---- Stats Tracking ----
const stats = {
  startedAt: new Date().toISOString(),
  totalMessages: 0,
  totalUsers: new Set(),
  totalLeads: 0
};

// ---- WEBHOOK ENDPOINT ----
// Telegram sends ALL messages to this URL
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;

    // ---- Handle Callback Queries (Button Clicks) ----
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;
      const firstName = callbackQuery.from.first_name || '';

      // Answer the callback to remove "loading" state on button
      await bot.answerCallbackQuery(callbackQuery.id);

      let replyText = '';
      let replyKeyboard = null;

      switch (data) {
        case 'main_menu':
          replyText = getWelcomeMessage(firstName);
          replyKeyboard = getMainMenuKeyboard();
          break;
        case 'courses':
          replyText = getCoursesMessage();
          replyKeyboard = getCourseListKeyboard();
          break;
        case 'pricing':
          replyText = getPricingMessage();
          replyKeyboard = { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]] };
          break;
        case 'faq':
          replyText = getFaqMessage();
          replyKeyboard = { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]] };
          break;
        case 'testimonials':
          replyText = getTestimonialsMessage();
          replyKeyboard = { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]] };
          break;
        case 'human_support':
          replyText = `Sure! 🙋‍♀️ A member of our team will reach out to you shortly.\n\nIn the meantime, could you share:\n1. Your *name*\n2. Your *email*\n3. Your *phone number*\n\nSo we can connect you with the right person! 📞`;
          replyKeyboard = { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]] };
          break;
        default:
          // Handle course detail buttons (course_AI-101, etc.)
          if (data.startsWith('course_')) {
            const courseId = data.replace('course_', '');
            replyText = getCourseDetailMessage(courseId);
            if (!replyText) {
              replyText = "Sorry, I couldn't find that course. Please try again.";
            }
            replyKeyboard = {
              inline_keyboard: [
                [{ text: '📚 All Courses', callback_data: 'courses' }],
                [{ text: '⬅️ Back to Menu', callback_data: 'main_menu' }]
              ]
            };
          }
          break;
      }

      if (replyText) {
        await bot.sendMessage(chatId, replyText, {
          parse_mode: 'Markdown',
          reply_markup: replyKeyboard
        });
      }

      res.sendStatus(200);
      return;
    }

    // ---- Handle Text Messages ----
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const username = update.message.from.username || '';
      const firstName = update.message.from.first_name || '';
      const userMessage = update.message.text;

      console.log(`[${firstName}/@${username}]: ${userMessage}`);

      // Track stats
      stats.totalMessages++;
      stats.totalUsers.add(userId);

      // Rate limit check
      if (isRateLimited(userId)) {
        await bot.sendMessage(chatId, "⏳ You're sending messages too fast! Please wait a moment and try again.");
        res.sendStatus(200);
        return;
      }

      let botReply;
      let replyKeyboard = null;

      // ---- Command Handlers ----
      const command = userMessage.toLowerCase().trim();

      if (command === '/start') {
        botReply = getWelcomeMessage(firstName);
        replyKeyboard = getMainMenuKeyboard();
        addToHistory(userId, 'user', userMessage);
        addToHistory(userId, 'model', botReply);
      } else if (command === '/help') {
        botReply = getHelpMessage();
        addToHistory(userId, 'user', userMessage);
        addToHistory(userId, 'model', botReply);
      } else if (command === '/courses') {
        botReply = getCoursesMessage();
        replyKeyboard = getCourseListKeyboard();
        addToHistory(userId, 'user', userMessage);
        addToHistory(userId, 'model', botReply);
      } else if (command === '/pricing') {
        botReply = getPricingMessage();
        addToHistory(userId, 'user', userMessage);
        addToHistory(userId, 'model', botReply);
      } else {
        // Regular message → send to Gemini AI
        botReply = await chatWithGemini(userId, userMessage);
      }

      // Save lead if Gemini detected one
      const leadMatch = botReply.match(/<!--LEAD:(.*?)-->/);
      if (leadMatch) {
        stats.totalLeads++;
      }
      await extractAndSaveLead(userId, username, botReply);

      // Remove lead tag before sending to user
      const cleanedReply = cleanReply(botReply);

      // Send reply on Telegram
      const sendOptions = {};
      if (replyKeyboard) {
        sendOptions.reply_markup = replyKeyboard;
        sendOptions.parse_mode = 'Markdown';
      }

      try {
        await bot.sendMessage(chatId, cleanedReply, sendOptions);
      } catch (sendErr) {
        // If Markdown parsing fails, send without formatting
        console.error('Failed to send with Markdown, retrying plain:', sendErr.message);
        await bot.sendMessage(chatId, cleanedReply);
      }

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
    version: '2.0.0',
    ai: 'Google Gemini 2.0 Flash',
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ---- Bot Stats (Admin) ----
app.get('/stats', (req, res) => {
  res.json({
    startedAt: stats.startedAt,
    uptime: Math.floor(process.uptime()) + 's',
    totalMessages: stats.totalMessages,
    uniqueUsers: stats.totalUsers.size,
    totalLeads: stats.totalLeads,
    activeConversations: Object.keys(conversationHistory).length
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

// ---- Remove Webhook (for debugging) ----
app.get('/remove-webhook', async (req, res) => {
  try {
    await bot.deleteWebHook();
    res.json({ success: true, message: 'Webhook removed' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ---- Start Server ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NeuralPath Bot v2.0 running on port ${PORT}`);
  console.log(`🤖 AI Engine: Google Gemini 2.0 Flash`);
  console.log(`📡 Webhook endpoint: /webhook`);
  console.log(`🔧 Setup webhook: /setup-webhook?url=YOUR_URL/webhook`);
  console.log(`📊 Stats: /stats`);
  console.log(`❤️  Health check: /\n`);

  // Setup sheets in background — don't crash server if it fails
  setupSheets().catch(err => console.error('Sheets setup failed:', err.message));
});
