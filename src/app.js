import http from 'node:http';
import serveStatic from 'serve-static';
import { WebSocketServer } from 'ws';

const HOSTNAME = '0.0.0.0';
const PORT = process.env.PORT || 8888;
const server = http.createServer();
let retryTimeoutId = -1;

// ---------------- HTTP SERVER ----------------

// https://dashboard.heroku.com/apps/bau-capstone-1010168/deploy/github
// https://devcenter.heroku.com/articles/heroku-cli
// https://devcenter.heroku.com/articles/procfile
// https://devcenter.heroku.com/articles/deploying-nodejs
// https://devcenter.heroku.com/articles/nodejs-support
// heroku logs -a bau-capstone-1010168-controller --tail

// https://pm2.keymetrics.io/docs/usage/application-declaration/
// https://pm2.keymetrics.io/docs/usage/signals-clean-restart/
// https://pm2.keymetrics.io/docs/usage/startup/

// https://github.com/expressjs/serve-static
const serve = serveStatic('public', { index: 'index.html', extensions: ['html'] });

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
        }, 3000);
    } else {
        console.error(e);
    }
});

server.listen(PORT, HOSTNAME);

// ---------------- WEBSOCKET SERVER ----------------

const CLIENT_UNKNOWN = '❓';
const CLIENT_ROBOT = '🤖';
const CLIENT_CV = '👁️';
const CLIENT_CONTROLLER = '🧠';
const td = new TextDecoder();

// https://github.com/websockets/ws
const wss = new WebSocketServer({ server });
let frameId = 0;
let robot = null;
let cv = null;
let controllers = new Set();
let waitingFrame = false;

function setRobot(ws) {
    if (robot) robot.terminate();

    frameId = 0;
    ws.type = CLIENT_ROBOT;
    robot = ws;

    const controllersArr = [...controllers];
    controllersArr.forEach((c) => (c.ack = false));
    robot?.sendMessage('🎞️');
}

function setCV(ws) {
    if (cv) cv.terminate();

    ws.type = CLIENT_CV;
    waitingFrame = false;
    cv = ws;
}

function unsetCV() {
    cv = null;
    waitingFrame = false;
}

function unsetRobot() {
    robot = null;
    const controllersArr = [...controllers];
    controllersArr.forEach((c) => (c.ack = false));
}

function addController(ws) {
    ws.type = CLIENT_CONTROLLER;
    controllers.add(ws);
}

function removeController(ws) {
    controllers.delete(ws);
    const controllersArr = [...controllers];
    const ack = controllersArr.reduce((ack, c) => ack && c.ack, true);
    if (ack) robot?.sendMessage('🎞️');
}

wss.on('listening', () => {
    console.log('[WSS] Server is listening');
});

wss.on('connection', (ws, req) => {
    console.log(`[WSS] Client connected from "${req.socket.remoteAddress}" | Total: ${wss.clients.size}`);

    ws.type = CLIENT_UNKNOWN;
    ws.ack = false;

    ws.sendMessage = (msg) => {
        const msgStr = JSON.stringify(msg);
        ws.send(msgStr);
    };

    ws.on('message', (data, isBinary) => {
        // BINARY MESSAGE (Handle Incoming Frame)
        if (isBinary) {
            // if (!ws.type === CLIENT_ROBOT) return;
            // https://github.com/75lb/byte-size
            // console.log(`[WS] ${ws.type} New Frame: ${byteSize(data.length).toString()}`);

            frameId++;
            controllers.forEach((c) => c.send(data));

            if (waitingFrame) {
                waitingFrame = false;
                cv?.send(data);
            }
        }

        // TEXT MESSAGE
        else {
            const msgStr = td.decode(data);
            const msg = JSON.parse(msgStr);

            // TTPE ROBOT
            if (ws.type === CLIENT_UNKNOWN && msg === CLIENT_ROBOT) setRobot(ws);
            // TYPE CV
            else if (ws.type === CLIENT_UNKNOWN && msg === CLIENT_CV) setCV(ws);
            // TYPE CONTROLLER
            else if (ws.type === CLIENT_UNKNOWN && msg === CLIENT_CONTROLLER) addController(ws);
            // CLIENT ACK
            else if (ws.type === CLIENT_CONTROLLER && msg === '🎞️') {
                ws.ack = true;
                const controllersArr = [...controllers];
                const ack = controllersArr.reduce((ack, c) => ack && c.ack, true);
                if (ack) {
                    controllersArr.forEach((c) => (c.ack = false));
                    robot?.sendMessage('🎞️');
                }
            }
            // OBJECT DETECTION
            else if (msg.name === 'CV') {
                if (cv && !waitingFrame) {
                    waitingFrame = true;
                    cv.sendMessage(msg);
                }
            }
            // MOVE
            else if (msg.name === 'move') {
                robot?.sendMessage(msg);
            }
            // MOVE 2
            else if (msg.name === 'move2') {
                robot?.sendMessage(msg);
            }
            // PICK
            else if (msg === '🧲') {
                robot?.sendMessage(msg);
            }
            // PLACE
            else if (msg === '🎯') {
                robot?.sendMessage(msg);
            }
            // HOME
            else if (msg === '🏠') {
                robot?.sendMessage(msg);
            }
            // C2CS
            else if (msg.name === 'C2CS') {
                robot?.sendMessage(msg);
            }
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
        else if (ws.type === CLIENT_CV) unsetCV();
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
