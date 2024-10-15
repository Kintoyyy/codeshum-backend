const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Import cors
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8000;

// Use CORS middleware
// app.use(cors()); // Enable CORS for all routes

app.use(cors({
    origin: 'http://localhost:3000' // Replace with your frontend origin
}));


// Data structure to store active sessions
const sessions = {};

// Function to generate a unique session ID
function generateSessionId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

// Directory for saving user code files
const codeDir = path.join(__dirname, 'code');
if (!fs.existsSync(codeDir)) {
    fs.mkdirSync(codeDir);
}

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.json());

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('WebSocket connection established');

    // Generate a session ID for the new user
    const sessionId = generateSessionId();
    sessions[sessionId] = { ws }; // Store WebSocket connection in session

    ws.send('userId: ' + sessionId);

    ws.on('message', (message) => {
        console.log(`Received from client ${sessionId}:`, message);

        if (sessions[sessionId]?.javaProcess) {
            sessions[sessionId].javaProcess.stdin.write(message + '\n');
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for session ${sessionId}`);
        // Clean up resources associated with this session
        delete sessions[sessionId];
    });
});

// Endpoint to run Java code
// app.post('/run', (req, res) => {
//     const { sessionId, files } = req.body;

//     if (!sessionId || !sessions[sessionId]) {
//         return res.status(400).json({ error: 'Invalid session ID or session expired' });
//     }

//     if (!files || files.length === 0) {
//         return res.status(400).json({ error: 'At least one Java file is required' });
//     }

//     // Create code files and compile/run Java code
//     Promise.all(files.map(file => createCodeFile(sessionId, file.file_name, file.content)))
//         .then(() => {
//             const mainFile = files.find(file => file.isMain);
//             if (!mainFile) {
//                 return res.status(400).json({ error: 'Main Java file is missing' });
//             }
//             compileAndRunJava(sessionId, mainFile.file_name, res);
//         })
//         .catch(err => res.status(500).json({ error: err.message }));
// });

app.post('/run', async (req, res) => {
    const { sessionId, files } = req.body;

    if (!sessionId || !sessions[sessionId]) {
        return res.status(400).json({ error: 'Invalid session ID or session expired' });
    }

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'At least one Java file is required' });
    }

    try {
        // Create code files
        for (const file of files) {
            await createCodeFile(sessionId, file.file_name, file.content);
        }

        const mainFile = files.find(file => file.isMain);
        if (!mainFile) {
            return res.status(400).json({ error: 'Main Java file is missing' });
        }

        // Compile and run the main Java file
        compileAndRunJava(sessionId, mainFile.file_name, res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Create a code file for the user session
function createCodeFile(sessionId, fileName, code) {
    const userCodeDir = path.join(codeDir, sessionId);
    if (!fs.existsSync(userCodeDir)) {
        fs.mkdirSync(userCodeDir);
    }
    const filePath = path.join(userCodeDir, fileName);
    console.log(`Creating file for session ${sessionId}:`, filePath);
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

// Compile Java files for the user session
function compileJava(sessionId, res, callback) {
    const userCodeDir = path.join(codeDir, sessionId);
    exec(`javac ${userCodeDir}/*.java`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: stderr || error.message });
        }
        console.log(`Compiled successfully for session ${sessionId}`);
        callback();
    });
}

// Run the main Java file for the user session
function runJava(sessionId, mainFileName, res) {
    const userCodeDir = path.join(codeDir, sessionId);
    const className = path.basename(mainFileName, '.java');
    sessions[sessionId].javaProcess = spawn('java', ['-cp', userCodeDir, className]);

    sessions[sessionId].javaProcess.stdout.on('data', (data) => {
        broadcast(sessionId, data.toString());
    });

    sessions[sessionId].javaProcess.stderr.on('data', (data) => {
        broadcast(sessionId, `ERROR: ${data.toString()}`);
    });

    sessions[sessionId].javaProcess.on('close', (code) => {
        broadcast(sessionId, `Process exited with code ${code}`);
        // Clean up resources after execution
        delete sessions[sessionId].javaProcess;
    });

    res.json({ message: 'Execution started, check the WebSocket for live output.' });
}

// Compile and run the Java code
function compileAndRunJava(sessionId, mainFileName, res) {
    compileJava(sessionId, res, () => {
        runJava(sessionId, mainFileName, res);
    });
}

// Broadcast messages to the WebSocket client for the session
function broadcast(sessionId, message) {
    if (sessions[sessionId]?.ws) {
        sessions[sessionId].ws.send(message);
    }
}

wss.on('close', () => {
    console.log(`WebSocket connection closed for session ${sessionId}`);

    // Clean up resources associated with this session
    if (sessions[sessionId]) {
        // Delete the user code directory
        console.log(`Cleaning up resources for session ${sessionId}`);
        const userCodeDir = path.join(codeDir, sessionId);
        if (fs.existsSync(userCodeDir)) {
            fs.rmSync(userCodeDir, { recursive: true, force: true });
            console.log(`Deleted files for session ${sessionId}`);
        }
        delete sessions[sessionId];
    }
});

// Function to clean up expired sessions
function cleanupSessions() {
    const currentTime = Date.now();
    Object.keys(sessions).forEach(sessionId => {
        const session = sessions[sessionId];

        // Check if session has a timeout of 5 minutes (300000 ms)
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

// Call cleanupSessions every minute
setInterval(cleanupSessions, 60000);

// Update session lastActive time on message received
wss.on('message', (message) => {
    console.log(`Received from client ${sessionId}:`, message);
    sessions[sessionId].lastActive = Date.now(); // Update last active time

    if (sessions[sessionId]?.javaProcess) {
        sessions[sessionId].javaProcess.stdin.write(message + '\n');
    }
});


// Start the server
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
