const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const TIMEOUT_LIMIT = 1000;

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors({
    origin: 'http://localhost:3000'
}));

const sessions = {};

function generateSessionId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

const codeDir = path.join(__dirname, 'code');
if (!fs.existsSync(codeDir)) {
    fs.mkdirSync(codeDir);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.json());

wss.on('connection', (ws) => {
    console.log('WebSocket connection established');

    const sessionId = generateSessionId();
    sessions[sessionId] = { ws };

    ws.send('userId: ' + sessionId);

    ws.on('message', (message) => {
        console.log(`Received from client ${sessionId}:`, message);

        if (sessions[sessionId]?.javaProcess) {
            sessions[sessionId].javaProcess.stdin.write(message + '\n');
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for session ${sessionId}`);

        if (sessions[sessionId]) {
            console.log(`Cleaning up resources for session ${sessionId}`);
            const userCodeDir = path.join(codeDir, sessionId);
            if (fs.existsSync(userCodeDir)) {
                fs.rmSync(userCodeDir, { recursive: true, force: true });
                console.log(`Deleted files for session ${sessionId}`);
            }
            delete sessions[sessionId];
        }
    });
});

app.post('/run', async (req, res) => {
    const { sessionId, files } = req.body;

    if (!sessionId || !sessions[sessionId]) {
        return res.status(400).json({ error: 'Invalid session ID or session expired' });
    }

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'At least one Java file is required' });
    }

    try {
        for (const file of files) {
            await createCodeFile(sessionId, file.file_name, file.content);
        }

        const mainFile = files.find(file => file.isMain);
        if (!mainFile) {
            return res.status(400).json({ error: 'Main Java file is missing' });
        }

        compileAndRunJava(sessionId, mainFile.file_name, res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


function createCodeFile(sessionId, fileName, code) {
    const userCodeDir = path.join(codeDir, sessionId);
    if (!fs.existsSync(userCodeDir)) {
        fs.mkdirSync(userCodeDir);
    }
    const filePath = path.join(userCodeDir, fileName);
    console.log(`Creating file for session ${sessionId}: ${fileName}`);
    return new Promise((resolve, reject) => {
        fs.writeFile(filePath, code, (err) => {
            if (err) {
                reject(new Error('Error saving the Java file'));
            } else {
                resolve();
            }
        });
    });
}


function compileJava(sessionId, res, callback) {
    const userCodeDir = path.join(codeDir, sessionId);
    exec(`javac ${userCodeDir}/*.java`, (error, stdout, stderr) => {
        if (error) {
            const errorMessage = stderr.replace(new RegExp(`^${userCodeDir.replace(/\\/g, '\\\\')}\\\\?`, 'gm'), '');
            broadcast(sessionId, `ERROR:\n${errorMessage.trim()}`);
            return res.status(500).json({ error: 'Compilation error occurred' });
        }
        console.log(`Compiled successfully for session ${sessionId}`);
        callback();
    });
}


function runJava(sessionId, mainFileName, res) {
    const userCodeDir = path.join(codeDir, sessionId);
    const className = path.basename(mainFileName, '.java');

    sessions[sessionId].javaProcess = spawn('java', ['-cp', userCodeDir, className]);

    // const timeout = setTimeout(() => {
    //     console.log(`Terminating process for session ${sessionId} due to timeout`);
    //     sessions[sessionId].javaProcess.kill();
    //     broadcast(sessionId, 'Infinity loop');
    // }, TIMEOUT_LIMIT);

    sessions[sessionId].javaProcess.stdout.on('data', (data) => {
        broadcast(sessionId, data.toString());
    });

    sessions[sessionId].javaProcess.stderr.on('data', (data) => {
        broadcast(sessionId, data.toString());
    });

    sessions[sessionId].javaProcess.on('close', (code) => {
        // clearTimeout(timeout);
        if (code === 0) {
            broadcast(sessionId, `Code executed successfully`);
        } else {
            broadcast(sessionId, 'Execution failed with an error.');
        }
        delete sessions[sessionId].javaProcess;
    });

    res.json({ message: 'Execution started, check the WebSocket for live output.' });
}


function compileAndRunJava(sessionId, mainFileName, res) {
    compileJava(sessionId, res, () => {
        runJava(sessionId, mainFileName, res);
    });
}

function broadcast(sessionId, message) {
    if (sessions[sessionId]?.ws) {
        sessions[sessionId].ws.send(message);
    }
}

function cleanupSessions() {
    const currentTime = Date.now();
    Object.keys(sessions).forEach(sessionId => {
        const session = sessions[sessionId];

        if (currentTime - session.lastActive > 300000) {
            console.log(`Cleaning up expired session ${sessionId}`);
            const userCodeDir = path.join(codeDir, sessionId);
            if (fs.existsSync(userCodeDir)) {
                fs.rmSync(userCodeDir, { recursive: true, force: true });
                console.log(`Deleted files for expired session ${sessionId}`);
            }
            delete sessions[sessionId];
        }
    });
}

setInterval(cleanupSessions, 60000);

wss.on('message', (message) => {
    console.log(`Received from client ${sessionId}:`, message);
    sessions[sessionId].lastActive = Date.now();

    if (sessions[sessionId]?.javaProcess) {
        sessions[sessionId].javaProcess.stdin.write(message + '\n');
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
