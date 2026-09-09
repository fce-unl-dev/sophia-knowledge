import test from 'node:test';
import assert from 'node:assert/strict';
import { processPage } from '../scrape.mjs';
import { SYSTEM_INSTRUCTION } from '../generate_md.mjs';
test('microsite preserves brochure URL using document base', () => {
 const page = processPage({url:'https://www.fce.unl.edu.ar/diplotributos/index.php', html:'<base href="https://www.fce.unl.edu.ar/sitios/"><h1>Tributos</h1><p><a href="uploads/folletos/14.pdf">Folleto informativo</a></p>'});
 assert.ok(page.text.includes('https://www.fce.unl.edu.ar/sitios/uploads/folletos/14.pdf'));
});
test('generator does not equate missing extracted evidence with nonpublication', () => {
 assert.ok(!SYSTEM_INSTRUCTION.includes('No publicado'));
});
test('commented development base must not override the live document base', () => {
 const page = processPage({url:'https://www.fce.unl.edu.ar/diplotributos/index.php', html:'<!-- <base href="http://localhost/fcewebsitemaker/sitios/"> --><base href="https://www.fce.unl.edu.ar/sitios/"><p><a href="uploads/folletos/14.pdf">Folleto</a></p>'});
 assert.ok(page.text.includes('https://www.fce.unl.edu.ar/sitios/uploads/folletos/14.pdf'));
 assert.ok(!page.text.includes('localhost'));
});
