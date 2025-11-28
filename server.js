const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { PDFDocument, degrees } = require('pdf-lib');
const Queue = require('better-queue');

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ],
});

const app = express();
const PORT = process.env.PORT || 8712;
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '200', 10);

// Session setup
app.use(session({
    genid: function (req) {
        return uuidv4();
    },
    secret: 'pdf-editor-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Merge Queue Setup
const mergeQueue = new Queue(async function (task, cb) {
    logger.info(`Starting merge task for session ${task.sessionId}`);
    try {
        const { filePaths, outputPath } = task;
        const mergedPdf = await PDFDocument.create();

        for (const filePath of filePaths) {
            if (fs.existsSync(filePath)) {
                const pdfBytes = fs.readFileSync(filePath);
                const pdf = await PDFDocument.load(pdfBytes);
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach((page) => mergedPdf.addPage(page));
            } else {
                logger.warn(`File not found during merge: ${filePath}`);
            }
        }

        const pdfBytes = await mergedPdf.save();
        fs.writeFileSync(outputPath, pdfBytes);
        logger.info(`Merge completed for session ${task.sessionId}`);
        cb(null, outputPath);
    } catch (error) {
        logger.error(`Merge failed for session ${task.sessionId}: ${error.message}`);
        cb(error);
    }
}, { concurrent: 2 }); // Allow 2 concurrent merges to avoid resource exhaustion

// Multer setup
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const sessionDir = path.join(uploadsDir, req.sessionID);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        cb(null, sessionDir);
    },
    filename: function (req, file, cb) {
        // Improve safeName to support Chinese characters (by using UUID + extension) or just sanitizing
        // Using UUID ensures uniqueness and avoids encoding issues on disk
        const ext = path.extname(file.originalname);
        const safeName = uuidv4() + ext;
        cb(null, safeName);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(null, false);
        }
    },
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

// Routes
app.get('/', (req, res) => {
    if (!req.session.files) {
        req.session.files = [];
    }
    res.render('index', { files: req.session.files });
});

app.post('/upload', (req, res, next) => {
    upload.array('files')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            logger.error(`Multer Error: ${err.message}`);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: `文件过大，单个文件大小上限为 ${MAX_UPLOAD_MB}MB` });
            }
            return res.status(500).json({ success: false, message: `上传错误: ${err.message}` });
        } else if (err) {
            logger.error(`Upload Error: ${err.message}`);
            return res.status(500).json({ success: false, message: `服务器错误: ${err.message}` });
        }
        next();
    });
}, (req, res) => {
    logger.info(`Session ${req.sessionID} uploaded ${req.files ? req.files.length : 0} files.`);

    if (!req.session.files) {
        req.session.files = [];
    }

    const newFiles = (req.files || []).map(file => ({
        filename: file.filename,
        originalname: Buffer.from(file.originalname, 'latin1').toString('utf8'), // Attempt to fix encoding if needed, or just use original
        path: file.path,
        size: file.size,
        url: `/uploads/${req.sessionID}/${file.filename}`
    }));

    // Fix encoding: Multer often messes up UTF-8 filenames (rendering them as latin1)
    // We try to decode them back. If it's already correct, this might break it, but usually standard express/multer issue.
    // Let's check if we really need this. For now, let's just stick to originalname but beware of garbled text.
    // Actually, let's apply the common fix: file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    newFiles.forEach(f => {
        try {
            // Simple heuristic: if it looks like garbage, try to fix. 
            // But standard node behavior depends on OS.
            // Let's just trust it for now, or apply the fix unconditionally if we see issues.
            // Given user reported 500 error, not encoding error, I will skip complex encoding logic for now
            // but I will modify the safeName logic to support Chinese characters better.
        } catch (e) { }
    });

    try {
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
        newFiles.sort((a, b) => collator.compare(a.originalname, b.originalname));
        req.session.files = [...req.session.files, ...newFiles];
        req.session.files.sort((a, b) => collator.compare(a.originalname, b.originalname));
    } catch (e) {
        req.session.files = [...req.session.files, ...newFiles];
    }

    res.json({ success: true, files: newFiles });
});

app.post('/clear', (req, res) => {
    const sessionDir = path.join(uploadsDir, req.sessionID);
    if (fs.existsSync(sessionDir)) {
        try {
            // Delete all files in the directory
            fs.readdirSync(sessionDir).forEach(file => {
                const curPath = path.join(sessionDir, file);
                fs.unlinkSync(curPath);
            });
            // Don't remove directory itself as user might upload more
        } catch (e) {
            logger.error(`Error clearing session dir: ${e.message}`);
        }
    }
    req.session.files = [];
    res.json({ success: true });
});

app.post('/clear-selected', express.json(), (req, res) => {
    const { fileIds } = req.body || {};
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({ success: false, message: '未选择文件。' });
    }
    const sessionDir = path.join(uploadsDir, req.sessionID);
    const sessionFiles = req.session.files || [];
    let deleted = 0;
    for (const id of fileIds) {
        const fileObj = sessionFiles.find(f => f.filename === id);
        if (fileObj && fs.existsSync(fileObj.path)) {
            try {
                fs.unlinkSync(fileObj.path);
                deleted += 1;
            } catch (e) {
                logger.error(`Error deleting file ${id}: ${e.message}`);
            }
        }
    }
    req.session.files = sessionFiles.filter(f => !fileIds.includes(f.filename));
    return res.json({ success: true, deleted });
});

app.post('/merge', express.json(), async (req, res) => {
    const { fileIds, pageItems } = req.body;
    const sessionFiles = req.session.files || [];

    if (Array.isArray(pageItems) && pageItems.length >= 1) {
        const outputFilename = `merged-${Date.now()}.pdf`;
        const sessionDir = path.join(uploadsDir, req.sessionID);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        const outputPath = path.join(sessionDir, outputFilename);

        try {
            const mergedPdf = await PDFDocument.create();
            for (const item of pageItems) {
                if (!item || !item.filename || typeof item.page !== 'number') continue;
                const fileObj = sessionFiles.find(f => f.filename === item.filename);
                if (!fileObj || !fs.existsSync(fileObj.path)) continue;
                const pdfBytes = fs.readFileSync(fileObj.path);
                const pdf = await PDFDocument.load(pdfBytes);
                const index = Math.max(0, Math.min(item.page - 1, pdf.getPageCount() - 1));
                const [copiedPage] = await mergedPdf.copyPages(pdf, [index]);
                if (typeof item.rotate === 'number' && item.rotate % 360 !== 0) {
                    copiedPage.setRotation(degrees(item.rotate % 360));
                }
                mergedPdf.addPage(copiedPage);
            }
            const bytes = await mergedPdf.save();
            fs.writeFileSync(outputPath, bytes);
            const downloadUrl = `/download/${req.sessionID}/${outputFilename}`;
            return res.json({ success: true, downloadUrl, filename: outputFilename });
        } catch (error) {
            logger.error(`Page-level merge failed: ${error.message}`);
            return res.status(500).json({ success: false, message: "合并失败。" });
        }
    }

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length < 1) {
        return res.status(400).json({ success: false, message: "请至少选择1个文件。" });
    }

    const filesToMerge = [];
    for (const id of fileIds) {
        const fileObj = sessionFiles.find(f => f.filename === id);
        if (fileObj) filesToMerge.push(fileObj.path);
    }
    if (filesToMerge.length < 1) {
        return res.status(400).json({ success: false, message: "未找到选中的文件。" });
    }

    const outputFilename = `merged-${Date.now()}.pdf`;
    const sessionDir = path.join(uploadsDir, req.sessionID);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const outputPath = path.join(sessionDir, outputFilename);

    mergeQueue.push({ filePaths: filesToMerge, outputPath, sessionId: req.sessionID })
        .on('finish', () => {
            const downloadUrl = `/download/${req.sessionID}/${outputFilename}`;
            res.json({ success: true, downloadUrl, filename: outputFilename });
        })
        .on('failed', (err) => {
            logger.error(`Merge queue error: ${err.message}`);
            res.status(500).json({ success: false, message: "合并失败。" });
        });
});

// Force download route to avoid in-browser PDF viewer navigation
app.get('/download/:sid/:filename', (req, res) => {
    const { sid, filename } = req.params;
    const custom = req.query.name;
    if (sid !== req.sessionID) {
        return res.status(403).json({ success: false, message: '权限不足' });
    }
    const filePath = path.join(uploadsDir, sid, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: '文件不存在' });
    }
    res.download(filePath, custom || filename);
});

// Global Error Handler
app.use((err, req, res, next) => {
    logger.error(`Unhandled Error: ${err.message}`);
    logger.error(err.stack);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({ success: false, message: "服务器内部错误，请稍后重试。" });
});

app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});
