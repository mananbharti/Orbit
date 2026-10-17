import test from 'node:test';
import assert from 'node:assert/strict';
import { GeoTriggerEvaluator, haversineMeters, type PlaceTrigger } from '../src/geo.js';

const HOME = { latitude: 28.6139, longitude: 77.2090 }; // Connaught Place
const AWAY = { latitude: 28.6210, longitude: 77.2100 };  // ~800m north
const arrive: PlaceTrigger = { sceneId: 'work', latitude: HOME.latitude, longitude: HOME.longitude, radiusMeters: 150, on: 'arrive' };
const leave: PlaceTrigger = { ...arrive, sceneId: 'away', on: 'leave' };

test('haversineMeters is sane for known distances', () => {
  assert.equal(haversineMeters(HOME.latitude, HOME.longitude, HOME.latitude, HOME.longitude), 0);
  const d = haversineMeters(HOME.latitude, HOME.longitude, AWAY.latitude, AWAY.longitude);
  assert.ok(d > 700 && d < 900, `expected ~800m, got ${d}`);
});

test('arrive fires once on entry and not again while inside', () => {
  const ev = new GeoTriggerEvaluator();
  assert.deepEqual(ev.update([arrive], AWAY.latitude, AWAY.longitude), []); // learn: outside
  assert.deepEqual(ev.update([arrive], HOME.latitude, HOME.longitude), ['work']);
  assert.deepEqual(ev.update([arrive], HOME.latitude, HOME.longitude), []);
});

test('leave fires on exit after being inside', () => {
  const ev = new GeoTriggerEvaluator();
  assert.deepEqual(ev.update([leave], HOME.latitude, HOME.longitude), []); // learn: inside
  assert.deepEqual(ev.update([leave], AWAY.latitude, AWAY.longitude), ['away']);
  assert.deepEqual(ev.update([leave], AWAY.latitude, AWAY.longitude), []);
});

test('first fix never fires, even when inside', () => {
  const ev = new GeoTriggerEvaluator();
  assert.deepEqual(ev.update([arrive], HOME.latitude, HOME.longitude), []);
  assert.deepEqual(ev.update([leave], HOME.latitude, HOME.longitude), []);
});

test('jitter near the edge does not flip state (hysteresis)', () => {
  const ev = new GeoTriggerEvaluator();
  ev.update([arrive], HOME.latitude, HOME.longitude); // inside (learned)
  // ~180m out: outside the 150m radius but inside the 210m exit band -> still inside, no leave-style flip
  const near = { latitude: HOME.latitude + 0.0016, longitude: HOME.longitude };
  assert.deepEqual(ev.update([arrive], near.latitude, near.longitude), []);
  assert.deepEqual(ev.update([arrive], HOME.latitude, HOME.longitude), []); // never left, so no re-entry fire
  assert.deepEqual(ev.update([arrive], AWAY.latitude, AWAY.longitude), []); // real exit (arrive trigger stays quiet)
  assert.deepEqual(ev.update([arrive], HOME.latitude, HOME.longitude), ['work']); // real re-entry fires
});
