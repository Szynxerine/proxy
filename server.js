// File: server.js (Versi Final Diperbaiki - KITSUNE PROXY HUB)

import express from 'express';
import axios from 'axios';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import os from 'os-utils';

// ================== KONFIGURASI ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const TEMP_DIR = path.join(__dirname, 'temp_files');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_DIR = path.join(__dirname, 'docs');
const JOB_LIFETIME = 10 * 60 * 1000; // 10 menit
// ===============================================

// --> 1. Polisi Tidur (Rate Limiter)
const apiLimiter = rateLimit({
  windowMs: 1000,
  max: 5,
  message: { success: false, message: 'Bro, jangan nge-spam! Santai aja.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --> 2. Manajemen State
const jobs = new Map();
const serverStats = {
    startTime: new Date(),
    proxy: {
        totalRequests: 0,
        totalDataTransferred: 0,
    }
};

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(apiLimiter);

// Sajikan file statis (Docs, Public, Downloads)
app.use(express.static(DOCS_DIR)); // Docs sebagai root
app.use(express.static(PUBLIC_DIR)); // Public untuk stats-style.css, dll
app.use('/downloads', express.static(TEMP_DIR));

// ==========================================================
// RUTE KHUSUS UNTUK URL CANTIK
// ==========================================================

// Redirect root ke halaman dokumentasi utama
app.get('/', (req, res) => {
    res.redirect('/index.html');
});

// Rute untuk /stats agar menampilkan stats.html
app.get('/stats', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'stats.html'));
});


// ==========================================================
// BAGIAN 1: PROXY DOWNLOADER (Sistem Job Asynchronous)
// ... (TIDAK ADA PERUBAHAN DI BAGIAN INI, BIARKAN SEPERTI ADANYA)
// ==========================================================

async function processDownloadJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        job.status = 'downloading';
        job.progress = 0;
        console.log(`[JOB ${jobId}] Mulai download dari: ${job.sourceLink}`);

        const response = await axios({
            method: 'get',
            url: job.sourceLink,
            headers: job.headers,
            responseType: 'stream'
        });

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        const writer = fs.createWriteStream(job.filePath);
        response.data.pipe(writer);

        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (totalSize) {
                job.progress = Math.round((downloadedSize / totalSize) * 100);
            }
        });

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                job.status = 'completed';
                job.progress = 100;
                console.log(`[JOB ${jobId}] Selesai! Disimpan sebagai ${job.filename}`);
                
                setTimeout(() => {
                    jobs.delete(jobId);
                    fsp.unlink(job.filePath).catch(() => {});
                    console.log(`[JOB ${jobId}] Data dan file telah dihapus dari server.`);
                }, JOB_LIFETIME);

                resolve();
            });
            writer.on('error', (error) => {
                job.status = 'failed';
                job.error = 'Gagal menyimpan file ke disk.';
                reject(error);
            });
        });

    } catch (error) {
        console.error(`[JOB ${jobId}] Gagal:`, error.message);
        job.status = 'failed';
        job.error = error.message;
    }
}

app.post('/api/request-download', (req, res) => {
    const { link, headers = {}, filenameHint } = req.body;
    if (!link || !filenameHint) {
        return res.status(400).json({ success: false, message: 'Parameter "link" dan "filenameHint" wajib.' });
    }

    const jobId = uuidv4();
    const safeFilename = filenameHint.replace(/\s+/g, '_').replace(/[^a-z0-9._-]/gi, '_');
    const uniqueFilename = `${jobId.split('-')[0]}-${safeFilename}`;
    
    const host = req.get('host');
    const protocol = req.protocol;

    const newJob = {
        id: jobId, status: 'pending', progress: 0, error: null, sourceLink: link,
        headers, filename: uniqueFilename, filePath: path.join(TEMP_DIR, uniqueFilename),
        finalUrl: `${protocol}://${host}/downloads/${uniqueFilename}`,
        pollingUrl: `${protocol}://${host}/api/status/${jobId}`
    };

    jobs.set(jobId, newJob);
    console.log(`[SERVER] Job baru dibuat: ${jobId} untuk file ${safeFilename}`);

    res.status(202).json({
        success: true, message: 'Permintaan diterima! Gunakan pollingUrl untuk cek status.',
        jobId: newJob.id, pollingUrl: newJob.pollingUrl
    });

    processDownloadJob(jobId);
});

app.get('/api/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ success: false, message: 'Job tidak ditemukan.' });
    }

    let response;
    switch(job.status) {
        case 'pending': response = { status: 'pending', message: 'Download akan segera dimulai...' }; break;
        case 'downloading': response = { status: 'downloading', progress: job.progress, message: `Sedang mendownload... ${job.progress}%` }; break;
        case 'completed': response = { status: 'completed', message: 'Download Selesai!', downloadLink: job.finalUrl, filename: job.filename }; break;
        case 'failed': response = { status: 'failed', message: 'Download Gagal.', error: job.error }; break;
    }

    res.json({ success: true, ...response });
});


// ==========================================================
// BAGIAN 2: LIVE PROXY SERVER
// ... (TIDAK ADA PERUBAHAN DI BAGIAN INI)
// ==========================================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('<h1>Parameter URL "url" wajib ada.</h1><p>Contoh: /proxy?url=https://example.com</p>');
    }

    try {
        console.log(`[PROXY] Meminta ke: ${targetUrl}`);
        const response = await axios({
            method: 'get', url: targetUrl, responseType: 'stream',
            headers: { 'User-Agent': req.headers['user-agent'], 'Accept': req.headers['accept'], 'Accept-Language': req.headers['accept-language'] }
        });
        
        serverStats.proxy.totalRequests++;
        response.data.on('data', chunk => { serverStats.proxy.totalDataTransferred += chunk.length; });

        res.set(response.headers);
        response.data.pipe(res);

    } catch (error) {
        console.error(`[PROXY] Gagal: ${error.message}`);
        res.status(error.response?.status || 500).json({
            success: false, message: `Gagal mem-proxy URL: ${targetUrl}`, error: error.message
        });
    }
});

// ==========================================================
// BAGIAN 3: STATS DASHBOARD API
// ... (TIDAK ADA PERUBAHAN DI BAGIAN INI)
// ==========================================================
app.get('/api/stats', (req, res) => {
    const currentJobs = Array.from(jobs.values());
    const formatUptime = (ms) => {
        const s = Math.floor(ms / 1000), d = Math.floor(s / 86400),
              h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        return `${d}d ${h}h ${m}m`;
    };

    os.cpuUsage(cpuPercent => {
        res.json({
            uptime: formatUptime(new Date() - serverStats.startTime), cpuUsage: cpuPercent,
            memFree: os.freememPercentage(), proxyStats: serverStats.proxy,
            jobs: {
                total: currentJobs.length,
                pending: currentJobs.filter(j => j.status === 'pending').length,
                downloading: currentJobs.filter(j => j.status === 'downloading').length,
                all: currentJobs
            }
        });
    });
});

// ================== Jalankan Server ==================
Promise.all([
    fsp.mkdir(TEMP_DIR, { recursive: true }),
    fsp.mkdir(PUBLIC_DIR, { recursive: true }),
    fsp.mkdir(DOCS_DIR, { recursive: true })
]).then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[SERVER] Kitsune Proxy Hub siap!`);
        console.log(`> Dokumentasi & Main: http://localhost:${PORT}/`);
        console.log(`> Dashboard Stats:    http://localhost:${PORT}/stats`); // <-- URL SUDAH DIPERBAIKI
        console.log(`> Live Proxy:         http://localhost:${PORT}/proxy?url=...`);
        console.log(`> Downloader API:     POST http://localhost:${PORT}/api/request-download`);
        console.log(`Server listen di 0.0.0.0:${PORT} untuk akses eksternal.`);
    });
}).catch(err => console.error('Gagal memulai server:', err));