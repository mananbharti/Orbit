import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The renderer runs under a strict CSP (style-src 'self'): inline style
// attributes and injected <style> tags are silently dropped by the browser.
// These tests keep styling in the stylesheet, where the CSP allows it.

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shell/renderer');
const appJs = readFileSync(path.join(renderer, 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(renderer, 'index.html'), 'utf8');
const stylesCss = readFileSync(path.join(renderer, 'styles.css'), 'utf8');

test('no inline style attributes in renderer markup or generated HTML', () => {
  assert.equal(indexHtml.includes('style="'), false, 'index.html has an inline style attribute the CSP will drop');
  assert.equal(appJs.includes('style="'), false, 'app.js generates HTML with an inline style attribute the CSP will drop');
});

test('no runtime <style> injection (blocked by the CSP)', () => {
  assert.match(appJs, /dataset\.preview/, 'preview mode should flip an attribute the stylesheet keys on');
  assert.equal(/createElement\(['"]style['"]\)/.test(appJs), false);
});

test('every file-type chip color comes from a data-ext rule with a default', () => {
  assert.match(stylesCss, /\.fi \{[^}]*background: #6e6e73/, 'default chip background missing');
  const colored = [...stylesCss.matchAll(/\.fi\[data-ext="([a-z0-9]+)"\]/g)].map(m => m[1]);
  for (const ext of ['mp4', 'mov', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'txt', 'md', 'mp3', 'doc', 'docx']) {
    assert.ok(colored.includes(ext), `no stylesheet color for .${ext} chips`);
  }
  assert.match(appJs, /data-ext="' \+ esc\(ext\.toLowerCase\(\)\)/, 'fileIcon must stamp data-ext for the stylesheet');
});

test('initially-hidden panels use the hidden attribute, backed by a stylesheet reset', () => {
  assert.equal(/style="display:none"/.test(indexHtml), false);
  assert.match(indexHtml, /id="ext-card" hidden/);
  assert.match(stylesCss, /\[hidden\] \{ display: none !important; \}/);
});
