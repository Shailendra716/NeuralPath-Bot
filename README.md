# 🤖 NeuralPath Academy — Telegram Bot

AI-powered customer support bot for **NeuralPath Academy**, built with Node.js, Google Gemini AI, and Telegram Bot API.

## What It Does

- 💬 **AI Chat** — Answers questions about courses, pricing, and schedules using Google Gemini
- 📚 **Interactive Menus** — Inline keyboard buttons for browsing courses, pricing, FAQs
- 📋 **Lead Capture** — Automatically detects and saves contact info shared during conversations
- 📊 **Google Sheets Logging** — All conversations and leads logged to a Google Sheet
- 🧠 **Conversation Memory** — Remembers context within each user's chat session

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 18+ |
| AI Engine | Google Gemini 2.0 Flash |
| Bot Platform | Telegram Bot API |
| Logging | Google Sheets API |
| Server | Express.js |
| Hosting | Render.com (or any Node.js host) |

## Setup

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd NeuralPath-Bot
npm install
```

### 2. Configure Environment
Create a `.env` file:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SERVICE_ACCOUNT_EMAIL=your_service_account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
PORT=3000
```

### 3. Run Locally
```bash
npm start
```

### 4. Set Up Webhook
After deploying, visit:
```
https://your-app.onrender.com/setup-webhook?url=https://your-app.onrender.com/webhook
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with menu buttons |
| `/help` | Show available commands |
| `/courses` | Browse all courses with details |
| `/pricing` | View pricing and EMI options |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/webhook` | POST | Telegram webhook receiver |
| `/setup-webhook?url=...` | GET | Register webhook with Telegram |
| `/remove-webhook` | GET | Remove webhook (for debugging) |
| `/stats` | GET | Bot statistics (messages, users, leads) |

## Deploy on Render

1. Push code to GitHub
2. Create a **Web Service** on [Render](https://render.com)
3. Connect your GitHub repo
4. Set environment = **Node**, build command = `npm install`, start command = `npm start`
5. Add all environment variables from `.env`
6. Deploy, then hit `/setup-webhook?url=YOUR_RENDER_URL/webhook`

## Project Structure

```
NeuralPath Bot/
├── server.js              # Main bot server (Express + Telegram + Gemini)
├── product-details.json   # All course data, FAQs, testimonials
├── package.json           # Dependencies and scripts
├── .env                   # API keys (not committed)
├── .gitignore             # Ignores node_modules and .env
└── README.md              # You are here
```

## License

MIT
