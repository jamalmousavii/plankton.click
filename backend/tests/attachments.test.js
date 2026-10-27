const { prepareAttachment, AttachmentError } = require('../src/services/attachments');

const b64 = (buf) => Buffer.from(buf).toString('base64');

// Minimal WAV that passes the RIFF/WAVE magic-byte check.
const minimalWav = () => Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WAVE'),
]);

// Tiny single-page PDF containing the text HELLO WORLD.
const tinyPdf = () => Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 100 Td (HELLO WORLD) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF',
  'latin1'
);

describe('prepareAttachment', () => {
  it('passes messages through untouched when there is no attachment', async () => {
    const out = await prepareAttachment(null, 'hi');
    expect(out).toEqual({ effectiveMessage: 'hi', media: null, dbAttachment: null });
  });

  it('keeps images as media and leaves the prompt alone', async () => {
    const data = b64('imagebytes');
    const out = await prepareAttachment({ type: 'image', name: 'a.jpg', mime: 'image/jpeg', data }, 'look');
    expect(out.effectiveMessage).toBe('look');
    expect(out.media).toEqual({ type: 'image', name: 'a.jpg', mime: 'image/jpeg', data });
    expect(out.dbAttachment.data).toBe(data);
  });

  it('keeps WAV audio as media', async () => {
    const data = b64(minimalWav());
    const out = await prepareAttachment({ type: 'audio', name: 'v.wav', mime: 'audio/webm', data }, 'listen');
    expect(out.media.type).toBe('audio');
    expect(out.media.mime).toBe('audio/wav');
    expect(out.effectiveMessage).toBe('listen');
  });

  it('rejects non-WAV audio (would be misread as an image by Ollama)', async () => {
    const data = b64(Buffer.from('webm-bytes-here'));
    await expect(prepareAttachment({ type: 'audio', name: 'v.webm', mime: 'audio/webm', data }, 'x'))
      .rejects.toMatchObject({ code: 'AUDIO_FORMAT' });
  });

  it('prepends extracted text-file content to the prompt', async () => {
    const data = b64(Buffer.from('SELECT * FROM users;'));
    const out = await prepareAttachment({ type: 'file', name: 'query.sql', mime: 'application/sql', data }, 'explain this');
    expect(out.media).toBeNull();
    expect(out.effectiveMessage).toContain('[File: query.sql]');
    expect(out.effectiveMessage).toContain('SELECT * FROM users;');
    expect(out.effectiveMessage.endsWith('explain this')).toBe(true);
    // History stores only metadata — the text lives in tasks.prompt/prepared_prompt.
    expect(out.dbAttachment).toEqual({ type: 'file', name: 'query.sql', mime: 'application/sql' });
  });

  it('extracts text from a PDF', async () => {
    const out = await prepareAttachment(
      { type: 'file', name: 'doc.pdf', mime: 'application/pdf', data: b64(tinyPdf()) },
      'summarize'
    );
    expect(out.effectiveMessage).toContain('HELLO WORLD');
    expect(out.effectiveMessage).toContain('[File: doc.pdf]');
    expect(out.effectiveMessage).not.toContain('-- 1 of 1 --');
  });

  it('rejects unsupported binary file types', async () => {
    const data = b64(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expect(prepareAttachment({ type: 'file', name: 'app.zip', mime: 'application/zip', data }, 'x'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' });
  });

  it('rejects files larger than the budget', async () => {
    // 1.5MB decoded (base64 is ~2MB of the ~4MB validator budget)
    const data = Buffer.alloc(1.5 * 1024 * 1024 + 1, 0x41).toString('base64');
    await expect(prepareAttachment({ type: 'file', name: 'big.txt', mime: 'text/plain', data }, 'x'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('rejects an empty text file', async () => {
    const data = b64(Buffer.from('   \n  '));
    await expect(prepareAttachment({ type: 'file', name: 'empty.txt', mime: 'text/plain', data }, 'x'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EMPTY' });
  });

  it('rejects binary junk posing as a text file', async () => {
    const data = b64(Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    await expect(prepareAttachment({ type: 'file', name: 'fake.txt', mime: 'text/plain', data }, 'x'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' });
  });

  it('throws typed AttachmentError instances', async () => {
    const data = b64(Buffer.from('x'));
    try {
      await prepareAttachment({ type: 'file', name: 'a.zip', mime: 'application/zip', data }, 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentError);
      expect(err.code).toBe('ATTACHMENT_UNSUPPORTED');
    }
  });
});
