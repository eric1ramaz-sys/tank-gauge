/**
 * TankGauge Core Engine (Pure Logic)
 * Built for Calor Gas bulk tanks & UK LPG meters.
 * Works identically in browsers (window.TankEngine) and Node.js tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TankEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONSTANTS = Object.freeze({
    KWH_PER_LITRE_LPG: 7.08,
    KWH_PER_M3_LPG: 25.8,
    M3_PER_FT3: 0.0283168,
    LITRES_PER_M3_VAPOUR: 3.64,
    UK_VAT_RATE: 0.05,
    HDD_BASE_C: 15.5,
    DEFAULT_PPL_INC_VAT: 62.0,
    DEFAULT_STANDING_DAY_GBP: 0.22,
    STANDARD_TANKS: Object.freeze([1200, 1410, 2000, 2200, 2400, 4000]),
    REFILL_DETECTION_JUMP_PCT: 2.5,
    MIN_BURN_INTERVAL_DAYS: 0.08,
    FALLBACK_ANNUAL_SPEND_GBP: 1450,
    DAY_MS: 86400000,
    DIAL_PRESETS: Object.freeze({
      rochester_5_95: Object.freeze({
        id: 'rochester_5_95',
        label: 'Calor Rochester (5%–95%)',
        minPct: 5,
        maxPct: 95,
        startDeg: -140,
        endDeg: 140,
        rotationDeg: 0,
      }),
      rochester_0_90: Object.freeze({
        id: 'rochester_0_90',
        label: 'Rochester Standard (0%–90%)',
        minPct: 0,
        maxPct: 90,
        startDeg: -135,
        endDeg: 135,
        rotationDeg: 0,
      }),
      srg_10_90: Object.freeze({
        id: 'srg_10_90',
        label: 'SRG / Magnetel (10%–90%)',
        minPct: 10,
        maxPct: 90,
        startDeg: -135,
        endDeg: 135,
        rotationDeg: 0,
      }),
    }),
  });

  function roundTo(val, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round((Number(val) + Number.EPSILON) * factor) / factor;
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  /** Normalize angle in degrees to (-180, 180], where 0 is 12 o'clock and positive is clockwise. */
  function normalizeAngle180(deg) {
    let a = ((Number(deg) % 360) + 360) % 360;
    if (a > 180) a -= 360;
    return a;
  }

  function resolveCalibration(calibration) {
    const c = calibration && typeof calibration === 'object' ? calibration : {};
    const preset =
      (c.presetId && CONSTANTS.DIAL_PRESETS[c.presetId]) ||
      CONSTANTS.DIAL_PRESETS.rochester_5_95;
    const hasNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
    return {
      presetId: c.presetId || preset.id,
      minPct: hasNum(c.minPct) ? Number(c.minPct) : preset.minPct,
      maxPct: hasNum(c.maxPct) ? Number(c.maxPct) : preset.maxPct,
      startDeg: hasNum(c.startDeg) ? Number(c.startDeg) : preset.startDeg,
      endDeg: hasNum(c.endDeg) ? Number(c.endDeg) : preset.endDeg,
      rotationDeg: hasNum(c.rotationDeg) ? Number(c.rotationDeg) : preset.rotationDeg,
    };
  }

  function angleDegToPercent(angleDeg, calibration) {
    const cal = resolveCalibration(calibration);
    const rel = normalizeAngle180(Number(angleDeg) - cal.rotationDeg);
    if (rel <= cal.startDeg) return cal.minPct;
    if (rel >= cal.endDeg) return cal.maxPct;
    const spanDeg = cal.endDeg - cal.startDeg;
    if (spanDeg <= 0) return cal.minPct;
    const ratio = (rel - cal.startDeg) / spanDeg;
    const pct = cal.minPct + ratio * (cal.maxPct - cal.minPct);
    return roundTo(clamp(pct, cal.minPct, cal.maxPct), 1);
  }

  function percentToAngleDeg(pct, calibration) {
    const cal = resolveCalibration(calibration);
    const clampedPct = clamp(Number(pct), cal.minPct, cal.maxPct);
    const spanPct = cal.maxPct - cal.minPct;
    const ratio = spanPct > 0 ? (clampedPct - cal.minPct) / spanPct : 0;
    const rel = cal.startDeg + ratio * (cal.endDeg - cal.startDeg);
    return roundTo(normalizeAngle180(rel + cal.rotationDeg), 2);
  }

  function estimateTankCapacity(litresDelivered, pctBefore, pctAfter) {
    const litres = Number(litresDelivered);
    const before = Number(pctBefore);
    const after = Number(pctAfter);
    const deltaPct = after - before;
    if (!Number.isFinite(litres) || litres <= 0 || !Number.isFinite(deltaPct) || deltaPct <= 0) {
      return null;
    }
    const rawLitres = litres / (deltaPct / 100);
    let nearestStandard = CONSTANTS.STANDARD_TANKS[0];
    let smallestDiff = Math.abs(rawLitres - nearestStandard);
    for (let i = 1; i < CONSTANTS.STANDARD_TANKS.length; i++) {
      const candidate = CONSTANTS.STANDARD_TANKS[i];
      const diff = Math.abs(rawLitres - candidate);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        nearestStandard = candidate;
      }
    }
    return {
      rawLitres: Math.round(rawLitres),
      nearestStandard,
      deltaPct: roundTo(deltaPct, 1),
    };
  }

  function convertToLitresEquivalent(value, unitType) {
    const num = Number(value) || 0;
    if (unitType === 'm3') return num * CONSTANTS.LITRES_PER_M3_VAPOUR;
    if (unitType === 'ft3') return num * CONSTANTS.M3_PER_FT3 * CONSTANTS.LITRES_PER_M3_VAPOUR;
    return num;
  }

  function normalizeBill(bill) {
    const b = bill || {};
    const vatIncluded = b.vatIncluded !== false;
    const vatMultiplier = vatIncluded ? 1 : 1 + CONSTANTS.UK_VAT_RATE;
    const unitType = b.unitType || 'litres';
    const rawUnits = Number(b.litres !== undefined ? b.litres : b.units) || 0;
    const litresEquivalent = convertToLitresEquivalent(rawUnits, unitType);

    const standingPence = Number(b.standingChargePencePerDay) || 0;
    const standingChargePerDayIncVat = roundTo((standingPence / 100) * vatMultiplier, 4);

    let effectivePricePerLitreIncVat = 0;
    let totalPaidIncVat = 0;
    const enteredUnitPence = Number(b.unitPricePence) || 0;
    const enteredTotalPaid = Number(b.totalPaid) || 0;

    if (enteredUnitPence > 0) {
      effectivePricePerLitreIncVat = roundTo(enteredUnitPence * vatMultiplier, 2);
      totalPaidIncVat =
        enteredTotalPaid > 0
          ? roundTo(enteredTotalPaid * vatMultiplier, 2)
          : roundTo((litresEquivalent * effectivePricePerLitreIncVat) / 100, 2);
    } else if (enteredTotalPaid > 0 && litresEquivalent > 0) {
      totalPaidIncVat = roundTo(enteredTotalPaid * vatMultiplier, 2);
      effectivePricePerLitreIncVat = roundTo((totalPaidIncVat * 100) / litresEquivalent, 2);
    }

    return {
      id: b.id || '',
      date: b.date || new Date().toISOString().slice(0, 10),
      supplier: b.supplier || 'Calor Gas',
      unitType,
      rawUnits: roundTo(rawUnits, 2),
      litresEquivalent: roundTo(litresEquivalent, 1),
      vatIncluded,
      totalPaidIncVat,
      effectivePricePerLitreIncVat,
      standingChargePencePerDay: standingPence,
      standingChargePerDayIncVat,
      note: b.note || '',
    };
  }

  function detectAutoRefill(prevReading, currReading, mode) {
    if ((mode || 'bulk') !== 'bulk') return false;
    if (!prevReading || !currReading) return false;
    const prevPct = Number(prevReading.pct);
    const currPct = Number(currReading.pct);
    if (!Number.isFinite(prevPct) || !Number.isFinite(currPct)) return false;
    return currPct - prevPct > CONSTANTS.REFILL_DETECTION_JUMP_PCT;
  }

  function toUtcDayMs(dateStr) {
    const clean = String(dateStr || '').slice(0, 10);
    const parsed = Date.parse(clean + 'T00:00:00Z');
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function toDateStr(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function parseReadingTimestamp(r) {
    if (r.timestamp) {
      const ts = Date.parse(r.timestamp);
      if (Number.isFinite(ts)) return ts;
    }
    const base = toUtcDayMs(r.date || new Date().toISOString().slice(0, 10));
    return base + 12 * 3600000;
  }

  function classifyPplBand(ppl) {
    if (!Number.isFinite(ppl) || ppl <= 0) return 'unknown';
    if (ppl < 55) return 'competitive';
    if (ppl <= 68) return 'typical';
    return 'high';
  }

  function findApplicableBill(dateStr, sortedBills) {
    if (!sortedBills || sortedBills.length === 0) return null;
    let match = null;
    for (let i = 0; i < sortedBills.length; i++) {
      if (sortedBills[i].date <= dateStr) {
        match = sortedBills[i];
      }
    }
    return match || sortedBills[0];
  }

  function addDailyCost(dailyMap, dateStr, litres, pplIncVat, standingPerDayIncVat, weatherByDate) {
    if (!dailyMap[dateStr]) {
      const tempObj = weatherByDate && weatherByDate[dateStr];
      const tempC =
        tempObj !== undefined && tempObj !== null
          ? typeof tempObj === 'number'
            ? tempObj
            : Number(tempObj.tempC)
          : null;
      const validTemp = tempC !== null && Number.isFinite(tempC) ? roundTo(tempC, 1) : null;
      const hdd = validTemp !== null ? roundTo(Math.max(0, CONSTANTS.HDD_BASE_C - validTemp), 2) : null;
      dailyMap[dateStr] = {
        date: dateStr,
        litres: 0,
        kWh: 0,
        gasCost: 0,
        standingCost: 0,
        totalCost: 0,
        tempC: validTemp,
        hdd,
      };
    }
    const row = dailyMap[dateStr];
    const gasCost = (litres * pplIncVat) / 100;
    row.litres += litres;
    row.kWh += litres * CONSTANTS.KWH_PER_LITRE_LPG;
    row.gasCost += gasCost;
    row.standingCost += standingPerDayIncVat;
    row.totalCost += gasCost + standingPerDayIncVat;
  }

  function computeAnalytics(state, weatherByDate) {
    const settings = (state && state.settings) || {};
    const mode = settings.mode === 'meter' ? 'meter' : 'bulk';
    const tankCapacityLitres = Number(settings.tankCapacityLitres) || 2000;
    const reorderAlertPct = Number(settings.reorderAlertPct) || 25;
    const meterUnit = settings.meterUnit || 'm3';

    const rawBills = Array.isArray(state && state.bills) ? state.bills : [];
    const sortedBills = rawBills
      .map(normalizeBill)
      .filter((b) => b.effectivePricePerLitreIncVat > 0 || b.litresEquivalent > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    const hasBills = sortedBills.length > 0;
    const latestBill = hasBills ? sortedBills[sortedBills.length - 1] : null;
    const prevBill = sortedBills.length >= 2 ? sortedBills[sortedBills.length - 2] : null;

    const latestPplIncVat = latestBill
      ? latestBill.effectivePricePerLitreIncVat
      : CONSTANTS.DEFAULT_PPL_INC_VAT;
    const pplDeltaPence =
      latestBill && prevBill
        ? roundTo(latestBill.effectivePricePerLitreIncVat - prevBill.effectivePricePerLitreIncVat, 2)
        : 0;

    const rawReadings = Array.isArray(state && state.readings) ? state.readings : [];
    const sortedReadings = rawReadings
      .map((r) => ({
        ...r,
        _ts: parseReadingTimestamp(r),
        _dateStr: String(r.date || toDateStr(parseReadingTimestamp(r))).slice(0, 10),
      }))
      .sort((a, b) => a._ts - b._ts);

    const intervals = [];
    const dailyMap = {};
    let totalLitresUsed = 0;
    let totalBurnDays = 0;
    let totalGasCost = 0;
    let totalStandingCost = 0;

    for (let i = 1; i < sortedReadings.length; i++) {
      const prev = sortedReadings[i - 1];
      const curr = sortedReadings[i];
      const daysSpan = (curr._ts - prev._ts) / CONSTANTS.DAY_MS;
      const isTooShort = daysSpan < CONSTANTS.MIN_BURN_INTERVAL_DAYS;

      let isRefill = false;
      let litresUsed = 0;
      let deltaPct = 0;

      if (mode === 'bulk') {
        const prevPct = Number(prev.pct);
        const currPct = Number(curr.pct);
        deltaPct = roundTo(currPct - prevPct, 2);
        const autoRefill = detectAutoRefill(prev, curr, 'bulk');
        isRefill = curr.isRefill === true || (curr.isRefill !== false && autoRefill);
        if (!isRefill) {
          if (currPct < prevPct) {
            litresUsed = ((prevPct - currPct) / 100) * tankCapacityLitres;
          } else {
            // Minor <= 2.5% thermal expansion on sunny days clamps cleanly to 0 usage
            litresUsed = 0;
          }
        }
      } else {
        const prevVal = Number(prev.meterValue);
        const currVal = Number(curr.meterValue);
        const unit = curr.meterUnit || meterUnit;
        if (Number.isFinite(prevVal) && Number.isFinite(currVal) && currVal >= prevVal) {
          litresUsed = convertToLitresEquivalent(currVal - prevVal, unit);
        } else {
          isRefill = true; // meter replacement/rollover
        }
      }

      const billForInterval = findApplicableBill(curr._dateStr, sortedBills);
      const ppl = billForInterval ? billForInterval.effectivePricePerLitreIncVat : latestPplIncVat;
      const standing = billForInterval
        ? billForInterval.standingChargePerDayIncVat
        : hasBills
          ? 0
          : CONSTANTS.DEFAULT_STANDING_DAY_GBP;

      const gasCost = (litresUsed * ppl) / 100;
      const intervalDaysClean = Math.max(0, daysSpan);
      const standingCost = intervalDaysClean * standing;

      intervals.push({
        fromId: prev.id,
        toId: curr.id,
        fromDate: prev._dateStr,
        toDate: curr._dateStr,
        daysSpan: roundTo(daysSpan, 3),
        isRefill,
        isTooShort,
        deltaPct,
        litresUsed: roundTo(litresUsed, 2),
        litresPerDay: !isRefill && !isTooShort && daysSpan > 0 ? roundTo(litresUsed / daysSpan, 2) : null,
        pplIncVat: ppl,
        gasCost: roundTo(gasCost, 2),
        standingCost: roundTo(standingCost, 2),
      });

      if (!isRefill && !isTooShort) {
        totalLitresUsed += litresUsed;
        totalBurnDays += daysSpan;
        totalGasCost += gasCost;
        totalStandingCost += standingCost;

        const startDayMs = toUtcDayMs(prev._dateStr);
        const endDayMs = toUtcDayMs(curr._dateStr);
        const daySlots = Math.max(1, Math.round((endDayMs - startDayMs) / CONSTANTS.DAY_MS));

        if (daySlots <= 1) {
          addDailyCost(dailyMap, curr._dateStr, litresUsed, ppl, daysSpan * standing, weatherByDate);
        } else {
          const perDayLitres = litresUsed / daySlots;
          const perDayStanding = (daysSpan * standing) / daySlots;
          for (let d = 1; d <= daySlots; d++) {
            const slotDate = toDateStr(startDayMs + d * CONSTANTS.DAY_MS);
            addDailyCost(dailyMap, slotDate, perDayLitres, ppl, perDayStanding, weatherByDate);
          }
        }
      }
    }

    const dailySeries = Object.values(dailyMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({
        date: row.date,
        litres: roundTo(row.litres, 2),
        kWh: roundTo(row.kWh, 2),
        gasCost: roundTo(row.gasCost, 2),
        standingCost: roundTo(row.standingCost, 2),
        totalCost: roundTo(row.totalCost, 2),
        tempC: row.tempC,
        hdd: row.hdd,
      }));

    const monthlyMap = {};
    for (let i = 0; i < dailySeries.length; i++) {
      const d = dailySeries[i];
      const monthKey = d.date.slice(0, 7);
      if (!monthlyMap[monthKey]) {
        monthlyMap[monthKey] = {
          month: monthKey,
          litres: 0,
          kWh: 0,
          gasCost: 0,
          standingCost: 0,
          totalCost: 0,
          tempSum: 0,
          tempCount: 0,
        };
      }
      const m = monthlyMap[monthKey];
      m.litres += d.litres;
      m.kWh += d.kWh;
      m.gasCost += d.gasCost;
      m.standingCost += d.standingCost;
      m.totalCost += d.totalCost;
      if (d.tempC !== null) {
        m.tempSum += d.tempC;
        m.tempCount += 1;
      }
    }

    const monthlySeries = Object.values(monthlyMap)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        month: m.month,
        litres: roundTo(m.litres, 1),
        kWh: roundTo(m.kWh, 1),
        gasCost: roundTo(m.gasCost, 2),
        standingCost: roundTo(m.standingCost, 2),
        totalCost: roundTo(m.totalCost, 2),
        avgTempC: m.tempCount > 0 ? roundTo(m.tempSum / m.tempCount, 1) : null,
      }));

    // Recent burn rate (last up to 14 days of valid burn intervals)
    const validBurnIntervals = intervals.filter((iv) => !iv.isRefill && !iv.isTooShort && iv.daysSpan > 0);
    let recentLitres = 0;
    let recentDays = 0;
    for (let i = validBurnIntervals.length - 1; i >= 0; i--) {
      recentLitres += validBurnIntervals[i].litresUsed;
      recentDays += validBurnIntervals[i].daysSpan;
      if (recentDays >= 14) break;
    }

    const recentLitresPerDay = recentDays > 0 ? roundTo(recentLitres / recentDays, 2) : 0;
    const recentKwhPerDay = roundTo(recentLitresPerDay * CONSTANTS.KWH_PER_LITRE_LPG, 1);
    const activeStandingDay = latestBill
      ? latestBill.standingChargePerDayIncVat
      : hasBills
        ? 0
        : CONSTANTS.DEFAULT_STANDING_DAY_GBP;
    const recentGasCostPerDay = (recentLitresPerDay * latestPplIncVat) / 100;
    const recentCostPerDay =
      recentDays > 0 ? roundTo(recentGasCostPerDay + activeStandingDay, 2) : 0;
    const projectedMonthlyCost = roundTo(recentCostPerDay * 30.4, 2);
    const projectedAnnualGasCost =
      recentDays > 0 ? roundTo(recentGasCostPerDay * 365 + activeStandingDay * 365, 0) : 0;

    const latestReading = sortedReadings.length ? sortedReadings[sortedReadings.length - 1] : null;
    const firstReading = sortedReadings.length ? sortedReadings[0] : null;
    const trackedDays =
      latestReading && firstReading
        ? roundTo((latestReading._ts - firstReading._ts) / CONSTANTS.DAY_MS, 1)
        : 0;

    let currentPct = null;
    let litresRemaining = null;
    let daysToReorder = null;
    let reorderDate = null;
    let tankStatus = 'unknown';

    if (mode === 'bulk' && latestReading && Number.isFinite(Number(latestReading.pct))) {
      currentPct = roundTo(Number(latestReading.pct), 1);
      litresRemaining = Math.round((currentPct / 100) * tankCapacityLitres);
      const reorderLitres = (reorderAlertPct / 100) * tankCapacityLitres;
      if (currentPct <= reorderAlertPct) {
        tankStatus = 'low';
        daysToReorder = 0;
        reorderDate = latestReading._dateStr;
      } else {
        tankStatus = currentPct <= reorderAlertPct + 12 ? 'plan' : 'healthy';
        if (recentLitresPerDay > 0.05) {
          daysToReorder = Math.round((litresRemaining - reorderLitres) / recentLitresPerDay);
          const targetMs = latestReading._ts + daysToReorder * CONSTANTS.DAY_MS;
          reorderDate = toDateStr(targetMs);
        }
      }
    }

    // Weather-adjusted insight comparing last 7 days vs prior 7 days
    let weatherInsight = null;
    if (dailySeries.length >= 10) {
      const recent7 = dailySeries.slice(-7);
      const prev7 = dailySeries.slice(-14, -7);
      const rWithWeather = recent7.filter((d) => d.tempC !== null);
      const pWithWeather = prev7.filter((d) => d.tempC !== null);
      if (rWithWeather.length >= 3 && pWithWeather.length >= 3) {
        const avgLitresR = recent7.reduce((s, d) => s + d.litres, 0) / recent7.length;
        const avgLitresP = prev7.reduce((s, d) => s + d.litres, 0) / prev7.length;
        const avgTempR = rWithWeather.reduce((s, d) => s + d.tempC, 0) / rWithWeather.length;
        const avgTempP = pWithWeather.reduce((s, d) => s + d.tempC, 0) / pWithWeather.length;
        const avgHddR = rWithWeather.reduce((s, d) => s + d.hdd, 0) / rWithWeather.length;
        const avgHddP = pWithWeather.reduce((s, d) => s + d.hdd, 0) / pWithWeather.length;

        const pctBurnChange = avgLitresP > 0 ? roundTo(((avgLitresR - avgLitresP) / avgLitresP) * 100, 0) : 0;
        const tempDiff = roundTo(avgTempR - avgTempP, 1);

        if (avgHddR > 1 && avgHddP > 1) {
          const perHddR = avgLitresR / avgHddR;
          const perHddP = avgLitresP / avgHddP;
          const effChangePct = roundTo(((perHddR - perHddP) / perHddP) * 100, 0);
          let headline = '';
          if (Math.abs(effChangePct) <= 8) {
            headline =
              tempDiff < -0.8
                ? `Usage rose ${Math.abs(pctBurnChange)}% this week because outside temperatures dropped ${Math.abs(tempDiff)}°C — your heating efficiency is steady.`
                : `Your heating efficiency is steady compared to last week (${roundTo(perHddR, 2)} L per heating degree-day).`;
          } else if (effChangePct > 8) {
            headline = `Alert: Gas burn per cold degree rose ${effChangePct}% compared to last week (${roundTo(avgTempR, 1)}°C avg). Check boiler thermostat, radiators, or open vents.`;
          } else {
            headline = `Great progress: You used ${Math.abs(effChangePct)}% less gas per degree of cold than the prior week!`;
          }
          weatherInsight = {
            headline,
            avgTempRecentC: roundTo(avgTempR, 1),
            avgTempPrevC: roundTo(avgTempP, 1),
            effChangePct,
            pctBurnChange,
          };
        }
      }
    }

    return {
      mode,
      intervals,
      dailySeries,
      monthlySeries,
      bills: sortedBills,
      weatherInsight,
      summary: {
        readingCount: sortedReadings.length,
        trackedDays,
        hasSevenDays: trackedDays >= 7 && totalBurnDays >= 6,
        hasRealBurnRate: recentDays > 0,
        hasBills,
        currentPct,
        litresRemaining,
        tankCapacityLitres,
        reorderAlertPct,
        recentLitresPerDay,
        recentKwhPerDay,
        recentCostPerDay,
        projectedMonthlyCost,
        projectedAnnualGasCost,
        daysToReorder,
        reorderDate,
        tankStatus,
        latestPplIncVat,
        pplDeltaPence,
        pplBand: classifyPplBand(latestPplIncVat),
        totalLitresUsed: roundTo(totalLitresUsed, 1),
        totalSpent: roundTo(totalGasCost + totalStandingCost, 2),
        latestReading,
      },
    };
  }

  function computeHeatingAdvice(profile, summary, completedActions) {
    const p = Object.assign(
      {
        homeType: 'park_home',
        heaterType: 'condensing_combi',
        controls: 'programmer_stat',
        flowTemp: 'high_70plus',
        insulation: 'average',
        region: 'scotland',
      },
      profile || {}
    );
    const s = summary || {};
    const doneMap = completedActions || {};
    const hasMeasured = Boolean(s.hasSevenDays && s.projectedAnnualGasCost > 100);
    const isEstimated = !hasMeasured;
    const baseAnnualSpend = hasMeasured
      ? Number(s.projectedAnnualGasCost)
      : CONSTANTS.FALLBACK_ANNUAL_SPEND_GBP;
    const ppl = Number(s.latestPplIncVat) > 0 ? Number(s.latestPplIncVat) : CONSTANTS.DEFAULT_PPL_INC_VAT;

    const quickWins = [];
    const lowCost = [];
    const majorUpgrades = [];

    function pushTip(bucket, tip) {
      const doneEntry = doneMap[tip.id] || null;
      bucket.push({
        ...tip,
        savingAnnual: Math.max(15, Math.round(tip.savingAnnual)),
        done: Boolean(doneEntry),
        completedAt: doneEntry && doneEntry.completedAt ? doneEntry.completedAt : null,
      });
    }

    // --- Tier 1: £0 Quick Wins Today ---
    if (
      (p.heaterType === 'condensing_combi' || p.heaterType === 'system_tank') &&
      p.flowTemp !== 'low_under_60'
    ) {
      pushTip(quickWins, {
        id: 'lower_flow_temp',
        tier: 'quick_win',
        title: 'Lower radiator flow temperature to 55–60°C',
        costLabel: '£0',
        costGbp: 0,
        savingAnnual: baseAnnualSpend * (p.flowTemp === 'high_70plus' ? 0.095 : 0.065),
        paybackYears: 0,
        whyItWorks:
          'Modern condensing boilers only capture hidden heat from exhaust steam when returning water is cool (<55°C). Standard 75°C settings stop them condensing.',
        steps:
          'Turn the radiator dial (marked with a radiator icon, NOT the tap icon) on your boiler down to 55–60°C. On system boilers with a hot water cylinder, keep hot water at 60°C to prevent Legionella.',
      });
    }

    if (p.controls !== 'smart_trv') {
      pushTip(quickWins, {
        id: 'thermostat_one_degree',
        tier: 'quick_win',
        title: 'Dial main thermostat down 1°C & heat rooms by schedule',
        costLabel: '£0',
        costGbp: 0,
        savingAnnual: baseAnnualSpend * 0.08,
        paybackYears: 0,
        whyItWorks:
          'Lowering indoor target temperature by 1°C cuts UK LPG heating demand by roughly 8–10% without sacrificing comfort.',
        steps:
          'Set living rooms to 19–20°C and bedrooms to 17°C using radiator valves. Turn heating off 30 minutes before bedtime while radiators stay warm.',
      });
    }

    if (ppl > 64) {
      const targetPpl = 56;
      const shareSaved = Math.min(0.22, (ppl - targetPpl) / ppl);
      pushTip(quickWins, {
        id: 'negotiate_lpg_rate',
        tier: 'quick_win',
        title: `Challenge your ${ppl.toFixed(1)}p/L LPG rate (UK market target ~55–58p/L)`,
        costLabel: '£0',
        costGbp: 0,
        savingAnnual: baseAnnualSpend * shareSaved,
        paybackYears: 0,
        whyItWorks:
          'Bulk LPG suppliers often place out-of-contract customers onto higher standing rates. Getting two quotes (Flogas, Avantigas, or local independent) lets Calor price-match or lets you switch cleanly under CMA rules.',
        steps:
          'Note your tank capacity and last 12 months of litres from TankGauge Bills tab, request two written quotes, then phone your supplier retention team.',
      });
    } else if (p.heaterType === 'warm_air' || p.heaterType === 'gas_fires') {
      pushTip(quickWins, {
        id: 'clean_filters_vents',
        tier: 'quick_win',
        title: 'Vacuum warm-air intake grilles & keep vents unobstructed',
        costLabel: '£0',
        costGbp: 0,
        savingAnnual: baseAnnualSpend * 0.05,
        paybackYears: 0,
        whyItWorks:
          'Dust-clogged return grilles force fan units and gas fires to run longer and overheat heat exchangers.',
        steps:
          'Vacuum dust off air return grilles and clear sofas/curtains at least 30 cm away from vents and radiators.',
      });
    }

    // --- Tier 2: Low-Cost Tweaks (£15–£250) ---
    if (p.insulation !== 'good') {
      if (p.homeType === 'park_home') {
        pushTip(lowCost, {
          id: 'park_home_draught_curtains',
          tier: 'low_cost',
          title: 'Seal park home floor edges, letterbox & fit thermal-lined curtains',
          costLabel: '£45–£120',
          costGbp: 85,
          savingAnnual: baseAnnualSpend * 0.085,
          paybackYears: roundTo(85 / Math.max(40, baseAnnualSpend * 0.085), 1),
          whyItWorks:
            'Park homes and lodges sit above cold air gaps and have large glass areas. Stopping wind chill around door seals and windows cuts boiler cycling immediately.',
          steps:
            'Fit brush strips on external doors, silicone foam tape on draughty window frames, and close heavy lined curtains at dusk.',
        });
      } else if (p.homeType === 'stone_cottage') {
        pushTip(lowCost, {
          id: 'stone_chimney_draught',
          tier: 'low_cost',
          title: 'Fit chimney sheep/balloon & secondary glazing film on stone walls',
          costLabel: '£50–£140',
          costGbp: 95,
          savingAnnual: baseAnnualSpend * 0.09,
          paybackYears: roundTo(95 / Math.max(40, baseAnnualSpend * 0.09), 1),
          whyItWorks:
            'Traditional stone cottages rely on breathability, so sealing open chimneys and single-pane draughts keeps warm air in without trapping damp.',
          steps:
            'Install a breathable wool chimney blocker in unused fireplaces and apply clear shrink-fit secondary glazing film on draughty sash windows.',
        });
      } else {
        pushTip(lowCost, {
          id: 'radiator_reflector_draught',
          tier: 'low_cost',
          title: 'Fit radiator reflector foil on outside walls & door draught strips',
          costLabel: '£35–£70',
          costGbp: 50,
          savingAnnual: baseAnnualSpend * 0.06,
          paybackYears: roundTo(50 / Math.max(35, baseAnnualSpend * 0.06), 1),
          whyItWorks:
            'Up to 35% of radiator heat on uninsulated external walls escapes straight into the brickwork rather than warming the room.',
          steps:
            'Slide reflective radiator panels behind brackets on exterior-facing walls and seal loft hatch + external door edges.',
        });
      }
    }

    if (p.controls === 'basic_on_off' || p.controls === 'programmer_stat') {
      const smartCost = p.controls === 'basic_on_off' ? 190 : 140;
      pushTip(lowCost, {
        id: 'smart_trv_zones',
        tier: 'low_cost',
        title: 'Add smart thermostat & room TRV valves to stop heating empty rooms',
        costLabel: `£${smartCost}`,
        costGbp: smartCost,
        savingAnnual: baseAnnualSpend * 0.11,
        paybackYears: roundTo(smartCost / Math.max(50, baseAnnualSpend * 0.11), 1),
        whyItWorks:
          'LPG costs roughly 9–11p per kWh — heating unused spare bedrooms or hallways all day burns money much faster than mains gas.',
        steps:
          'Fit Thermostatic Radiator Valves (TRVs) on every bedroom radiator and move the main room thermostat out of draughty hallways.',
      });
    }

    if (p.heaterType === 'system_tank') {
      pushTip(lowCost, {
        id: 'cylinder_jacket_pipes',
        tier: 'low_cost',
        title: 'Upgrade hot water cylinder jacket (80mm+) & lag exposed boiler pipes',
        costLabel: '£25–£40',
        costGbp: 32,
        savingAnnual: baseAnnualSpend * 0.045,
        paybackYears: roundTo(32 / Math.max(25, baseAnnualSpend * 0.045), 1),
        whyItWorks:
          'A bare or thin 25mm cylinder jacket loses heat 24 hours a day into your airing cupboard.',
        steps:
          'Wrap an 80mm BS-standard jacket firmly around the cylinder and clip foam pipe lagging onto copper flow/return pipes.',
      });
    } else if (p.heaterType !== 'warm_air' && p.heaterType !== 'gas_fires') {
      pushTip(lowCost, {
        id: 'hydronic_balance_bleed',
        tier: 'low_cost',
        title: 'Bleed cold radiator tops & balance lockshield valves',
        costLabel: '£15',
        costGbp: 15,
        savingAnnual: baseAnnualSpend * 0.04,
        paybackYears: roundTo(15 / Math.max(20, baseAnnualSpend * 0.04), 1),
        whyItWorks:
          'If radiators nearest the boiler roast while distant rooms stay lukewarm, your boiler runs longer at high temperature wasting LPG.',
        steps:
          'Bleed trapped air with a radiator key, then partially close lockshield valves on the hottest radiators so warm water reaches the farthest room evenly.',
      });
    }

    // --- Tier 3: Major Upgrades & Grants ---
    if (p.homeType === 'park_home' && p.insulation !== 'good') {
      pushTip(majorUpgrades, {
        id: 'park_home_underfloor_cladding',
        tier: 'major_upgrade',
        title: 'Underfloor foil/foam insulation & external insulated park home cladding',
        costLabel: '£1,800–£4,500 (Grants check)',
        costGbp: 2600,
        savingAnnual: baseAnnualSpend * 0.24,
        paybackYears: roundTo(2600 / Math.max(120, baseAnnualSpend * 0.24), 1),
        whyItWorks:
          'Park homes lose the highest share of heat through uninsulated suspended floors and older thin timber walls. Underfloor insulation alone pays back swiftly on LPG.',
        steps:
          'Check Park Home Warm Homes / Home Energy Scotland funding before paying full price; ensure breathability mesh is maintained underneath.',
      });
    } else if (p.insulation === 'poor') {
      pushTip(majorUpgrades, {
        id: 'loft_solid_wall_insulation',
        tier: 'major_upgrade',
        title:
          p.homeType === 'stone_cottage'
            ? '300mm Loft insulation + breathable wood-fibre wall lining'
            : 'Top up loft to 300mm & seal wall thermal bridges',
        costLabel: '£600–£2,200 (GBIS / HES Grants)',
        costGbp: 1100,
        savingAnnual: baseAnnualSpend * 0.22,
        paybackYears: roundTo(1100 / Math.max(100, baseAnnualSpend * 0.22), 1),
        whyItWorks:
          'A quarter of all house heat escapes straight through an under-insulated roof. Lifting loft wool from 100mm to 300mm slashes winter LPG deliveries.',
        steps:
          'Measure existing loft depth between joists. Check UK Great British Insulation Scheme (GBIS) or Home Energy Scotland for free/subsidised loft grants.',
      });
    }

    if (p.heaterType === 'old_boiler' || p.heaterType === 'warm_air' || p.heaterType === 'gas_fires') {
      const lpgPencePerKwh = roundTo((ppl / CONSTANTS.KWH_PER_LITRE_LPG) / 0.85, 1);
      const hpPencePerKwh = 7.8; // ~24.5p elec / SCOP 3.15
      const hpSavingShare = clamp((lpgPencePerKwh - hpPencePerKwh) / lpgPencePerKwh, 0.18, 0.42);
      const netCostAfterGrant = p.region === 'scotland' ? 3200 : 4500;
      pushTip(majorUpgrades, {
        id: 'heat_pump_or_modern_condensing',
        tier: 'major_upgrade',
        title:
          p.region === 'scotland'
            ? 'Air-Source Heat Pump (Up to £7,500–£9,000 Home Energy Scotland Grant)'
            : 'Air-Source Heat Pump (£7,500 UK Boiler Upgrade Scheme Grant)',
        costLabel: `~£${netCostAfterGrant.toLocaleString('en-GB')} after £7,500+ grant`,
        costGbp: netCostAfterGrant,
        savingAnnual: baseAnnualSpend * hpSavingShare,
        paybackYears: roundTo(netCostAfterGrant / Math.max(200, baseAnnualSpend * hpSavingShare), 1),
        whyItWorks:
          `At ${ppl.toFixed(1)}p/L on an older LPG system (~${lpgPencePerKwh}p per delivered kWh of heat), a modern heat pump delivers heat for ~${hpPencePerKwh}p/kWh — cutting annual bills significantly in off-grid rural homes.`,
        steps:
          p.region === 'scotland'
            ? 'Book a free Home Energy Scotland assessment first: rural Scottish homes can receive up to £9,000 grant + optional 0% interest loan.'
            : 'Get 3 MCS-certified quotes; the £7,500 BUS grant is deducted straight off your invoice.',
      });
    } else {
      const lpgKwhDelivered = roundTo(ppl / CONSTANTS.KWH_PER_LITRE_LPG / 0.9, 1);
      const netHpCost = p.region === 'scotland' ? 3500 : 4800;
      const savingShare = clamp((lpgKwhDelivered - 7.8) / lpgKwhDelivered, 0.12, 0.3);
      pushTip(majorUpgrades, {
        id: 'air_source_heat_pump_upgrade',
        tier: 'major_upgrade',
        title:
          p.region === 'scotland'
            ? 'Compare next boiler change vs Air-Source Heat Pump (£7.5k–£9k Rural Grant)'
            : 'Consider Air-Source Heat Pump on next boiler replacement (£7,500 BUS Grant)',
        costLabel: `~£${netHpCost.toLocaleString('en-GB')} net after grant`,
        costGbp: netHpCost,
        savingAnnual: baseAnnualSpend * savingShare,
        paybackYears: roundTo(netHpCost / Math.max(150, baseAnnualSpend * savingShare), 1),
        whyItWorks:
          `Your LPG delivers heat at ~${lpgKwhDelivered}p/kWh (vs ~7.8p/kWh from an efficient heat pump). Keeping your condensing boiler well-tuned now and switching when it nears end-of-life locks in rural grants.`,
        steps:
          p.region === 'scotland'
            ? 'Use the free Home Energy Scotland calculator and check whether your radiators work comfortably at 50–55°C flow temperature.'
            : 'Test running your boiler at 55°C this winter — if your rooms stay warm, your home is already heat-pump ready.',
      });
    }

    const allTips = quickWins.concat(lowCost, majorUpgrades);
    const totalPotentialAnnual = allTips.reduce((s, t) => s + t.savingAnnual, 0);
    const implementedAnnual = allTips.filter((t) => t.done).reduce((s, t) => s + t.savingAnnual, 0);
    const remainingAnnual = Math.max(0, totalPotentialAnnual - implementedAnnual);

    const grantLinks =
      p.region === 'scotland'
        ? [
            {
              label: 'Home Energy Scotland (Grants up to £9,000 rural + 0% loan)',
              url: 'https://www.homeenergyscotland.org/funding/grants-and-loans/',
            },
            {
              label: 'Energy Saving Trust — Heating Controls & LPG Guide',
              url: 'https://energysavingtrust.org.uk/advice/thermostats-and-heating-controls/',
            },
          ]
        : [
            {
              label: 'UK Boiler Upgrade Scheme (£7,500 Heat Pump Grant)',
              url: 'https://www.gov.uk/apply-boiler-upgrade-scheme',
            },
            {
              label: 'Great British Insulation Scheme (Free/Subsidised Loft & Wall)',
              url: 'https://www.gov.uk/apply-great-british-insulation-scheme',
            },
          ];

    return {
      isEstimated,
      baseAnnualSpend: Math.round(baseAnnualSpend),
      totalPotentialAnnual,
      implementedAnnual,
      remainingAnnual,
      tiers: {
        quickWins,
        lowCost,
        majorUpgrades,
      },
      grantLinks,
    };
  }

  function generateDemoDataset() {
    // Realistic 55-day Kintore, Aberdeenshire 2,000 L Calor bulk tank dataset
    const readings = [
      { id: 'demo_r01', date: '2026-09-28', timestamp: '2026-09-28T09:15:00Z', pct: 46.5, note: 'Autumn start check' },
      { id: 'demo_r02', date: '2026-10-03', timestamp: '2026-10-03T09:10:00Z', pct: 42.0, note: '' },
      { id: 'demo_r03', date: '2026-10-08', timestamp: '2026-10-08T10:05:00Z', pct: 37.0, note: '' },
      { id: 'demo_r04', date: '2026-10-14', timestamp: '2026-10-14T08:40:00Z', pct: 30.5, note: 'Cooler nights' },
      { id: 'demo_r05', date: '2026-10-19', timestamp: '2026-10-19T14:20:00Z', pct: 24.0, note: 'Before Calor delivery' },
      { id: 'demo_r06', date: '2026-10-20', timestamp: '2026-10-20T15:30:00Z', pct: 84.0, isRefill: true, note: 'Calor tanker top-up (1,200 L)' },
      { id: 'demo_r07', date: '2026-10-25', timestamp: '2026-10-25T09:30:00Z', pct: 79.0, note: '' },
      { id: 'demo_r08', date: '2026-10-30', timestamp: '2026-10-30T09:00:00Z', pct: 73.5, note: '' },
      { id: 'demo_r09', date: '2026-11-04', timestamp: '2026-11-04T09:45:00Z', pct: 67.5, note: 'First frost' },
      { id: 'demo_r10', date: '2026-11-09', timestamp: '2026-11-09T09:15:00Z', pct: 60.5, note: '' },
      { id: 'demo_r11', date: '2026-11-14', timestamp: '2026-11-14T10:00:00Z', pct: 54.5, note: 'Lowered boiler flow to 58°C' },
      { id: 'demo_r12', date: '2026-11-20', timestamp: '2026-11-20T09:30:00Z', pct: 48.0, note: 'Latest dial photo' },
    ];

    const bills = [
      {
        id: 'demo_b01',
        date: '2026-07-18',
        supplier: 'Calor Gas',
        litres: 1100,
        unitType: 'litres',
        unitPricePence: 61.5,
        totalPaid: 676.5,
        vatIncluded: true,
        standingChargePencePerDay: 22.5,
        note: 'Summer delivery',
      },
      {
        id: 'demo_b02',
        date: '2026-10-20',
        supplier: 'Calor Gas',
        litres: 1200,
        unitType: 'litres',
        unitPricePence: 65.0,
        totalPaid: 780.0,
        vatIncluded: true,
        standingChargePencePerDay: 23.0,
        note: 'Autumn top-up (+3.5p/L increase)',
      },
    ];

    // Aberdeenshire autumn-to-winter daily temperatures (°C)
    const demoWeather = {};
    const start = Date.parse('2026-09-28T00:00:00Z');
    const temps = [
      12.4, 11.8, 11.2, 10.6, 10.9, 10.1, 9.5, 9.2, 8.9, 9.8, 9.1, 8.5, 8.1, 7.6,
      7.2, 7.9, 8.4, 7.5, 6.9, 6.5, 7.1, 7.8, 7.4, 6.8, 6.2, 5.9, 6.4, 7.0,
      6.1, 5.5, 5.0, 4.4, 4.8, 5.2, 4.9, 4.2, 3.6, 3.1, 3.8, 4.5, 4.1, 3.4,
      2.9, 3.5, 4.0, 4.6, 5.1, 4.8, 4.3, 3.9, 3.6, 4.2, 4.7, 4.4, 3.8,
    ];
    for (let i = 0; i < temps.length; i++) {
      demoWeather[toDateStr(start + i * CONSTANTS.DAY_MS)] = {
        tempC: temps[i],
        source: 'demo_aberdeenshire',
      };
    }

    return {
      isDemo: true,
      settings: {
        mode: 'bulk',
        tankCapacityLitres: 2000,
        reorderAlertPct: 25,
        meterUnit: 'm3',
        locationQuery: 'AB51 0YX',
        locationLabel: 'Kintore, Aberdeenshire',
        lat: 57.233,
        lon: -2.35,
        calibration: { ...CONSTANTS.DIAL_PRESETS.rochester_5_95 },
      },
      readings,
      bills,
      profile: {
        homeType: 'park_home',
        heaterType: 'condensing_combi',
        controls: 'programmer_stat',
        flowTemp: 'high_70plus',
        insulation: 'average',
        region: 'scotland',
      },
      completedActions: {
        lower_flow_temp: { completedAt: '2026-11-14' },
      },
      demoWeather,
    };
  }

  return {
    CONSTANTS,
    roundTo,
    clamp,
    normalizeAngle180,
    resolveCalibration,
    angleDegToPercent,
    percentToAngleDeg,
    estimateTankCapacity,
    convertToLitresEquivalent,
    normalizeBill,
    detectAutoRefill,
    computeAnalytics,
    computeHeatingAdvice,
    generateDemoDataset,
  };
});
