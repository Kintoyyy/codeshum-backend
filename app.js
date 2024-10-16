const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8000;
const sessions = {};
const codeDir = path.join(__dirname, 'code');

if (!fs.existsSync(codeDir)) {
    fs.mkdirSync(codeDir);
}

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function generateSessionId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

wss.on('connection', (ws) => {
    console.log('WebSocket connection established');
    const sessionId = generateSessionId();
    sessions[sessionId] = { ws };
    ws.send(JSON.stringify({ userId: sessionId }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        console.log(`Received from client ${sessionId}:`, data);

        if (data.type === 'input' && sessions[sessionId]?.javaProcess) {
            sessions[sessionId].javaProcess.stdin.write(data.command + '\n');
        }

    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for session ${sessionId}`);
        // cleanupSession(sessionId);

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

function compileAndRunJava(sessionId, mainFileName, res) {
    const userCodeDir = path.join(codeDir, sessionId);
    exec(`javac ${userCodeDir}/*.java`, (error, stdout, stderr) => {
        if (error) {
            // Extract and clean the error message for better readability
            const errorMessage = stderr.replace(
                new RegExp(`^${userCodeDir.replace(/\\/g, '\\\\')}\\\\?`, 'gm'),
                ''
            ).trim();

            // Broadcast the error message to the WebSocket client
            // broadcast(sessionId, { output: `${errorMessage}\n` });

            // Send a 500 response to the API caller with detailed error info
            return res.status(500).json({ error: errorMessage });
        }

        console.log(`Compiled successfully for session ${sessionId}`);
        runJava(sessionId, mainFileName, res);
    });
}


function runJava(sessionId, mainFileName, res) {
    const userCodeDir = path.join(codeDir, sessionId);
    const className = path.basename(mainFileName, '.java');
    const session = sessions[sessionId];

    session.javaProcess = spawn('java', ['-cp', userCodeDir, className]);

    let isWaitingForInput = false;

    // Listen for output from the Java process
    session.javaProcess.stdout.on('data', (data) => {
        const output = data.toString();

        if (/enter|input|scan|prompt|waiting/i.test(output)) {
            isWaitingForInput = true;
        } else {
            isWaitingForInput = false;
        }

        broadcast(sessionId, { output, isWaitingForInput });
    });

    // Listen for errors from the Java process
    session.javaProcess.stderr.on('data', (data) => {
        broadcast(sessionId, { output: data.toString() });
    });

    // Listen for the process to close
    session.javaProcess.on('close', (code) => {
        const message = code === 0
            ? 'Code executed successfully'
            : 'Execution failed with an error.';
        broadcast(sessionId, { message });

        // Clean up the process
        delete session.javaProcess;
    });

    // Send initial response to the client
    res.json({ message: 'Execution started, check the WebSocket for live output.' });
}


function broadcast(sessionId, message) {
    if (sessions[sessionId]?.ws) {
        console.log(`Broadcasting to session ${sessionId}:`, message);
        sessions[sessionId].ws.send(JSON.stringify({ message }));
    }
}

function cleanupSession(sessionId) {
    console.log(`Cleaning up resources for session ${sessionId}`);
    const userCodeDir = path.join(codeDir, sessionId);
    if (fs.existsSync(userCodeDir)) {
        fs.rmSync(userCodeDir, { recursive: true, force: true });
        console.log(`Deleted files for session ${sessionId}`);
    }
    delete sessions[sessionId];
}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
