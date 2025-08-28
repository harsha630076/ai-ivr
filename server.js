require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Needed for JSON body parsing

// -------------------------
// Environment Variables
// -------------------------
console.log("🔑 Checking environment variables...");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "SET" : "MISSING");
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "SET" : "MISSING");
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER ? "SET" : "MISSING");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "SET" : "MISSING");
console.log("ELEVEN_API_KEY:", process.env.ELEVEN_API_KEY ? "SET" : "MISSING");
console.log("ELEVEN_VOICE_ID:", process.env.ELEVEN_VOICE_ID ? "SET" : "MISSING");

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
  console.error("❌ Twilio credentials missing! Outbound calls will fail.");
}

if (!process.env.OPENAI_API_KEY) console.error("❌ OpenAI API key missing!");
if (!process.env.ELEVEN_API_KEY || !process.env.ELEVEN_VOICE_ID) console.error("❌ ElevenLabs credentials missing!");

// Initialize clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.ELEVEN_VOICE_ID;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const RENDER_URL = process.env.RENDER_URL || "https://ai-ivr-cvja.onrender.com";

// -------------------------
// 1. Inbound Call
// -------------------------
app.post("/ivr", (req, res) => {
  const twiml = `
    <Response>
      <Say>Hello! This is your AI IVR. Please say something after the beep.</Say>
      <Record timeout="5" maxLength="10" action="/process" />
    </Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// -------------------------
// 2. Process Recorded Voice
// -------------------------
app.post("/process", async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl;
    if (!recordingUrl) {
      console.error("❌ /process missing RecordingUrl in request");
      return res.send("<Response><Say>Recording URL missing.</Say></Response>");
    }

    console.log("🎤 User recording:", recordingUrl);

    // Download recording from Twilio
    const audioResponse = await axios.get(`${recordingUrl}.wav`, { responseType: "arraybuffer" });
    const audioFile = path.join(__dirname, "user.wav");
    fs.writeFileSync(audioFile, audioResponse.data);

    // Transcribe with OpenAI Whisper
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "whisper-1",
    });
    const userText = stt.text;
    console.log("📝 Transcribed text:", userText);

    // Chat with GPT
    const chat = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: userText }],
    });
    const textReply = chat.choices[0].message.content;
    console.log("🤖 AI says:", textReply);

    // Convert GPT reply to speech with ElevenLabs
    const ttsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      { text: textReply },
      {
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    const outFile = path.join(__dirname, `reply_${Date.now()}.mp3`);
    fs.writeFileSync(outFile, ttsResponse.data);
    const fileUrl = `${RENDER_URL}/audio/${path.basename(outFile)}`;

    const twiml = `
      <Response>
        <Play>${fileUrl}</Play>
      </Response>`;
    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /process:", err);
    res.send("<Response><Say>Sorry, an error occurred.</Say></Response>");
  }
});

// -------------------------
// 3. Outbound Call
// -------------------------
app.post("/outbound", async (req, res) => {
  console.log("📥 Incoming /outbound body:", req.body);
  try {
    const toNumber = req.body.to;
    if (!toNumber) return res.status(400).json({ error: "Missing 'to' number" });

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      return res.status(500).json({ error: "Twilio credentials missing" });
    }

    const call = await client.calls.create({
      to: toNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${RENDER_URL}/ivr`,
    });

    console.log("📞 Outbound call started:", call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error("❌ Outbound error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------
// Serve audio files
// -------------------------
app.use("/audio", express.static(path.join(__dirname)));

// -------------------------
// Start server
// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
