/**
 * TankGauge Local Weather Integration
 * Free, zero-API-key UK postcode geocoding (postcodes.io) + daily mean temperature (Open-Meteo).
 * Caches weather locally in localStorage so offline viewing works cleanly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TankWeather = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CACHE_KEY = 'tankgauge_weather_cache_v1';

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (_) {
      // Ignore storage errors gracefully
    }
  }

  function looksLikeUkPostcode(str) {
    return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(str || '').trim());
  }

  async function resolveUkLocation(query) {
    const clean = String(query || '').trim();
    if (!clean) throw new Error('Please enter a UK postcode or town.');

    if (looksLikeUkPostcode(clean)) {
      const pc = clean.replace(/\s+/g, '');
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.result) {
          const r = data.result;
          const place = r.admin_ward || r.parish || r.admin_district || clean.toUpperCase();
          const region = r.region || r.country || '';
          return {
            lat: Number(r.latitude),
            lon: Number(r.longitude),
            label: region && region !== place ? `${place}, ${region}` : place,
            postcode: r.postcode,
          };
        }
      }
    }

    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        clean
      )}&count=1&countryCode=GB`
    );
    if (!geoRes.ok) throw new Error('Location lookup failed (offline or unavailable).');
    const geo = await geoRes.json();
    if (!geo || !geo.results || !geo.results.length) {
      throw new Error(`Could not find UK location "${clean}".`);
    }
    const g = geo.results[0];
    return {
      lat: Number(g.latitude),
      lon: Number(g.longitude),
      label: g.admin2 ? `${g.name}, ${g.admin2}` : g.name,
    };
  }

  function formatYmd(dateObj) {
    return dateObj.toISOString().slice(0, 10);
  }

  async function fetchDailyTemperatures(lat, lon, startDate, endDate) {
    const cacheKey = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const allCache = loadCache();
    const bucket = allCache[cacheKey] || { dates: {}, fetchedAt: 0 };

    const todayStr = formatYmd(new Date());
    const start = startDate || formatYmd(new Date(Date.now() - 60 * 86400000));
    const end = endDate && endDate <= todayStr ? endDate : todayStr;

    try {
      // Open-Meteo Archive lags ~2-5 days, so combine archive + recent forecast past_days
      const archiveEnd = formatYmd(new Date(Date.now() - 4 * 86400000));
      if (start <= archiveEnd) {
        const archUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${
          end < archiveEnd ? end : archiveEnd
        }&daily=temperature_2m_mean&timezone=Europe%2FLondon`;
        const archRes = await fetch(archUrl);
        if (archRes.ok) {
          const archData = await archRes.json();
          if (archData && archData.daily && archData.daily.time) {
            const times = archData.daily.time;
            const temps = archData.daily.temperature_2m_mean || [];
            for (let i = 0; i < times.length; i++) {
              if (temps[i] !== null && temps[i] !== undefined) {
                bucket.dates[times[i]] = { tempC: Number(temps[i]), source: 'open_meteo_archive' };
              }
            }
          }
        }
      }

      const recentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_mean&past_days=14&forecast_days=1&timezone=Europe%2FLondon`;
      const recRes = await fetch(recentUrl);
      if (recRes.ok) {
        const recData = await recRes.json();
        if (recData && recData.daily && recData.daily.time) {
          const times = recData.daily.time;
          const temps = recData.daily.temperature_2m_mean || [];
          for (let i = 0; i < times.length; i++) {
            if (temps[i] !== null && temps[i] !== undefined) {
              bucket.dates[times[i]] = { tempC: Number(temps[i]), source: 'open_meteo_recent' };
            }
          }
        }
      }

      bucket.fetchedAt = Date.now();
      allCache[cacheKey] = bucket;
      saveCache(allCache);
    } catch (_) {
      // Offline fallback: return cached dates seamlessly
    }

    return bucket.dates;
  }

  function getCachedWeather(lat, lon) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return {};
    const cacheKey = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const allCache = loadCache();
    return (allCache[cacheKey] && allCache[cacheKey].dates) || {};
  }

  return {
    resolveUkLocation,
    fetchDailyTemperatures,
    getCachedWeather,
  };
});
