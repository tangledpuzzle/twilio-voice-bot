const axios = require('axios');  
const fetch = require('node-fetch');  
const stream = require('stream');  
const ffmpeg = require('fluent-ffmpeg');  
const { pipeline, Transform } = require('stream');
const { Agent, Tool } = require("./agent.js");

function createMediaStream(connection) {  
    let trackHandlers = {};
    let isPlaying = false;
    let agent = "";
    let newStreamNeeded = false;
    let intermediateTranscript = "";

    async function sendAudioStream(text, streamSid) {  
        let response;  
        try {  
            response = await axios({  
                method: "post",  
                url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream?optimize_streaming_latency=4`,  
                headers: {  
                    "xi-api-key": process.env.XI_API_KEY, "Content-Type": "application/json", accept: "audio/mpeg",  
                },  
                data: {  
                    text: text, model_id: "eleven_monolingual_v1", voice_settings: {  
                        stability: 0.15, similarity_boost: 0.5  
                    },  
                },  
                responseType: "stream",  
            });  
        } catch (err) {  
            log("ERROR: ", err.response);  
            return;  
        }  

        log("elevenlabs passed");  
        const input = response.data;  
        const outputMulaw = new stream.PassThrough();  

        ffmpeg(input)  
            .audioFrequency(8000)  
            .audioChannels(1)  
            .audioCodec("pcm_mulaw")  
            .format("wav")  
            .pipe(outputMulaw)  
            .on("end", () => {})  
            .on("error", (err) => log("error: ", +err));  

        outputMulaw.on("data", (chunk) => {  
            const base64Data = isPlaying ? Buffer.from(chunk).toString("base64") : Buffer.from(chunk.slice(44)).toString("base64");  

            isPlaying = true;  
            const mediaData = {  
                event: "media", streamSid: streamSid, media: {  
                    payload: base64Data,  
                },  
            };  
            connection.sendUTF(JSON.stringify(mediaData));  
        });  

        outputMulaw.on("end", () => {  
            isPlaying = false;  
        });  

        log("Audio Stream ended");  
    }  

    async function invokeStreamProcess(prompt, streamSid) {  
        log("prompt-messages", prompt);  
        let response = await fetch("https://api.openai.com/v1/chat/completions", {  
            headers: {  
                "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`  
            }, method: "POST", body: JSON.stringify({  
                model: "gpt-4-1106-preview", messages: prompt, temperature: 0.75, top_p: 0.95,  
                frequency_penalty: 0, presence_penalty: 0, max_tokens: 500, stream: true, n: 1,  
            }),  
        });  

        let fullResp = '';  
        const generator = pipeline(response.body, new Transform({  
            construct(callback) {  
                this.buffer = '';  
                callback();  
            }, transform(chunk, encoding, callback) {  
                if (chunk.toString().startsWith("data: ")) {  
                    this.buffer = "";  
                }  
                for (const data of (this.buffer + chunk).toString().split('\n')) {  
                    if (data) {  
                        if (data.endsWith("}]}")) {  
                            this.push(data.slice(6));  
                        } else if (data === "data: [DONE]") {  
                            this.push(data.slice(6))  
                        } else {  
                            this.buffer = data;  
                        }  
                    }  
                }  
                callback();  
            }  
        }), new Transform({  
            construct(callback) {  
                this.partialResp = '';  
                callback();  
            }, transform(chunk, encoding, callback) {  
                if (chunk.toString() !== `[DONE]`) {  
                    const content = JSON.parse(chunk).choices[0].delta?.content || "";  
                    if ((content === '.' || content === '!' || content === '?' || content === '?\"' || content === '\\n' || content.endsWith('\n'))) {  
                        this.push(this.partialResp + content);  
                        this.partialResp = '';  
                    }   
                    else {  
                        this.partialResp += content;  
                    }  
                } else {  
                    this.push(this.partialResp);  
                }  
                callback();  
            }  
        }), (err) => {  
            if (err) {  
                console.error('failed', err);  
            } else {  
                log('completed');  
            }  
        });  

        const waitToFinish = async () => {  
            return new Promise((resolve) => {  
                const interval = setInterval(async () => {  
                    if (isPlaying === false) {  
                        clearInterval(interval);  
                        resolve();  
                    }  
                }, 100); // Check every 100ms  
            });  
        };  

        for await (const value of generator) {  
            const string = value.toString();  
            log(string);  
            fullResp += string;  
            sendAudioStream(string, streamSid);  
            await waitToFinish();  
        }  

        agent.update_message(fullResp);  
        log(`Full Response: ${fullResp}`);  
    }  

    function debounce(func, wait, immediate) {  
        let timeout;  
        return function executedFunction() {  
            const context = this;  
            const args = arguments;  
            const later = function () {  
                timeout = null;  
                if (!immediate) func.apply(context, args);  
            };  
            const callNow = immediate && !timeout;  
            clearTimeout(timeout);  
            timeout = setTimeout(later, wait);  
            if (callNow) func.apply(context, args);  
        };  
    }  

    function processMessage(message) {  
        if (message.type === "utf8") {  
            const data = JSON.parse(message.utf8Data);  

            if (data.event === "start") {    
                agent = new Agent(  
                    [  
                        new Tool("Speak", "Talk to the person on the other end of the line"),  
                    ]  
                );
                const greetings = ["Hello!", "Hi there!", "Hey anybody there.", "Good day!", "Hey!", "Hows it going, are you there?!"];
                const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];  
                sendAudioStream(`${randomGreeting}`, data?.streamSid).then(() => {});  
            }  
            if (data.event === "subscribe") {  
                connection = data?.streamSid;  
                JSON.stringify({  
                    stream: data.streamSid, event: "interim-transcription", text: transcription,  
                });  
            }  
            if (data.event === "stop") {  
                // updateIsDone(call_id, true);  
            }  
            if (data.event !== "media") {  
                return;  
            }  

            const track = data.media.track;  
            const createNewStream = () => {  
                const newService = deepgram.transcription.live({  
                    smart_format: true,  
                    interim_results: true,  
                    language: "en-US",  
                    model: "nova",  
                    encoding: "mulaw",  
                    sample_rate: 8000,  
                    endpointing: 100,  
                    punctuate: true,  
                });  
                return newService;  
            };  

            if (!trackHandlers[track]) {  
                let service = createNewStream();  
                if (newStreamNeeded) {  
                    service = createNewStream();  
                    trackHandlers[track] = service;  
                    newStreamNeeded = false;  
                }  
                const handleTranscription = debounce(async (transcription) => {  
                    const mediaData = {  
                        event: "clear", streamSid: data?.streamSid,  
                    };  
                    connection.sendUTF(JSON.stringify(mediaData));  
                    
                    const toHoldTranscription = transcription;  
                    const prompt = await agent.ask(toHoldTranscription);  
                    
                    await invokeStreamProcess(prompt, data?.streamSid);  
                    intermediateTranscript = "";  
                    isPlaying = false;  
                }, 1);  
                service.addListener("transcriptReceived", (message) => {  
                    const data = JSON.parse(message);  
                    if (data.is_final) {  
                        intermediateTranscript = intermediateTranscript + data?.channel?.alternatives[0]?.transcript;
                    }  
                    if (data?.is_final && data?.speech_final && data?.channel?.alternatives[0]?.transcript && !isPlaying && agent.messages[agent.messages.length - 1]['role'] === 'assistant') {  
                        handleTranscription(intermediateTranscript);  
                    }  
                });  
                service.addListener("close", (e) => {  
                    log("Connection closed.");  
                    log(e);  
                    if (e.reason === "Deepgram did not receive audio data or a text message within the timeout window. See https://dpgr.am/net0001") {  
                        log("TIMED OUT \n\n\n\n");  
                        newStreamNeeded = true;  
                    }  
                });  

                trackHandlers[track] = service;  

                if (newStreamNeeded) {  
                    service = null;  
                    service = createNewStream();  
                    newStreamNeeded = false;  
                }  
            }  

            if (!isPlaying) {  
                if (trackHandlers[track].getReadyState() == 1) {  
                    trackHandlers[track].send(Buffer.from(data.media.payload, "base64"));  
                }  
            }  
        } else if (message.type === "binary") {  
            log("Media WS: binary message received (not supported)");  
        }  
    }
    function close() {  
        log("Media WS: closed");  
        for (const track of Object.keys(trackHandlers)) {  
            log(`Closing ${track} handler`);  
        }  
    }  
    connection.on("message", processMessage);  
    connection.on("close", close);  
    return {  
        sendAudioStream,  
        invokeStreamProcess,  
        processMessage,  
        close,  
    };  
}  

module.exports = createMediaStream;