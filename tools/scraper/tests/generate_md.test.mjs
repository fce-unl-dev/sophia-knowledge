import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYSTEM_INSTRUCTION,
  buildUserPrompt,
  callGemini,
  stripMarkdownFence,
  generateForSource,
} from '../generate_md.mjs';

describe('SYSTEM_INSTRUCTION', () => {
  test('contiene las 9 reglas duras', () => {
    for (let i = 1; i <= 9; i++) {
      assert.match(SYSTEM_INSTRUCTION, new RegExp(`R${i}\\.`));
    }
  });
  test('prohíbe formalismos vacíos específicos', () => {
    assert.match(SYSTEM_INSTRUCTION, /Muchas gracias por tu interés/);
    assert.match(SYSTEM_INSTRUCTION, /Quedamos a disposición/);
  });
  test('instruye ignorar noticias y eventos de coyuntura', () => {
    assert.match(SYSTEM_INSTRUCTION, /noticias y eventos de coyuntura/i);
  });
  test('exige formato sin fence markdown', () => {
    assert.match(SYSTEM_INSTRUCTION, /SIN bloques de código markdown/);
  });
});

describe('buildUserPrompt', () => {
  const base = {
    template: 'TEMPLATE-CANONICO',
    currentMd: 'MD-ACTUAL',
    rawText: 'RAW-SCRAPE',
    sourceUrl: 'https://fce.unl.edu.ar/mba/',
    today: '2026-05-18',
  };

  test('incluye los 4 bloques en orden: template, MD actual, scrape, tarea', () => {
    const p = buildUserPrompt(base);
    const iTemplate = p.indexOf('PLANTILLA CANÓNICA');
    const iCurrent = p.indexOf('MD ACTUAL');
    const iScrape = p.indexOf('SCRAPE WEB');
    const iTarea = p.indexOf('TAREA');
    assert.ok(iTemplate < iCurrent, 'template antes que MD actual');
    assert.ok(iCurrent < iScrape, 'MD actual antes que scrape');
    assert.ok(iScrape < iTarea, 'scrape antes que tarea');
  });

  test('incluye los inputs textuales', () => {
    const p = buildUserPrompt(base);
    assert.ok(p.includes('TEMPLATE-CANONICO'));
    assert.ok(p.includes('MD-ACTUAL'));
    assert.ok(p.includes('RAW-SCRAPE'));
    assert.ok(p.includes('https://fce.unl.edu.ar/mba/'));
    assert.ok(p.includes('2026-05-18'));
  });

  test('si no hay MD actual, indica explícitamente generar desde cero', () => {
    const p = buildUserPrompt({ ...base, currentMd: '' });
    assert.match(p, /no existe MD previo/);
  });

  test('agrega título si está', () => {
    const p = buildUserPrompt({ ...base, sourceTitle: 'Maestría MBA' });
    assert.ok(p.includes('Título del programa: Maestría MBA'));
  });
});

describe('stripMarkdownFence', () => {
  test('quita fence ```markdown', () => {
    const t = '```markdown\n# Hola\ncontenido\n```';
    assert.equal(stripMarkdownFence(t), '# Hola\ncontenido');
  });
  test('quita fence ``` simple', () => {
    const t = '```\n# Hola\n```';
    assert.equal(stripMarkdownFence(t), '# Hola');
  });
  test('si no hay fence, devuelve tal cual (trim)', () => {
    assert.equal(stripMarkdownFence('  # Hola\n  '), '# Hola');
  });
  test('no quita fences que están dentro del contenido', () => {
    const t = '# Título\n\n```python\nprint(1)\n```\n\nfinal';
    // No es un fence envolvente — empieza con # no con ```
    assert.equal(stripMarkdownFence(t), t.trim());
  });
});

describe('callGemini', () => {
  function makeFetchOk(text, usage = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }) {
    return async (url, init) => ({
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: usage,
        };
      },
      async text() { return '{}'; },
    });
  }

  test('arma body con system + user + config y devuelve texto + raw', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return makeFetchOk('Texto generado')(url, init);
    };
    const r = await callGemini({ apiKey: 'KEY', systemInstruction: 'SYS', userPrompt: 'USR', fetchImpl });
    assert.equal(r.text, 'Texto generado');
    assert.ok(captured.url.includes('gemini-2.5-flash:generateContent'));
    assert.ok(captured.url.includes('key=KEY'));
    const body = JSON.parse(captured.init.body);
    assert.equal(body.systemInstruction.parts[0].text, 'SYS');
    assert.equal(body.contents[0].parts[0].text, 'USR');
    assert.equal(body.generationConfig.temperature, 0.2);
    assert.equal(r.raw.usageMetadata.totalTokenCount, 150);
  });

  test('respeta model override', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = url;
      return makeFetchOk('x')(url, init);
    };
    await callGemini({ apiKey: 'k', systemInstruction: 's', userPrompt: 'u', model: 'gemini-2.5-pro', fetchImpl });
    assert.ok(captured.includes('gemini-2.5-pro:generateContent'));
  });

  test('tira si falta apiKey', async () => {
    await assert.rejects(
      () => callGemini({ apiKey: '', systemInstruction: 's', userPrompt: 'u', fetchImpl: async () => {} }),
      /missing apiKey/,
    );
  });

  test('tira con status no OK', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, async text() { return 'rate limit'; } });
    await assert.rejects(
      () => callGemini({ apiKey: 'k', systemInstruction: 's', userPrompt: 'u', fetchImpl }),
      /Gemini HTTP 429/,
    );
  });

  test('tira si no hay texto en la respuesta', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      async json() { return { candidates: [] }; },
      async text() { return '{}'; },
    });
    await assert.rejects(
      () => callGemini({ apiKey: 'k', systemInstruction: 's', userPrompt: 'u', fetchImpl }),
      /sin texto/,
    );
  });
});

describe('generateForSource', () => {
  async function buildEnv() {
    const tmp = await mkdtemp(join(tmpdir(), 'sophia-gen-'));
    const kbRoot = join(tmp, 'kb');
    const stateDir = join(tmp, 'state');
    await mkdir(kbRoot, { recursive: true });
    await mkdir(join(kbRoot, 'posgrados'), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(kbRoot, 'template.md'), '# TEMPLATE', 'utf8');
    return { tmp, kbRoot, stateDir };
  }

  test('genera candidate.md + meta.json cuando hay raw.txt', async () => {
    const { tmp, kbRoot, stateDir } = await buildEnv();
    try {
      await writeFile(join(stateDir, 'mba.raw.txt'), '--- INICIO: X :: u ---\ncontenido', 'utf8');
      await writeFile(join(kbRoot, 'posgrados/mba.md'), '# MBA actual', 'utf8');

      const fetchImpl = async () => ({
        ok: true, status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '# Maestría en Administración de Empresas\n\nContenido generado' }] } }],
            usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 800, totalTokenCount: 2800 },
          };
        },
        async text() { return '{}'; },
      });

      const r = await generateForSource(
        { slug: 'mba', indice_path: 'posgrados/mba.md', url: 'https://fce.unl.edu.ar/mba/', strategy: 'fce-microsite' },
        { sourcesData: { sources: [] }, stateDir, kbRoot, apiKey: 'KEY', fetchImpl, today: '2026-05-18' },
      );
      assert.equal(r.status, 'generated');
      assert.equal(r.prompt_tokens, 2000);
      assert.equal(r.output_tokens, 800);

      const candidate = await readFile(join(stateDir, 'mba.candidate.md'), 'utf8');
      assert.ok(candidate.startsWith('# Maestría'));

      const meta = JSON.parse(await readFile(join(stateDir, 'mba.gen.meta.json'), 'utf8'));
      assert.equal(meta.slug, 'mba');
      assert.equal(meta.total_tokens, 2800);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('devuelve status=no-raw si no existe el raw.txt', async () => {
    const { tmp, kbRoot, stateDir } = await buildEnv();
    try {
      const r = await generateForSource(
        { slug: 'mba', indice_path: 'posgrados/mba.md', url: 'https://x/', strategy: 'fce-microsite' },
        { sourcesData: { sources: [] }, stateDir, kbRoot, apiKey: 'KEY', fetchImpl: async () => { throw new Error('no'); }, today: '2026-05-18' },
      );
      assert.equal(r.status, 'no-raw');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('quita fence markdown del output', async () => {
    const { tmp, kbRoot, stateDir } = await buildEnv();
    try {
      await writeFile(join(stateDir, 'x.raw.txt'), 'raw', 'utf8');
      const fetchImpl = async () => ({
        ok: true, status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '```markdown\n# Limpio\nfinal\n```' }] } }],
            usageMetadata: {},
          };
        },
        async text() { return '{}'; },
      });
      const r = await generateForSource(
        { slug: 'x', indice_path: 'posgrados/x.md', url: 'https://x/', strategy: 'fce-microsite' },
        { sourcesData: { sources: [] }, stateDir, kbRoot, apiKey: 'KEY', fetchImpl, today: '2026-05-18' },
      );
      assert.equal(r.status, 'generated');
      const candidate = await readFile(join(stateDir, 'x.candidate.md'), 'utf8');
      assert.equal(candidate.trim(), '# Limpio\nfinal');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
