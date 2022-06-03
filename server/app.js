import http from 'node:http';
import serveStatic from 'serve-static';
import { WebSocketServer } from 'ws';

const HOSTNAME = '0.0.0.0';
const PORT = process.env.PORT || 8888;
const server = http.createServer();
let retryTimeoutId = -1;

// ---------------- HTTP SERVER ----------------

// https://devcenter.heroku.com/articles/heroku-cli
// https://devcenter.heroku.com/articles/procfile
// https://devcenter.heroku.com/articles/deploying-nodejs
// https://devcenter.heroku.com/articles/nodejs-support
const serve = serveStatic('client', { index: 'index.html' });

server.on('request', (req, res) => {
    console.log(`[HTTP] "${req.socket.remoteAddress}" ${req.method} ${req.headers.host}${req.url}`);

    serve(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('404 Not Found');
    });
});

server.on('listening', () => console.log(`[HTTP] Server is listening on ${HOSTNAME}:${PORT}`));
server.on('close', () => console.log('[HTTP] Server is closed'));
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`[HTTP] Port "${PORT}" is in use. Retrying...`);
        retryTimeoutId = setTimeout(() => {
            server.close();
            server.listen(PORT, HOSTNAME);
        }, 1000);
    } else {
        console.error(e);
    }
});

server.listen(PORT, HOSTNAME);

// ---------------- WEBSOCKET SERVER ----------------

const MAX_FPS = 30;
const CLIENT_UNKNOWN = '❓';
const CLIENT_ROBOT = '🤖';
const CLIENT_CONTROLLER = '🧠';
const td = new TextDecoder();
const wss = new WebSocketServer({ server });

let targetFPS = MAX_FPS;
let frameId = 0;
let bufSize = 0;
let robot = null;
let controllers = new Set();

function setRobot(ws) {
    if (robot) robot.terminate();

    frameId = 0;
    ws.type = CLIENT_ROBOT;
    robot = ws;
    if (controllers.size > 0) {
        ws.sendMessage({ type: 'start', targetFPS });
        controllers.forEach((c) => {
            c.ackFrames = 0;
            c.frameOffset = 0;
        });
    }
}

function unsetRobot() {
    robot = null;
}

function addController(ws) {
    ws.type = CLIENT_CONTROLLER;
    ws.ackIntervalId = setInterval(() => {
        if (!robot) return;
        if (ws.isStopped) return;

        const kbitps = Math.ceil((bufSize * 8) / 1000);
        const mbitps = kbitps / 1000;
        console.log('Bandwidth:', kbitps, 'kbit/s', mbitps, 'mbit/s');
        bufSize = 0;

        const ack = ws.ackFrames + ws.frameOffset;
        const realLag = frameId - ack;
        const lag = Math.max(realLag - ws.lagOffset, 0);
        // console.log('Frame Id:', frameId, ' ACK:', ack, ' Lag:', lag);

        if (lag > targetFPS * 2) {
            targetFPS = Math.floor(targetFPS / 2);
            ws.lagOffset = realLag;

            console.warn('[WS] Target FPS:', targetFPS);

            if (targetFPS === 1) {
                console.warn('[WS] Client is too slow!');
                robot.sendMessage('stop');
                ws.isStopped = true;
            } else {
                ws.sendMessage('reset');
                robot.sendMessage({ type: 'fps', targetFPS });
            }
        }
    }, 1000);

    const shouldStart = controllers.size < 1;
    controllers.add(ws);

    if (shouldStart && robot) robot.sendMessage({ type: 'start', targetFPS });
}

function removeController(ws) {
    clearInterval(ws.ackIntervalId);
    controllers.delete(ws);
    if (controllers.size < 1) ws.sendMessage('stop');
}

wss.on('listening', () => {
    console.log('[WSS] Server is listening');
});

wss.on('connection', (ws, req) => {
    console.log(`[WSS] Client connected from "${req.socket.remoteAddress}" | Total: ${wss.clients.size}`);

    ws.type = CLIENT_UNKNOWN;
    ws.ackFrames = 0;
    ws.frameOffset = frameId;
    ws.lagOffset = 0;
    ws.isStopped = false;
    ws.sendMessage = (msg) => {
        const msgStr = JSON.stringify(msg);
        ws.send(msgStr);
    };

    ws.on('message', (data, isBinary) => {
        // BINARY MESSAGE (Handle Incoming Frame)
        if (isBinary) {
            if (!ws.type === CLIENT_ROBOT) return;
            // console.log(`[WS] ${ws.type} New Frame: ${byteSize(data.length).toString()}`);

            if (controllers.size < 1) {
                ws.sendMessage('stop');
                return;
            }

            frameId++;
            bufSize += data.length;
            controllers.forEach((c) => {
                if (!c.isStopped) c.send(data);
            });
        }

        // TEXT MESSAGE
        else {
            const msgStr = td.decode(data);
            const msg = JSON.parse(msgStr);

            if (ws.type === CLIENT_UNKNOWN && msg === CLIENT_ROBOT) setRobot(ws);
            else if (ws.type === CLIENT_UNKNOWN && msg === CLIENT_CONTROLLER) addController(ws);
            else if (ws.type === CLIENT_CONTROLLER && msg === '🎞️') ws.ackFrames++;
        }
    });

    ws.on('ping', (data) => {
        console.log(`[WS] ${ws.type} Ping:`, data);
    });

    ws.on('pong', (data) => {
        console.log(`[WS] ${ws.type} Pong:`, data);
    });

    ws.on('error', (error) => {
        console.error(`[WS] ${ws.type} Error:`, error);
    });

    ws.on('close', (code, reason) => {
        console.log(
            `[WS] ${ws.type} Connection is closed | Total: ${wss.clients.size}`,
            '| Code:',
            code,
            '| Reason:',
            reason
        );

        if (ws.type === CLIENT_CONTROLLER) removeController(ws);
        else if (ws.type === CLIENT_ROBOT) unsetRobot();
    });
});

wss.on('error', (error) => {
    console.error('[WSS] Error:', error);
});

wss.on('close', () => {
    console.log('[WSS] Server is closed');
});

// ---------------- HANDLE PROCESS EXIT SIGNALS ----------------

function exit(msg) {
    console.log(msg);
    clearTimeout(retryTimeoutId);
    server.close();
    wss.close();
    wss.clients.forEach((c) => c.terminate());
}

process.once('SIGINT', (code) => {
    exit(`[APP] SIGINT: ${code}`);
});

process.once('SIGTERM', (code) => {
    exit(`[APP] SIGTERM: ${code}`);
});
