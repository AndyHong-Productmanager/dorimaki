// In-process WebSocket-to-TCP bridge (websockify replacement).
// Accepts WebSocket connections and pipes raw bytes to/from a TCP target.
// Used by /screenshare to bridge noVNC (WebSocket) to a VNC server (TCP).
// Supports the 'binary' subprotocol required by noVNC.
import { WebSocketServer, WebSocket } from 'ws';
import net from 'node:net';
import { createLogger } from './logger.js';
const logger = createLogger('SCREEN');
export function startWebsockify({ wsPort, tcpHost, tcpPort, }) {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({
            port: wsPort,
            // noVNC negotiates the 'binary' subprotocol
            handleProtocols: (protocols) => {
                if (protocols.has('binary')) {
                    return 'binary';
                }
                return false;
            },
        });
        wss.on('listening', () => {
            const addr = wss.address();
            const port = typeof addr === 'object' && addr ? addr.port : wsPort;
            logger.log(`Websockify listening on port ${port} → ${tcpHost}:${tcpPort}`);
            resolve({
                wss,
                port,
                close: () => {
                    for (const client of wss.clients) {
                        client.close();
                    }
                    wss.close();
                },
            });
        });
        wss.on('error', (err) => {
            reject(new Error('Websockify failed to start', { cause: err }));
        });
        wss.on('connection', (ws) => {
            const tcp = net.createConnection(tcpPort, tcpHost, () => {
                logger.log(`TCP connection established to ${tcpHost}:${tcpPort}`);
            });
            tcp.on('data', (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(data);
                }
            });
            ws.on('message', (data) => {
                if (!tcp.destroyed) {
                    tcp.write(data);
                }
            });
            ws.on('close', () => {
                tcp.destroy();
            });
            ws.on('error', (err) => {
                logger.error('WebSocket error:', err);
                tcp.destroy();
            });
            tcp.on('close', () => {
                ws.close();
            });
            tcp.on('error', (err) => {
                logger.error('TCP connection error:', err);
                ws.close();
            });
        });
    });
}
