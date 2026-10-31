import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractPdfText, PAGE_RETRY_TEMPERATURES, PDF_CHUNK_MAX_OUTPUT_TOKENS, PDF_CHUNK_PAGES, PDF_EXTRACTION_SYSTEM, TranscriptionLoopError } from '../scrape_drive.mjs';

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
    // Plazo largo y sin razonamiento: con los defaults abortaban los PDF largos (30/10/2026).
    assert.equal(captured.timeoutMs, 300_000);
    assert.equal(captured.thinkingBudget, 0);
    // Tope por tramo: un bucle se corta rápido (LA 484, 31/10/2026).
    assert.equal(captured.maxOutputTokens, PDF_CHUNK_MAX_OUTPUT_TOKENS);
    assert.match(captured.userPrompt, /contenido completo/);
  });

  describe('lectura por tramos de páginas', () => {
    // Doble que contesta según el rango pedido y simula bucles en los rangos indicados.
    function pagedGemini(loopRanges = []) {
      const prompts = [];
      const impl = async ({ userPrompt }) => {
        prompts.push(userPrompt);
        const single = /SOLO la página (\d+)/.exec(userPrompt);
        const range = /SOLO las páginas (\d+) a (\d+)/.exec(userPrompt);
        const key = single ? `${single[1]}-${single[1]}` : range ? `${range[1]}-${range[2]}` : '1-todo';
        if (loopRanges.includes(key)) return { text: '|---'.repeat(50), raw: { candidates: [{ finishReason: 'MAX_TOKENS' }] } };
        return { text: `[páginas ${key}]`, raw: { candidates: [{ finishReason: 'STOP' }] } };
      };
      return { impl, prompts };
    }

    test('parte un PDF largo en tramos de cuatro páginas, en orden', async () => {
      const { impl, prompts } = pagedGemini();
      const out = await extractPdfText(buffer, {
        apiKey: 'KEY', pdfParseImpl: async () => ({ text: 'x', numpages: 10 }), callGeminiImpl: impl, logImpl: silentLog,
      });
      assert.equal(PDF_CHUNK_PAGES, 4);
      assert.equal(out, '[páginas 1-4]\n\n[páginas 5-8]\n\n[páginas 9-10]');
      assert.match(prompts[0], /Este PDF tiene 10 páginas\. Transcribí SOLO las páginas 1 a 4 \(inclusive\)/);
    });

    test('un tramo en bucle se parte en dos y solo se repite ese tramo', async () => {
      const warnings = [];
      const { impl, prompts } = pagedGemini(['5-8']);
      const out = await extractPdfText(buffer, {
        apiKey: 'KEY', pdfParseImpl: async () => ({ text: 'x', numpages: 8 }), callGeminiImpl: impl,
        logImpl: { warn: (message) => warnings.push(message) },
      });
      assert.equal(out, '[páginas 1-4]\n\n[páginas 5-6]\n\n[páginas 7-8]');
      assert.equal(prompts.length, 4);
      assert.match(warnings[0], /páginas 5-8 terminaron con MAX_TOKENS/);
    });

    test('una página sola en bucle va a la cuarentena, no a pdf-parse', async () => {
      // 3 páginas entran en un solo tramo: si ese tramo entra en bucle se
      // parte en 1-2 y 3, y la página 3 sola vuelve a entrar en bucle.
      const { impl } = pagedGemini(['1-todo', '3-3']);
      await assert.rejects(
        () => extractPdfText(buffer, {
          apiKey: 'KEY', pdfParseImpl: async () => ({ text: 'x', numpages: 3 }), callGeminiImpl: impl, logImpl: silentLog,
        }),
        (error) => error instanceof TranscriptionLoopError && /la página 3 entró en un bucle.*límite de tokens de salida/.test(error.message),
      );
    });

    test('una página sola en bucle se reintenta con más temperatura antes de rendirse', async () => {
      // Caso de CP 482 (31/10/2026): la página 3 entraba en bucle a temperatura 0.
      const calls = [];
      const warnings = [];
      const impl = async ({ userPrompt, temperature }) => {
        const page = /SOLO la página (\d+)/.exec(userPrompt)?.[1];
        calls.push([page ?? 'tramo', temperature]);
        if (!page) return { text: '|---'.repeat(50), raw: { candidates: [{ finishReason: 'MAX_TOKENS' }] } };
        if (page === '2' && temperature === 0) return { text: '|---'.repeat(50), raw: { candidates: [{ finishReason: 'MAX_TOKENS' }] } };
        return { text: `[página ${page}]`, raw: { candidates: [{ finishReason: 'STOP' }] } };
      };
      const out = await extractPdfText(buffer, {
        apiKey: 'KEY', pdfParseImpl: async () => ({ text: 'x', numpages: 2 }), callGeminiImpl: impl,
        logImpl: { warn: (message) => warnings.push(message) },
      });
      assert.equal(out, '[página 1]\n\n[página 2]');
      assert.deepEqual(calls, [['tramo', 0], ['1', 0], ['2', 0], ['2', PAGE_RETRY_TEMPERATURES[0]]]);
      assert.match(warnings.at(-1), /página 2 terminó con MAX_TOKENS \(temperatura 0\): se reintenta con temperatura 0\.5/);
    });

    test('se agotan los reintentos de temperatura y recién ahí va a la cuarentena', async () => {
      const temperatures = [];
      const impl = async ({ temperature }) => {
        temperatures.push(temperature);
        return { text: '|---'.repeat(50), raw: { candidates: [{ finishReason: 'MAX_TOKENS' }] } };
      };
      await assert.rejects(
        () => extractPdfText(buffer, { apiKey: 'KEY', pdfParseImpl: async () => ({ text: 'x', numpages: 1 }), callGeminiImpl: impl, logImpl: silentLog }),
        TranscriptionLoopError,
      );
      assert.deepEqual(temperatures, [0, ...PAGE_RETRY_TEMPERATURES]);
    });

    test('sin cantidad de páginas, un bucle en la lectura completa va a la cuarentena', async () => {
      const { impl } = pagedGemini(['1-todo']);
      await assert.rejects(
        () => extractPdfText(buffer, { apiKey: 'KEY', pdfParseImpl: async () => { throw new Error('pdf roto'); }, callGeminiImpl: impl, logImpl: silentLog }),
        TranscriptionLoopError,
      );
    });
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
