import http from 'node:http';
import { WebSocketServer } from 'ws';

const HOSTNAME = '0.0.0.0';
const PORT = 8888;
const server = http.createServer();
let retryTimeoutId = -1;

// -------- HTTP SERVER --------

server.on('request', (req, res) => {
    console.log(`[HTTP] "${req.socket.remoteAddress}" ${req.method} ${req.headers.host}${req.url}`);
    switch (req.url) {
        case '/':
            res.setHeader('Content-Type', 'text/plain');
            res.write('Hello World!');
            res.end();
            break;
        default:
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/html');
            res.end();
            break;
    }
});

server.on('listening', () => console.log(`[HTTP] Server is listening on ${HOSTNAME}:${PORT}`));
server.on('close', () => console.log('[HTTP] Server is closed.'));
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

// -------- WEBSOCKET SERVER --------

const wss = new WebSocketServer({ server });
const td = new TextDecoder();

wss.robot = null;
wss.controllers = new Set();

wss.on('listening', () => {
    console.log('[WSS] Server is listening');
});

// ws.ping(null, false, (error) => console.log('ws ping cb: ', error));
// ws.send('hello', (error) => console.log('ws message cb:', error));
wss.on('connection', (ws, req) => {
    console.log(`[WSS] Client connected from "${req.socket.remoteAddress}" Total: ${wss.clients.size}`);

    ws.type = '❓';
    ws.sendMessage = (msg, cb) => {
        const msgStr = JSON.stringify(msg);
        ws.send(msgStr);
    };

    // ws.ppp = Date.now();
    // ws.ping();

    // setTimeout(() => {
    //     fs.readFile('test.jpg').then((imgBuf) => {
    //         console.log(new Date(), 'send test.jpg', byteSize(imgBuf.length).toString());
    //         // ws.send(imgBuf, (err) => console.log('send test.jpg cb:', err));
    //         ws.send(imgBuf);
    //     });
    // }, 1);

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            handleFrameBuffer(ws, data);
        } else {
            const msgStr = td.decode(data);
            const msg = JSON.parse(msgStr);
            handleMessage(ws, msg);
        }
    });

    ws.on('ping', (data) => {
        console.log(`[WS ${ws.type}] Ping:`, data);
    });

    ws.on('pong', (data) => {
        console.log(`[WS ${ws.type}] Pong:`, data);
    });

    ws.on('error', (error) => {
        console.error(`[WS ${ws.type}] Error:`, error);
    });

    ws.on('close', (code, reason) => {
        console.log('[WS] Client Connection closed:', code, reason);
        if (ws.type === '🧠') {
            wss.controllers.delete(ws);
        } else if (ws.type === '🤖') {
            wss.robot = null;
        }
    });
});

wss.on('error', (error) => {
    console.error('[WSS]', error);
});

wss.on('close', () => {
    console.log('[WSS] Server is closed');
});

function handleMessage(ws, msg) {
    // console.log(`[WS ${ws.type}] Message:`, msg);

    if (msg === '🤖') {
        ws.type = '🤖';
        wss.robot = ws;
        wss.controllers.delete(ws);
        if (wss.controllers.size > 0) {
            ws.sendMessage('start');
        }
    } else if (msg === '🧠') {
        ws.type = '🧠';
        const shouldStart = wss.controllers.size < 1;
        wss.controllers.add(ws);

        if (shouldStart) {
            wss.robot?.sendMessage('start');
        }
    }
}

function handleFrameBuffer(ws, frameBuffer) {
    if (wss.robot && ws !== wss.robot) return;
    // console.log(`[WS ${ws.type}] New Frame Buffer: ${byteSize(frameBuffer.length).toString()}`);

    if (wss.controllers.size < 1) {
        ws.sendMessage('stop');
        return;
    }

    wss.controllers.forEach((c) => {
        c.send(frameBuffer);
    });
}

// // ws.sendingFrameBuffer = false
// ws.chunkIndex = 0;
// ws.frameStream = fs.createReadStream('test.jpg', { highWaterMark: 10_000 });
// ws.frameStream.on('data', (chunk) => {
//     ws.send(chunk, { binary: true }, (err) => {
//         console.log('chunk', ws.chunkIndex, err);
//         ws.chunkIndex++;
//     });
// });

// // ws.frameStream.on('readable', () => {
// //     if(!ws.sendingFrameBuffer){
// //         ws.send(stream.read(), (err) => {
// //             if(err){
// //                 console.error(err)
// //                 ws.frameStream.close()
// //                 ws.close()
// //             }
// //             else{
// //                 console.log('Image Buffer chunk sent.')
// //                 ws.sendingFrameBuffer = false
// //             }
// //         })
// //     }
// //     console.log('readable');
// //     if (i != 0) return;
// //     console.log(stream.read());
// //     i++;
// // });
// ws.frameStream.on('end', () => {
//     console.log('frame stream ended');
//     ws.send('end');
// });

// // const blob = new Blob(['Hello World'], { type: 'text/plain' });
// // ws.send(blob, { binary: true });

// -------- HANDLE PROCESS EXIT SIGNALS --------

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
