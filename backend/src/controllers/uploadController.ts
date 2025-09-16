import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

const uploadDir = path.resolve('uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});

const upload = multer({ storage });

router.post('/', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  res.json({ success: true, file: {
    originalName: req.file.originalname,
    storedName: req.file.filename,
    path: req.file.path,
    size: req.file.size,
    mime: req.file.mimetype,
    url: `/assets/uploads/${req.file.filename}`
  }});
});

// File download endpoint for test execution files
router.get('/download/:filename', (req: Request, res: Response) => {
  try {
    const filename = req.params.filename;
    
    // Check if it's a video file
    if (filename.endsWith('.webm')) {
      const videoPath = path.join('test-results/videos', filename);
      if (fs.existsSync(videoPath)) {
        res.download(videoPath, filename);
        return;
      }
    }
    
    // Check if it's a screenshot file
    if (filename.endsWith('.png')) {
      const screenshotPath = path.join('test-results/screenshots', filename);
      if (fs.existsSync(screenshotPath)) {
        res.download(screenshotPath, filename);
        return;
      }
    }
    
    // Check if it's a debug package
    if (filename.endsWith('.zip')) {
      const debugPath = path.join('test-results/debug-packages', filename);
      if (fs.existsSync(debugPath)) {
        res.download(debugPath, filename);
        return;
      }
    }
    
    res.status(404).json({ success: false, error: 'File not found' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to download file' });
  }
});

export { router as uploadRoutes };

// List uploaded files
router.get('/', (_req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(uploadDir)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const p = path.join(uploadDir, f);
        const st = fs.statSync(p);
        return {
          storedName: f,
          path: p,
          size: st.size,
          uploadedAt: st.mtimeMs,
          url: `/assets/uploads/${f}`,
        };
      })
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json({ success: true, files });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to list uploads' });
  }
});

