const dotenv = require("dotenv");
dotenv.config();

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const twilio = require("twilio");
const {} = require("./Mediastream.js");
const WebSocketServer = require("websocket").server;
const { Deepgram } = require("@deepgram/sdk");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);
const { v4: uuidv4 } = require("uuid");
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');


const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;


const logFilePath = path.join(__dirname, 'app.log');
if (fs.existsSync(logFilePath)) {
    fs.unlinkSync(logFilePath, (err) => {
        if (err) throw err;
    });
}

function log(message, ...args) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message, ...args);
    fs.appendFile(logFilePath, logMessage, (err) => {
        if (err) {
            console.error('Error writing to log file:', err);
        }
    });
}

app.use(bodyParser.json());
const server = app.listen(process.env.PORT || 3000, () => {
    log(`Server running on port ${PORT}`);
});

app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

app.post("/twiml", function (req, res) {
    const queryObject = req.query;
    const response = new VoiceResponse();
    if (queryObject) {
        const start_stream = response.connect();
        const websocket_stream = start_stream.stream({ url: `wss://${ngrokURL}` });
        for (let key in queryObject) {
            websocket_stream.parameter({ name: key, value: queryObject[key] });
        }
    }
    res.set('Content-Type', 'text/xml');
    res.send(response.toString());
});

app.post("/stream", function (req, res) {
    const { sid } = req.body
    log("sid", sid)
    client.calls(sid)
        .streams
        .create({ url: 'wss://example.com/' })
        .then(stream => log(stream.sid));
});

app.post("/length", async function (req, res) {
    const { call_id } = req.body
    let { data: belvaData, error: belvaError } = await supabase
        .from('belva')
        .select('call_sid')
        .eq('call_id', call_id)
    if (belvaError) {
        log('Error: ', belvaError)
        return res.status(500).send('Error in fetching call_sid');
    }
    // Create Twilio client
    client.calls(belvaData[0].call_sid)
        .fetch()
        .then(call => res.json({ "length": call.duration }))
        .catch(err => {
            log('Error: ', err);
            return res.status(500).send('Error in fetching call length from Twilio');
        });
})

app.post("/getRecording", function (req, res) {
    const { sid } = req.body;
    log("sid", sid)
    client.calls(sid)
        .streams
        .create({ url: 'wss://example.com/' })
        .then(stream => log(stream.sid));
});

app.post('/call', async (req, res) => {
    const { phone_number } = req.body;
    const call_id = uuidv4();
    let url = `https://${process.env.NGROK_URL}/twiml?call_id=${call_id}`;
    client.calls
        .create({
            url: url,
            to: `+${phone_number}`,
            from: `+${TWILIO_PHONE_NUMBER}`,
            method: "POST",
        })
        .then(async (call) => {
            res.json({ status: "success", call_id: call_id, call_sid: call.sid })
        })
        .catch((error) => {
            console.error(error);
            res.json({ status: error })
        });
});


//  Web Socket Server

const wss = new WebSocketServer({
    httpServer: server, autoAcceptConnections: true
});

wss.on("connect", function (connection) {
    log("From Twilio: Connection accepted");
    new MediaStream(connection);
});

wss.on("listen", function (id) {
    log("Call id ", id)
})