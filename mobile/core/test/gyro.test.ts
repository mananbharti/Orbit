import assert from 'node:assert/strict';
import test from 'node:test';
import { GYRO_DEAD_ZONE, GYRO_SCALE, gyroAxis, gyroDeltas } from '../src/gyro.js';

test('tremor inside the dead zone produces no cursor motion', () => {
  assert.equal(gyroAxis(GYRO_DEAD_ZONE / 2), 0);
  assert.equal(gyroAxis(-GYRO_DEAD_ZONE / 2), 0);
  assert.equal(gyroDeltas({ x: 0.01, y: -0.01 }), null);
});

test('past the dead zone the zone is subtracted so motion starts at zero, not with a jump', () => {
  // Just past the zone: a tiny positive delta, not DEAD_ZONE * SCALE.
  const just = gyroAxis(GYRO_DEAD_ZONE + 0.001);
  assert.ok(just > 0 && just < 1, `expected a small first delta, got ${just}`);
  assert.equal(gyroAxis(GYRO_DEAD_ZONE * 2), GYRO_DEAD_ZONE * GYRO_SCALE);
});

test('axis signs map to cursor direction and both axes combine', () => {
  assert.ok(gyroAxis(-1) < 0);
  const d = gyroDeltas({ x: 1, y: -1 });
  assert.ok(d && d.dx < 0 && d.dy > 0); // roll left -> cursor left, pitch forward -> cursor down
  assert.equal(d.dx, -gyroAxis(1));
});

test('a custom dead zone and scale are honored', () => {
  assert.equal(gyroAxis(0.2, 0.1, 100), 10);
  assert.equal(gyroDeltas({ x: 0.05, y: 0.05 }, 0.1), null);
});

test('a glitchy sensor reading (NaN or infinite) never becomes cursor motion', () => {
  assert.equal(gyroAxis(Number.NaN), 0);
  assert.equal(gyroAxis(Number.POSITIVE_INFINITY), 0);
  assert.equal(gyroAxis(Number.NEGATIVE_INFINITY), 0);
  assert.deepEqual(gyroDeltas({ x: Number.NaN, y: 1 }), { dx: gyroAxis(1), dy: 0 });
  assert.equal(gyroDeltas({ x: Number.NaN, y: Number.NaN }), null);
});
