import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractPdfText, PDF_EXTRACTION_SYSTEM } from '../scrape_drive.mjs';

const buffer = Buffer.from('%PDF-1.7 fake bytes');
const silentLog = { warn() {} };

describe('extractPdfText (PDF multimodal-first)', () => {
  test('sin apiKey usa pdf-parse y NO llama a Gemini', async () => {
    let geminiCalled = false;
    const out = await extractPdfText(buffer, {
      apiKey: null,
      pdfParseImpl: async () => ({ text: 'texto plano del PDF', numpages: 2 }),
      callGeminiImpl: async () => { geminiCalled = true; return { text: 'no debería' }; },
      logImpl: silentLog,
    });
    assert.equal(out, 'texto plano del PDF');
    assert.equal(geminiCalled, false);
  });

  test('con apiKey usa multimodal y le pasa el PDF como inlineData base64', async () => {
    let captured;
    const out = await extractPdfText(buffer, {
      apiKey: 'KEY',
      pdfParseImpl: async () => ({ text: 'solo el encabezado, tabla vacía', numpages: 3 }),
      callGeminiImpl: async (opts) => { captured = opts; return { text: 'Texto completo\n| A | B |\n| 1 | 2 |' }; },
      logImpl: silentLog,
    });
    assert.match(out, /\| 1 \| 2 \|/); // se quedó con el multimodal (tabla completa)
    const part = captured.fileParts[0];
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, buffer.toString('base64'));
    assert.equal(captured.temperature, 0);
  });

  test('si el multimodal falla, cae a pdf-parse', async () => {
    const out = await extractPdfText(buffer, {
      apiKey: 'KEY',
      pdfParseImpl: async () => ({ text: 'respaldo de pdf-parse', numpages: 1 }),
      callGeminiImpl: async () => { throw new Error('429 rate limit'); },
      logImpl: silentLog,
    });
    assert.equal(out, 'respaldo de pdf-parse');
  });

  test('si el multimodal viene más pobre que pdf-parse, preserva pdf-parse', async () => {
    const rich = 'pdf-parse trajo bastante texto real del documento institucional';
    const out = await extractPdfText(buffer, {
      apiKey: 'KEY',
      pdfParseImpl: async () => ({ text: rich, numpages: 1 }),
      callGeminiImpl: async () => ({ text: 'poco' }),
      logImpl: silentLog,
    });
    assert.equal(out, rich);
  });

  test('tolera que pdf-parse rompa (devuelve lo que tenga, sin tirar)', async () => {
    const out = await extractPdfText(buffer, {
      apiKey: 'KEY',
      pdfParseImpl: async () => { throw new Error('pdf corrupto'); },
      callGeminiImpl: async () => ({ text: 'rescatado por multimodal' }),
      logImpl: silentLog,
    });
    assert.equal(out, 'rescatado por multimodal');
  });
});

describe('PDF_EXTRACTION_SYSTEM (guard anti-PII)', () => {
  test('instruye NO transcribir datos personales de ejemplos/capturas', () => {
    assert.match(PDF_EXTRACTION_SYSTEM, /PRIVACIDAD/i);
    assert.match(PDF_EXTRACTION_SYSTEM, /DNI|documento/i);
    assert.match(PDF_EXTRACTION_SYSTEM, /captura|ejemplo/i);
    assert.match(PDF_EXTRACTION_SYSTEM, /reemplaz/i);
  });

  test('preserva datos institucionales (no es un borrado ciego de todo dato)', () => {
    assert.match(PDF_EXTRACTION_SYSTEM, /institucional/i);
    assert.match(PDF_EXTRACTION_SYSTEM, /autoridades|secretar/i);
  });
});
