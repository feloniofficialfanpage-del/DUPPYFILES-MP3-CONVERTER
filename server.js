
const express = require("express");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dns = require("dns").promises;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

function getYouTubeId(value) {
  try {
    const u = new URL(value);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname === "youtube.com" ||
        u.hostname.endsWith(".youtube.com")) {
      return u.searchParams.get("v") ||
        u.pathname.split("/").filter(Boolean).pop();
    }
  } catch (_) {}
  return null;
}

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    return ip === "::1" || ip.startsWith("fc") ||
      ip.startsWith("fd") || ip.startsWith("fe80");
  }

  const p = ip.split(".").map(Number);

  return p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168);
}

async function checkMediaUrl(value) {
  const u = new URL(value);

  if (u.protocol !== "https:" || u.username || u.password) {
    throw new Error("Only valid HTTPS media links are accepted.");
  }

  const host = u.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("This media host is not allowed.");
  }

  const addresses = await dns.lookup(host, { all: true });

  if (!addresses.length ||
      addresses.some(a => isPrivateIp(a.address))) {
    throw new Error("This media host is not allowed.");
  }

  return u;
}

function runFfmpeg(input, output, format) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", input];

    if (format === "mp3") {
      args.push("-vn", "-codec:a", "libmp3lame", "-q:a", "2");
    } else {
      args.push(
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart"
      );
    }

    args.push(output);

    const process = spawn(ffmpegPath, args);
    let errorText = "";

    process.stderr.on("data", data => {
      errorText += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errorText.slice(-1000) || "FFmpeg failed."));
    });
  });
}

app.get("/", (req, res) => {
  res.json({
    name: "DUPPYFILES YOUTUBE TO MP3/MP4",
    status: "Backend online",
    storage: "Cloudinary",
    formats: ["mp3", "mp4"]
  });
});

app.post("/inspect", async (req, res) => {
  try {
    const id = getYouTubeId(req.body.url || "");

    if (!id) {
      return res.status(400).json({
        recognized: false,
        message: "Enter a valid YouTube link."
      });
    }

    const response = await axios.get(
      "https://www.youtube.com/oembed",
      {
        params: {
          url: "https://www.youtube.com/watch?v=" + id,
          format: "json"
        },
        timeout: 15000
      }
    );

    res.json({
      recognized: true,
      downloadable: false,
      title: response.data.title,
      creator: response.data.author_name,
      message: "Video recognized. This endpoint does not provide a YouTube media download."
    });
  } catch (error) {
    res.status(400).json({
      recognized: false,
      message: "Could not recognize this public YouTube video."
    });
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET) {
      return res.status(503).json({
        error: "Cloudinary is not configured."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Choose a media file first."
      });
    }

    if (!/^(audio|video)\//.test(req.file.mimetype)) {
      return res.status(400).json({
        error: "Only audio and video files are accepted."
      });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: "duppyfiles",
          use_filename: true,
          unique_filename: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      stream.end(req.file.buffer);
    });

    res.json({
      success: true,
      message: "Media stored successfully.",
      url: result.secure_url,
      public_id: result.public_id
    });
  } catch (error) {
    res.status(500).json({
      error: "Cloudinary upload failed.",
      details: error.message
    });
  }
});

app.post("/convert", async (req, res) => {
  let folder;

  try {
    const { url, format } = req.body;

    if (!url || !["mp3", "mp4"].includes(format)) {
      return res.status(400).json({
        error: "Provide a media URL and choose MP3 or MP4."
      });
    }

    if (getYouTubeId(url)) {
      return res.status(400).json({
        error: "YouTube links cannot be converted here. Use media you own or have permission to download."
      });
    }

    const mediaUrl = await checkMediaUrl(url);

    const response = await axios.get(mediaUrl.href, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxRedirects: 0,
      maxContentLength: 250 * 1024 * 1024
    });

    const contentType = response.headers["content-type"] || "";

    if (!/^(audio|video)\//i.test(contentType)) {
      return res.status(400).json({
        error: "The link must point directly to an audio or video file."
      });
    }

    folder = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "duppyfiles-")
    );

    const input = path.join(folder, "input");
    const output = path.join(folder, "converted." + format);

    await fs.promises.writeFile(input, response.data);
    await runFfmpeg(input, output, format);

    res.download(output, "duppyfiles-converted." + format);
  } catch (error) {
    if (!res.headersSent) {
      res.status(400).json({
        error: "Conversion failed.",
        details: error.message
      });
    }
  } finally {
    if (folder) {
      setTimeout(() => {
        fs.promises.rm(folder, {
          recursive: true,
          force: true
        }).catch(() => {});
      }, 30000);
    }
  }
});

app.listen(PORT, () => {
  console.log("DUPPYFILES backend running on port " + PORT);
});
