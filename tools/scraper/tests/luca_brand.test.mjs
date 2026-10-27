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
});

test('canonical academic template cannot reintroduce the retired assistant name', async () => {
  const template = await readFile(new URL('../../../template.md', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /\bSophia\b/);
  assert.match(template, /\bLuca\b/);
});
