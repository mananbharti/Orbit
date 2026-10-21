import test from 'node:test';
import assert from 'node:assert/strict';
import { GeoTriggerEvaluator, haversineMeters, type PlaceTrigger } from '../src/geo.js';

const HOME = { latitude: 28.6139, longitude: 77.2090 };
const north = (meters: number) => ({ latitude: HOME.latitude + meters / 111_195, longitude: HOME.longitude });
const arrive: PlaceTrigger = { sceneId: 'work', ...HOME, radiusMeters: 150, on: 'arrive' };
const leave: PlaceTrigger = { sceneId: 'away', ...HOME, radiusMeters: 150, on: 'leave' };

test('distance is symmetric, handles the dateline, the poles and antipodes without NaN', () => {
  assert.equal(haversineMeters(10, 20, 30, 40), haversineMeters(30, 40, 10, 20));
  const dateline = haversineMeters(0, 179.9995, 0, -179.9995);
  assert.ok(dateline > 100 && dateline < 120, `dateline ${dateline}`);
  assert.ok(Math.abs(haversineMeters(90, 0, 90, 123) - 0) < 1e-6);
  const antipode = haversineMeters(0, 0, 0, 180);
  assert.ok(Number.isFinite(antipode) && Math.abs(antipode - Math.PI * 6_371_000) < 1, `antipode ${antipode}`);
});

test('a leave trigger fires only once the fix is beyond radius plus the 60 m band', () => {
  const ev = new GeoTriggerEvaluator();
  ev.update([leave], HOME.latitude, HOME.longitude);
  assert.deepEqual(ev.update([leave], north(200).latitude, north(200).longitude), []);
  assert.deepEqual(ev.update([leave], north(215).latitude, north(215).longitude), ['away']);
});

test('an arrive trigger needs a fix strictly inside the radius, and re-arms only after leaving it', () => {
  const ev = new GeoTriggerEvaluator();
  ev.update([arrive], north(500).latitude, north(500).longitude);
  assert.deepEqual(ev.update([arrive], north(160).latitude, north(160).longitude), []);
  assert.deepEqual(ev.update([arrive], north(140).latitude, north(140).longitude), ['work']);
});

test('triggers keep separate state, and reset makes the next fix a learning fix again', () => {
  const ev = new GeoTriggerEvaluator();
  const far = north(800);
  ev.update([arrive, leave], far.latitude, far.longitude);
  assert.deepEqual(ev.update([arrive, leave], HOME.latitude, HOME.longitude), ['work']);
  ev.reset();
  assert.deepEqual(ev.update([arrive, leave], far.latitude, far.longitude), []);
  assert.deepEqual(ev.update([arrive, leave], HOME.latitude, HOME.longitude), ['work']);
});
