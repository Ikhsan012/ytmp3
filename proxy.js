const express = require('express');
const bodyParser = require('body-parser');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
const Queue = require('bull');
const redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILES = 10;
const downloadsDir = path.join(__dirname, 'downloads');

// Middleware
app.use(bodyParser.json());

// Ensure the downloads directory exists
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Serve static files from 'public' directory
app.use(express.static('public'));

// Serve the index.html file at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Function to delete oldest files if the number exceeds MAX_FILES
const deleteOldestFiles = (dir) => {
    const files = fs.readdirSync(dir)
        .map(file => ({ file, time: fs.statSync(path.join(dir, file)).mtime.getTime() }))
        .sort((a, b) => a.time - b.time);

    while (files.length > MAX_FILES) {
        const oldestFile = files.shift();
        fs.unlinkSync(path.join(dir, oldestFile.file));
    }
};

// Create a new Bull queue
const audioQueue = new Queue('audio download', {
    redis: {
        host: '127.0.0.1',
        port: 6379
    }
});

// Process the audio download job
audioQueue.process(async (job, done) => {
    const { url, filename } = job.data;
    const filepath = path.join(downloadsDir, filename);

    try {
        const writeStream = fs.createWriteStream(filepath);

        writeStream.on('finish', () => {
            deleteOldestFiles(downloadsDir);
            done(null, { downloadUrl: `/downloads/${filename}`, filename: filename });
        });

        writeStream.on('error', (error) => {
            console.error(error);
            done(error);
        });

        ytdl(url, { filter: 'audioonly', quality: 'highestaudio' }).pipe(writeStream);
    } catch (error) {
        console.error(error);
        done(error);
    }
});

app.post('/download', async (req, res) => {
    const { url } = req.body;

    if (!ytdl.validateURL(url)) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL' });
    }

    try {
        const info = await ytdl.getInfo(url);
        const filename = `${info.videoDetails.title.replace(/[<>:"/\\|?*]+/g, '')}.mp3`;

        const job = await audioQueue.add({ url, filename });
        res.json({ success: true, message: 'Audio download is being processed', jobId: job.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error processing the audio download' });
    }
});

// Serve files from the 'downloads' directory
app.use('/downloads', express.static(downloadsDir));

app.get('/status/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const job = await audioQueue.getJob(jobId);

    if (job === null) {
        return res.status(404).json({ status: 'not found' });
    }

    const state = await job.getState();
    const result = await job.finished().catch(err => err);

    res.json({
        status: state,
        data: result
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});