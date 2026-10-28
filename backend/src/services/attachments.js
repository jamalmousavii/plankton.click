// Attachment preparation for chat messages.
//
// The client sends one attachment per message as raw base64 inside the chat
// JSON body: { type: 'image' | 'file' | 'audio', name, mime, data }.
//   image → forwarded to a vision-capable model as Ollama images[] (media)
//   audio → WAV 16kHz mono, also sent via Ollama's images[] slot (auto-detect)
//   file  → parsed here to text (PDF via pdf-parse, plain text raw) and
//           prepended to the prompt so ANY chat model can answer it.
//
// Failures throw AttachmentError(code) so the route can return an explicit
// 4xx with a stable code instead of silently dropping the attachment.

const { PDFParse } = require('pdf-parse');

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;   // client compresses to ~1.5MB JPEG
const AUDIO_MAX_BYTES = 3 * 1024 * 1024;   // 60s WAV 16k mono ≈ 1.9MB
const FILE_MAX_BYTES = 1.5 * 1024 * 1024;  // raw text/PDF budget
const FILE_TEXT_MAX = 100000;              // plain text cap
const PDF_TEXT_MAX = 60000;                // extracted PDF text cap

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/toml', 'application/x-sh'];
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp',
  'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'sql', 'yml', 'yaml', 'xml', 'html',
  'css', 'scss', 'less', 'log', 'ini', 'cfg', 'conf', 'toml', 'gitignore', 'dockerfile',
  'r', 'swift', 'kt', 'kts', 'lua', 'pl', 'ps1', 'bat', 'vue', 'svelte', 'astro',
]);

class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

function extOf(name = '') {
  const clean = String(name).split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  return dot > -1 ? clean.slice(dot + 1).toLowerCase() : clean.toLowerCase();
}

function isPdf(attachment) {
  return attachment.mime === 'application/pdf' || extOf(attachment.name) === 'pdf';
}

function isTextLike(attachment) {
  const mime = String(attachment.mime || '').toLowerCase();
  if (TEXT_MIME_PREFIXES.some(p => mime === p || mime.startsWith(p))) return true;
  return TEXT_EXTENSIONS.has(extOf(attachment.name));
}

function decode(attachment) {
  let buf;
  try {
    buf = Buffer.from(attachment.data, 'base64');
  } catch (e) {
    throw new AttachmentError('ATTACHMENT_INVALID', 'Attachment data is not valid base64');
  }
  if (buf.length === 0) throw new AttachmentError('ATTACHMENT_INVALID', 'Attachment data is empty');
  return buf;
}

async function pdfToText(buf) {
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    // pdf-parse v2 appends a "-- 1 of 1 --" page marker per page; drop it.
    return String(result.text || '').replace(/\n?--\s*\d+\s+of\s+\d+\s*--\n?/g, '\n');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Validate + normalize one attachment for a chat message.
 *
 * @param {object|null} attachment - validated { type, name, mime, data }
 * @param {string} message - original user message (used as-is for image/audio)
 * @returns {Promise<{
 *   effectiveMessage: string,   // prompt to send to the model
 *   media: object|null,         // image/audio payload for Ollama, null for text
 *   dbAttachment: object|null,  // what to persist in tasks.media (history)
 * }>}
 */
async function prepareAttachment(attachment, message) {
  if (!attachment) {
    return { effectiveMessage: message, media: null, dbAttachment: null };
  }

  const name = String(attachment.name || 'attachment').slice(0, 255);
  const mime = String(attachment.mime || '').slice(0, 100);

  if (attachment.type === 'image') {
    const buf = decode(attachment);
    if (buf.length > IMAGE_MAX_BYTES) {
      throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'Image too large (max ~2MB after compression)');
    }
    return {
      effectiveMessage: message,
      media: { type: 'image', name, mime, data: attachment.data },
      dbAttachment: { type: 'image', name, mime, data: attachment.data },
    };
  }

  if (attachment.type === 'audio') {
    const buf = decode(attachment);
    if (buf.length > AUDIO_MAX_BYTES) {
      throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'Voice note too long (max ~60s)');
    }
    // Ollama detects audio by RIFF magic; non-WAV input would be treated as an
    // image and produce garbage, so reject anything that isn't WAV up front.
    const looksWav = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE';
    if (!looksWav) {
      throw new AttachmentError('AUDIO_FORMAT', 'Voice notes must be WAV audio');
    }
    return {
      effectiveMessage: message,
      media: { type: 'audio', name, mime: 'audio/wav', data: attachment.data },
      dbAttachment: { type: 'audio', name, mime: 'audio/wav', data: attachment.data },
    };
  }

  if (attachment.type === 'file') {
    const buf = decode(attachment);
    if (buf.length > FILE_MAX_BYTES) {
      throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'File too large (max ~2MB)');
    }

    let text;
    if (isPdf(attachment)) {
      try {
        text = await pdfToText(buf);
      } catch (e) {
        throw new AttachmentError('ATTACHMENT_PARSE_FAILED', 'Could not read PDF — it may be scanned or password protected');
      }
      text = text.slice(0, PDF_TEXT_MAX);
    } else if (isTextLike(attachment)) {
      text = buf.toString('utf8').slice(0, FILE_TEXT_MAX);
      if (text.includes('�')) {
        throw new AttachmentError('ATTACHMENT_UNSUPPORTED', 'File does not look like UTF-8 text');
      }
    } else {
      throw new AttachmentError('ATTACHMENT_UNSUPPORTED', 'Unsupported file type — use PDF or a text file');
    }

    if (!text.trim()) {
      throw new AttachmentError('ATTACHMENT_EMPTY', 'No text could be extracted from this file');
    }

    return {
      effectiveMessage: `[File: ${name}]\n${text}\n---\n\n${message}`,
      media: null,
      dbAttachment: { type: 'file', name, mime },
      // Raw extracted text + name, so chat can swap the full text for the
      // most relevant excerpts (RAG) when the file is large.
      fileText: text,
      fileName: name,
    };
  }

  throw new AttachmentError('ATTACHMENT_UNSUPPORTED', 'Attachment type must be image, file or audio');
}

module.exports = { prepareAttachment, AttachmentError };
