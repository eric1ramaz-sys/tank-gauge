import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TankEngine = require('../engine.js');
const TankVision = require('../vision.js');

test('1. angleDegToPercent & percentToAngleDeg round-trip across presets and rotation', () => {
  const defFromNull = TankEngine.resolveCalibration(null);
  assert.equal(defFromNull.minPct, 5);
  assert.equal(defFromNull.maxPct, 95);
  assert.equal(TankEngine.resolveCalibration(undefined).presetId, 'rochester_5_95');

  const rochester = TankEngine.CONSTANTS.DIAL_PRESETS.rochester_5_95;
  for (const pct of [5, 18, 25, 50, 72.5, 95]) {
    const deg = TankEngine.percentToAngleDeg(pct, rochester);
    const back = TankEngine.angleDegToPercent(deg, rochester);
    assert.ok(Math.abs(back - pct) <= 0.15, `Expected ${pct}, got ${back}`);
  }

  const cal090 = TankEngine.CONSTANTS.DIAL_PRESETS.rochester_0_90;
  assert.equal(TankEngine.angleDegToPercent(-135, cal090), 0);
  assert.equal(TankEngine.angleDegToPercent(0, cal090), 45);
  assert.equal(TankEngine.angleDegToPercent(135, cal090), 90);

  const rotated = { ...rochester, rotationDeg: 12 };
  const degAt50 = TankEngine.percentToAngleDeg(50, rotated);
  assert.equal(degAt50, 12);
  assert.equal(TankEngine.angleDegToPercent(12, rotated), 50);
  // Dead zone clamps cleanly
  assert.equal(TankEngine.angleDegToPercent(-160, rochester), 5);
  assert.equal(TankEngine.angleDegToPercent(160, rochester), 95);
});

test('2. estimateTankCapacity matches 1000L for 30%->80% as 2000L', () => {
  const est = TankEngine.estimateTankCapacity(1000, 30, 80);
  assert.equal(est.rawLitres, 2000);
  assert.equal(est.nearestStandard, 2000);
  assert.equal(est.deltaPct, 50);

  const estSmall = TankEngine.estimateTankCapacity(600, 20, 70);
  assert.equal(estSmall.nearestStandard, 1200);
});

test('3. normalizeBill handles VAT inclusion vs addition without double-counting', () => {
  const incVat = TankEngine.normalizeBill({
    date: '2026-10-01',
    litres: 1000,
    totalPaid: 650,
    vatIncluded: true,
    standingChargePencePerDay: 21,
  });
  assert.equal(incVat.effectivePricePerLitreIncVat, 65);
  assert.equal(incVat.totalPaidIncVat, 650);
  assert.equal(incVat.standingChargePerDayIncVat, 0.21);

  const exVat = TankEngine.normalizeBill({
    date: '2026-10-01',
    litres: 1000,
    unitPricePence: 60,
    vatIncluded: false,
    standingChargePencePerDay: 20,
  });
  assert.equal(exVat.effectivePricePerLitreIncVat, 63); // 60 * 1.05
  assert.equal(exVat.totalPaidIncVat, 630);
  assert.equal(exVat.standingChargePerDayIncVat, 0.21);
});

test('4. computeAnalytics bulk tank burn rate, refill auto-detect, thermal expansion clamp, short-interval guard, and watchdog', () => {
  const state = {
    settings: {
      mode: 'bulk',
      tankCapacityLitres: 2000,
      reorderAlertPct: 25,
    },
    bills: [
      { id: 'b1', date: '2026-10-01', litres: 1000, unitPricePence: 60, vatIncluded: true, standingChargePencePerDay: 20 },
      { id: 'b2', date: '2026-10-12', litres: 1200, unitPricePence: 64.5, vatIncluded: true, standingChargePencePerDay: 20 },
    ],
    readings: [
      { id: 'r1', date: '2026-10-01', timestamp: '2026-10-01T12:00:00Z', pct: 35.0 },
      // +1.5% sunny thermal expansion -> must NOT trigger refill and must clamp usage to 0
      { id: 'r2', date: '2026-10-06', timestamp: '2026-10-06T12:00:00Z', pct: 36.5 },
      // Drops 12.5% over 5 days = 250 L = 50 L/day
      { id: 'r3', date: '2026-10-11', timestamp: '2026-10-11T12:00:00Z', pct: 24.0 },
      // +60% refill jump -> auto-detected as refill & skipped from burn rate
      { id: 'r4', date: '2026-10-12', timestamp: '2026-10-12T12:00:00Z', pct: 84.0 },
      // Ultra-short 10-minute test snap dropping 1% -> guarded from exploding daily rate
      { id: 'r5', date: '2026-10-12', timestamp: '2026-10-12T12:10:00Z', pct: 83.0 },
      // Drops 20% over 10 days = 400 L = 40 L/day
      { id: 'r6', date: '2026-10-22', timestamp: '2026-10-22T12:00:00Z', pct: 63.0 },
    ],
  };

  assert.equal(TankEngine.detectAutoRefill(state.readings[0], state.readings[1], 'bulk'), false);
  assert.equal(TankEngine.detectAutoRefill(state.readings[2], state.readings[3], 'bulk'), true);

  const res = TankEngine.computeAnalytics(state, {});
  assert.equal(res.summary.currentPct, 63);
  assert.equal(res.summary.litresRemaining, 1260);
  // Total burn: 0 + 250 + 400 = 650 L over 20 valid days (r1->r3 10d, r4->r6 10d) = 32.5 L/day
  assert.equal(res.summary.totalLitresUsed, 650);
  assert.equal(res.summary.latestPplIncVat, 64.5);
  assert.equal(res.summary.pplDeltaPence, 4.5);
  assert.equal(res.summary.pplBand, 'typical');
  assert.ok(res.summary.recentLitresPerDay >= 30 && res.summary.recentLitresPerDay <= 45);
  assert.ok(res.summary.daysToReorder > 0);
  // Short interval flagged
  assert.equal(res.intervals[3].isTooShort, true);
});

test('5. computeAnalytics piped meter mode (m3 and ft3)', () => {
  const m3State = {
    settings: { mode: 'meter', meterUnit: 'm3' },
    bills: [{ id: 'mb1', date: '2026-10-01', unitType: 'm3', units: 100, totalPaid: 230, vatIncluded: true }],
    readings: [
      { id: 'mr1', date: '2026-10-01', timestamp: '2026-10-01T12:00:00Z', meterValue: 100 },
      { id: 'mr2', date: '2026-10-11', timestamp: '2026-10-11T12:00:00Z', meterValue: 110 },
    ],
  };
  const m3Res = TankEngine.computeAnalytics(m3State, {});
  // 10 m3 * 3.64 = 36.4 litres eq -> 3.64 L/day
  assert.equal(m3Res.summary.totalLitresUsed, 36.4);
  assert.equal(m3Res.summary.recentLitresPerDay, 3.64);

  const ft3State = {
    settings: { mode: 'meter', meterUnit: 'ft3' },
    bills: [],
    readings: [
      { id: 'fr1', date: '2026-10-01', timestamp: '2026-10-01T12:00:00Z', meterValue: 1000 },
      { id: 'fr2', date: '2026-10-11', timestamp: '2026-10-11T12:00:00Z', meterValue: 2000 },
    ],
  };
  const ft3Res = TankEngine.computeAnalytics(ft3State, {});
  // 1000 ft3 * 0.0283168 * 3.64 = ~103.07 L
  assert.ok(Math.abs(ft3Res.summary.totalLitresUsed - 103.1) <= 0.2);
});

test('6. computeHeatingAdvice tailors Park Home Scotland vs Stone Cottage Old Boiler & Done split', () => {
  const demo = TankEngine.generateDemoDataset();
  const demoAnalytics = TankEngine.computeAnalytics(demo, demo.demoWeather);
  const parkAdvice = TankEngine.computeHeatingAdvice(
    demo.profile,
    demoAnalytics.summary,
    demo.completedActions
  );
  assert.equal(parkAdvice.isEstimated, false);
  assert.ok(parkAdvice.implementedAnnual > 0);
  assert.ok(parkAdvice.remainingAnnual > 0);
  assert.equal(
    parkAdvice.totalPotentialAnnual,
    parkAdvice.implementedAnnual + parkAdvice.remainingAnnual
  );
  assert.ok(
    parkAdvice.grantLinks.some((g) => g.label.includes('Home Energy Scotland')),
    'Expected Scotland grant link'
  );
  assert.ok(
    parkAdvice.tiers.lowCost.some((t) => t.id === 'park_home_draught_curtains'),
    'Expected park-home specific advice'
  );

  const cottageAdvice = TankEngine.computeHeatingAdvice(
    {
      homeType: 'stone_cottage',
      heaterType: 'old_boiler',
      controls: 'basic_on_off',
      flowTemp: 'high_70plus',
      insulation: 'poor',
      region: 'england_wales',
    },
    { hasSevenDays: false, latestPplIncVat: 71 },
    {}
  );
  assert.equal(cottageAdvice.isEstimated, true);
  assert.equal(cottageAdvice.baseAnnualSpend, 1450);
  assert.ok(cottageAdvice.tiers.quickWins.some((t) => t.id === 'negotiate_lpg_rate'));
  assert.ok(cottageAdvice.tiers.lowCost.some((t) => t.id === 'stone_chimney_draught'));
  assert.ok(cottageAdvice.grantLinks.some((g) => g.label.includes('Boiler Upgrade Scheme')));
});

test('7. detectDialNeedleFromRGBA hits within +-2.0% across 5 synthetic Calor dials', () => {
  const cal = TankEngine.CONSTANTS.DIAL_PRESETS.rochester_5_95;
  const w = 360;
  const h = 360;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.44;

  for (const targetPct of [18, 35, 50, 68, 84]) {
    const rgba = TankVision.renderSyntheticDialToRGBA(w, h, targetPct, cal);
    const result = TankVision.detectDialNeedleFromRGBA(rgba, w, h, cx, cy, radius, cal);
    const err = Math.abs(result.percent - targetPct);
    assert.ok(
      err <= 2.0,
      `Dial ${targetPct}% detected as ${result.percent}% (err=${err.toFixed(2)}%, conf=${result.confidence})`
    );
  }
});


test('8. detectDialNeedleFromRGBA stays within +-2.0% on low-contrast shaded Calor dials', () => {
  const cal = TankEngine.CONSTANTS.DIAL_PRESETS.rochester_5_95;
  const w = 360;
  const h = 360;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.44;

  for (const targetPct of [18, 48, 76]) {
    const rgba = TankVision.renderSyntheticDialToRGBA(w, h, targetPct, cal, { shaded: true });
    const result = TankVision.detectDialNeedleFromRGBA(rgba, w, h, cx, cy, radius, cal);
    const err = Math.abs(result.percent - targetPct);
    assert.ok(
      err <= 2.0,
      `Shaded dial ${targetPct}% detected as ${result.percent}% (err=${err.toFixed(2)}%, conf=${result.confidence})`
    );
  }
});
