import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SYSTEM_INSTRUCTION } from '../generate_md.mjs';
import { CLASSIFICATION_SYSTEM_INSTRUCTION } from '../classify_diff.mjs';

test('academic generators and reviewer use Luca identity without changing repository contracts', async () => {
  for (const prompt of [SYSTEM_INSTRUCTION, CLASSIFICATION_SYSTEM_INSTRUCTION]) {
    assert.match(prompt, /Knowledge Base de Luca/);
    assert.doesNotMatch(prompt, /\bSophia\b/);
  }
  const drive = await readFile(new URL('../scrape_drive.mjs', import.meta.url), 'utf8');
  assert.match(drive, /Knowledge Base de Luca/);
  assert.doesNotMatch(drive, /\bSophia\b/);
});

test('deterministic templates emit warnings for Luca, not the retired public name', async () => {
  for (const name of ['section_candidates', 'scrape_students']) {
    const source = await readFile(new URL(`../${name}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /Advertencias para Luca/);
    assert.doesNotMatch(source, /Advertencias para Sophia/);
  }
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# Luca/);
  assert.match(readme, /sophia-knowledge/);
});

test('published operational guidance uses the current assistant name', async () => {
  const root = new URL('../../../', import.meta.url);
  const index = JSON.parse(await readFile(new URL('indice.json', root), 'utf8'));
  for (const item of index.items) {
    const markdown = await readFile(new URL(item.path, root), 'utf8');
    // Historical review attribution is evidence, not the assistant's identity.
    const guidance = markdown.split('\n').filter(line => !line.startsWith('**Revisado por**:')).join('\n');
    assert.doesNotMatch(guidance, /Advertencias para Sophia|Sophia debe|Sophia no debería|respuesta de Sophia|consultas específicas de Sophia/i, item.path);
  }
});

test('canonical academic template cannot reintroduce the retired assistant name', async () => {
  const template = await readFile(new URL('../../../template.md', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /\bSophia\b/);
  assert.match(template, /\bLuca\b/);
});
