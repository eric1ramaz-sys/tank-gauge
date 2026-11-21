/**
 * TankGauge Vision & Camera Module
 * On-device radial needle finder, synthetic Calor dial renderer, camera controls,
 * interactive canvas overlay editor, and optional Gemini Vision bill/meter scanner.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.TankVision = factory(root.TankEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TankEngine) {
  'use strict';

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function sampleBilinear(rgba, w, h, x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
      const cx = clamp(Math.round(x), 0, w - 1);
      const cy = clamp(Math.round(y), 0, h - 1);
      const idx = (cy * w + cx) * 4;
      return [rgba[idx], rgba[idx + 1], rgba[idx + 2]];
    }
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + w * 4;
    const i11 = i01 + 4;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    return [
      rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11,
      rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11,
      rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11,
    ];
  }

  function lumaAndRed(rgb) {
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const redness = r - 0.5 * (g + b);
    return { luma, redness };
  }

  /**
   * Pure pixel-buffer needle detector.
   * Scans radial profiles around (cx, cy) within calibration bounds.
   * 0 deg = 12 o'clock, positive = clockwise.
   */
  function detectDialNeedleFromRGBA(rgbaData, width, height, cx, cy, radius, calibration) {
    const cal = TankEngine.resolveCalibration(calibration);
    const startScan = cal.startDeg + cal.rotationDeg - 4;
    const endScan = cal.endDeg + cal.rotationDeg + 4;
    const stepDeg = 0.5;

    // Sample 12 radial points inside the clean dial face (inside outer tick ring & numbers)
    const radialSteps = [0.18, 0.23, 0.28, 0.33, 0.38, 0.43, 0.48, 0.53, 0.58, 0.63, 0.68, 0.72];
    const outerReachStartIdx = 6; // >= 0.48 * R distinguishes tip from short counterweight tail

    const candidates = [];

    for (let deg = startScan; deg <= endScan + 0.001; deg += stepDeg) {
      const subRays = [
        { w: 0.25, rad: ((deg - 0.8) * Math.PI) / 180 },
        { w: 0.5, rad: (deg * Math.PI) / 180 },
        { w: 0.25, rad: ((deg + 0.8) * Math.PI) / 180 },
      ].map((sr) => ({ w: sr.w, dx: Math.sin(sr.rad), dy: -Math.cos(sr.rad) }));

      // Flanking angles at +-9 deg and +-16 deg for local background comparison (handles glass glare!)
      const flankAngles = [-16, -9, 9, 16].map((offset) => {
        const fr = ((deg + offset) * Math.PI) / 180;
        return { dx: Math.sin(fr), dy: -Math.cos(fr) };
      });

      let innerSum = 0;
      let outerSum = 0;
      let hits = 0;

      for (let i = 0; i < radialSteps.length; i++) {
        const rPx = radialSteps[i] * radius;

        let centerLuma = 0;
        let centerRed = 0;
        for (let s = 0; s < subRays.length; s++) {
          const px = cx + subRays[s].dx * rPx;
          const py = cy + subRays[s].dy * rPx;
          const cs = lumaAndRed(sampleBilinear(rgbaData, width, height, px, py));
          centerLuma += cs.luma * subRays[s].w;
          centerRed += cs.redness * subRays[s].w;
        }

        let flankLumaSum = 0;
        let flankRedSum = 0;
        for (let f = 0; f < flankAngles.length; f++) {
          const fx = cx + flankAngles[f].dx * rPx;
          const fy = cy + flankAngles[f].dy * rPx;
          const fs = lumaAndRed(sampleBilinear(rgbaData, width, height, fx, fy));
          flankLumaSum += fs.luma;
          flankRedSum += fs.redness;
        }
        const flankLuma = flankLumaSum / flankAngles.length;
        const flankRed = flankRedSum / flankAngles.length;

        const darkContrast = Math.max(0, flankLuma - centerLuma);
        const redContrast = Math.max(0, centerRed - flankRed) * 0.9;
        const ptScore = Math.max(darkContrast, redContrast);

        if (ptScore > 9) hits += 1;
        if (i < outerReachStartIdx) {
          innerSum += ptScore;
        } else {
          // Outer reach weighted slightly higher so long needle tip beats short counterweight
          outerSum += ptScore * 1.4;
        }
      }

      const consistency = hits / radialSteps.length;
      const continuityBonus = consistency >= 0.7 ? 1.3 : consistency >= 0.45 ? 1.0 : 0.45;
      const rawScore = ((innerSum + outerSum) / radialSteps.length) * continuityBonus;

      // Penalise if outer reach is near zero (likely counterweight tail or logo)
      const outerAvg = outerSum / (radialSteps.length - outerReachStartIdx);
      const score = outerAvg < 5 ? rawScore * 0.25 : rawScore;

      candidates.push({ deg, score });
    }

    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > candidates[bestIdx].score) {
        bestIdx = i;
      }
    }

    // Weighted sub-step centroid over immediate neighbours +-1.5 deg
    const bestAngleRaw = candidates[bestIdx].deg;
    const bestScore = candidates[bestIdx].score;
    let wSum = 0;
    let aSum = 0;
    for (let i = Math.max(0, bestIdx - 3); i <= Math.min(candidates.length - 1, bestIdx + 3); i++) {
      const w = Math.max(0, candidates[i].score - bestScore * 0.45);
      wSum += w;
      aSum += candidates[i].deg * w;
    }
    const refinedAngle = wSum > 0 ? aSum / wSum : bestAngleRaw;

    // Second-best distinct peak (> 18 deg away) for confidence rating
    let secondBest = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (Math.abs(candidates[i].deg - bestAngleRaw) > 18 && candidates[i].score > secondBest) {
        secondBest = candidates[i].score;
      }
    }

    const confidence =
      bestScore <= 3
        ? 0.1
        : clamp((bestScore - secondBest) / Math.max(10, bestScore), 0.12, 0.99);

    const normalizedAngle = TankEngine.normalizeAngle180(refinedAngle);
    const percent = TankEngine.angleDegToPercent(normalizedAngle, cal);

    return {
      angleDeg: TankEngine.roundTo(normalizedAngle, 2),
      percent,
      confidence: TankEngine.roundTo(confidence, 2),
    };
  }

  /**
   * Pure pixel-buffer synthetic Calor Rochester dial renderer.
   * Used for Node verification tests and as base texture when needed.
   */
  function renderSyntheticDialToRGBA(width, height, targetPercent, calibration, options) {
    const opts = options || {};
    const shaded = Boolean(opts.shaded);
    const cal = TankEngine.resolveCalibration(calibration);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) * 0.44;
    const needleDeg = TankEngine.percentToAngleDeg(targetPercent, cal);
    const needleRad = (needleDeg * Math.PI) / 180;
    const nx = Math.sin(needleRad);
    const ny = -Math.cos(needleRad);

    function setPx(x, y, r, g, b) {
      let rr = r;
      let gg = g;
      let bb = b;
      if (shaded) {
        // Simulate dim green Calor lid lighting + hazy reflection
        rr = rr * 0.42 + 18;
        gg = gg * 0.45 + 22;
        bb = bb * 0.42 + 20;
      }
      const idx = (y * width + x) * 4;
      rgba[idx] = clamp(Math.round(rr), 0, 255);
      rgba[idx + 1] = clamp(Math.round(gg), 0, 255);
      rgba[idx + 2] = clamp(Math.round(bb), 0, 255);
      rgba[idx + 3] = 255;
    }

    const startRedRel = cal.startDeg;
    const endRedRel =
      cal.startDeg + ((25 - cal.minPct) / Math.max(1, cal.maxPct - cal.minPct)) * (cal.endDeg - cal.startDeg);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);

        // Background outside dial
        let r = 212;
        let g = 218;
        let b = 224;

        if (dist <= R * 1.08 && dist > R * 0.96) {
          // Metallic bezel rim
          r = 105;
          g = 114;
          b = 125;
        } else if (dist <= R * 0.96) {
          // Off-white dial face
          r = 247;
          g = 248;
          b = 246;

          // Angle in degrees (0 at top, clockwise positive)
          const ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
          const relAng = TankEngine.normalizeAngle180(ang - cal.rotationDeg);

          // Red warning arc (< 25%) near outer band
          if (dist >= R * 0.78 && dist <= R * 0.91 && relAng >= startRedRel && relAng <= endRedRel) {
            r = 220;
            g = 52;
            b = 45;
          }

          // Outer tick marks every 5%
          if (dist >= R * 0.78 && dist <= R * 0.92) {
            for (let p = cal.minPct; p <= cal.maxPct; p += 5) {
              const tDeg = TankEngine.percentToAngleDeg(p, cal);
              if (Math.abs(TankEngine.normalizeAngle180(ang - tDeg)) <= (p % 10 === 0 ? 1.1 : 0.6)) {
                r = 28;
                g = 34;
                b = 42;
                break;
              }
            }
          }

          // Subtle diagonal glass reflection sheen across upper-left quadrant
          const glareDist = Math.abs((dx + dy) * 0.707 + R * 0.22);
          if (glareDist < R * 0.14) {
            const lift = (1 - glareDist / (R * 0.14)) * 18;
            r += lift;
            g += lift;
            b += lift;
          }

          // Tapered needle tip + short counterweight tail
          const proj = dx * nx + dy * ny;
          const perp = Math.abs(dx * -ny + dy * nx);

          if (proj >= -R * 0.23 && proj <= R * 0.77) {
            const halfWidth =
              proj >= 0
                ? Math.max(1.2, (1 - proj / (R * 0.85)) * (R * 0.048))
                : R * 0.044;
            if (perp <= halfWidth) {
              r = 22;
              g = 26;
              b = 34;
            }
          }

          // Center brass/dark pivot cap
          if (dist <= R * 0.11) {
            r = 45;
            g = 52;
            b = 62;
          } else if (dist <= R * 0.05) {
            r = 190;
            g = 152;
            b = 85;
          }
        }

        setPx(x, y, r, g, b);
      }
    }

    return rgba;
  }

  /**
   * Browser Canvas2D synthetic Calor Rochester dial renderer (with readable numbers & glare).
   */
  function renderSyntheticDial(canvas, targetPercent, calibration) {
    const cal = TankEngine.resolveCalibration(calibration);
    const size = canvas.width || 420;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.44;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#d4dae0';
    ctx.fillRect(0, 0, size, size);

    // Metallic housing & bezel
    const rimGrad = ctx.createLinearGradient(0, 0, size, size);
    rimGrad.addColorStop(0, '#94a3b8');
    rimGrad.addColorStop(0.5, '#475569');
    rimGrad.addColorStop(1, '#64748b');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2);
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Dial face
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.96, 0, Math.PI * 2);
    ctx.fillStyle = '#f7f8f6';
    ctx.fill();

    // Red < 25% zone arc
    const startRedRad = ((TankEngine.percentToAngleDeg(cal.minPct, cal) - 90) * Math.PI) / 180;
    const endRedRad = ((TankEngine.percentToAngleDeg(25, cal) - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.85, startRedRad, endRedRad);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = R * 0.085;
    ctx.stroke();

    // Ticks & numbers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(R * 0.11)}px system-ui, sans-serif`;
    for (let p = cal.minPct; p <= cal.maxPct; p += 5) {
      const deg = TankEngine.percentToAngleDeg(p, cal);
      const rad = (deg * Math.PI) / 180;
      const isMajor = p % 10 === 0 || p === cal.minPct || p === cal.maxPct;
      const rIn = isMajor ? R * 0.77 : R * 0.83;
      const rOut = R * 0.91;

      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(rad) * rIn, cy - Math.cos(rad) * rIn);
      ctx.lineTo(cx + Math.sin(rad) * rOut, cy - Math.cos(rad) * rOut);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = isMajor ? 2.8 : 1.5;
      ctx.stroke();

      if (p % 10 === 0 || p === 5 || p === 95) {
        const rTxt = R * 0.65;
        ctx.fillStyle = p <= 20 ? '#b91c1c' : '#1e293b';
        ctx.fillText(String(p), cx + Math.sin(rad) * rTxt, cy - Math.cos(rad) * rTxt);
      }
    }

    // Dial text label
    ctx.fillStyle = '#475569';
    ctx.font = `700 ${Math.round(R * 0.075)}px system-ui, sans-serif`;
    ctx.fillText('% TANK CAPACITY', cx, cy + R * 0.44);

    // Tapered needle + counterweight
    const nDeg = TankEngine.percentToAngleDeg(targetPercent, cal);
    const nRad = (nDeg * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(nRad);
    ctx.beginPath();
    ctx.moveTo(-R * 0.042, R * 0.22);
    ctx.lineTo(R * 0.042, R * 0.22);
    ctx.lineTo(R * 0.012, -R * 0.76);
    ctx.lineTo(-R * 0.012, -R * 0.76);
    ctx.closePath();
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.restore();

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#d97706';
    ctx.fill();

    // Soft glass glare streak
    const glare = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
    glare.addColorStop(0, 'rgba(255,255,255,0.22)');
    glare.addColorStop(0.45, 'rgba(255,255,255,0.03)');
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.96, 0, Math.PI * 2);
    ctx.fillStyle = glare;
    ctx.fill();
  }

  function compressPhotoBlob(sourceCanvas, maxDim, quality) {
    const dim = maxDim || 480;
    const q = quality || 0.82;
    const w = sourceCanvas.width || dim;
    const h = sourceCanvas.height || dim;
    const scale = Math.min(1, dim / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const tmp = document.createElement('canvas');
    tmp.width = tw;
    tmp.height = th;
    tmp.getContext('2d').drawImage(sourceCanvas, 0, 0, tw, th);
    return tmp.toDataURL('image/jpeg', q);
  }

  /**
   * Interactive Dial Overlay Controller:
   * Supports 2-step flow: (1) Fit Dial in Ring (pan/zoom/straighten) -> (2) Confirm Needle.
   */
  class DialOverlayController {
    constructor(canvas, onPercentChange, onFitChange) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onPercentChange = onPercentChange;
      this.onFitChange = onFitChange || null;
      this.rawCanvas = null;
      this.sourceCanvas = null;
      this.calibration = TankEngine.resolveCalibration(null);
      this.size = 420;
      this.cx = 210;
      this.cy = 210;
      this.radius = Math.round(420 * 0.42);
      this.photoZoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.photoRotDeg = 0;
      this.mode = 'needle'; // 'fit' | 'needle' | 'map'
      this.percent = 50;
      this.angleDeg = 0;
      this.MAP_STEPS = ['PIN', '20', '50', '80'];
      this.mapPin = null;
      this.mapMarks = [];
      this.onMapProgress = null;
      this._activeDragPart = null; // 'center' | 'needle' | null
      this._pointers = new Map();
      this._lastPanPos = null;
      this._pinchStartDist = 0;
      this._pinchStartZoom = 1;
      this._bindEvents();
    }

    _bindEvents() {
      const getPos = (evt) => {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / Math.max(1, rect.width);
        const scaleY = this.canvas.height / Math.max(1, rect.height);
        return {
          x: (evt.clientX - rect.left) * scaleX,
          y: (evt.clientY - rect.top) * scaleY,
        };
      };

      const onDown = (evt) => {
        if (!this.sourceCanvas) return;
        evt.preventDefault();
        const pos = getPos(evt);

        if (this.mode === 'map') {
          if (!this.mapPin) {
            this.mapPin = { x: pos.x, y: pos.y };
            this.render();
            if (this.onMapProgress) {
              this.onMapProgress({ stepIndex: 1, targetLabel: '20', done: false });
            }
            return;
          }

          const dx = pos.x - this.mapPin.x;
          const dy = pos.y - this.mapPin.y;
          if (Math.hypot(dx, dy) < 12) return;
          const angleDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
          const label = this.MAP_STEPS[this.mapMarks.length + 1] || '80';
          this.mapMarks.push({ label, x: pos.x, y: pos.y, angleDeg });
          this.render();

          if (this.mapMarks.length < 3) {
            if (this.onMapProgress) {
              this.onMapProgress({
                stepIndex: this.mapMarks.length + 1,
                targetLabel: this.MAP_STEPS[this.mapMarks.length + 1],
                done: false,
              });
            }
          } else {
            const marks = this.mapMarks.slice();
            const pin = this.mapPin;
            const result = TankEngine.calibrateFromThreeMarks(
              marks[0].angleDeg,
              marks[1].angleDeg,
              marks[2].angleDeg,
              this.calibration
            );

            if (result && result.ok && pin) {
              // Auto-center the fitted photo onto the true physical needle pin
              this.panX += this.size / 2 - pin.x;
              this.panY += this.size / 2 - pin.y;
              this.cx = this.size / 2;
              this.cy = this.size / 2;
              this.rebuildFittedCanvas();
            }

            this.mode = 'needle';
            this.mapPin = null;
            this.mapMarks = [];
            this.render();
            if (this.onMapProgress) {
              this.onMapProgress({ done: true, result });
            }
          }
          return;
        }

        this._pointers.set(evt.pointerId, pos);

        if (this.mode === 'fit') {
          if (this._pointers.size === 1) {
            this._lastPanPos = pos;
          } else if (this._pointers.size === 2) {
            const pts = Array.from(this._pointers.values());
            this._pinchStartDist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
            this._pinchStartZoom = this.photoZoom;
          }
        } else {
          const distFromCenter = Math.hypot(pos.x - this.cx, pos.y - this.cy);
          if (distFromCenter <= 26) {
            this._activeDragPart = 'center';
          } else {
            this._activeDragPart = 'needle';
            const deg = (Math.atan2(pos.x - this.cx, -(pos.y - this.cy)) * 180) / Math.PI;
            this.setAngle(deg);
          }
        }
      };

      const onMove = (evt) => {
        if (!this._pointers.has(evt.pointerId) || !this.sourceCanvas) return;
        evt.preventDefault();
        const pos = getPos(evt);
        this._pointers.set(evt.pointerId, pos);

        if (this.mode === 'fit') {
          if (this._pointers.size >= 2) {
            const pts = Array.from(this._pointers.values());
            const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
            this.photoZoom = clamp(this._pinchStartZoom * (dist / this._pinchStartDist), 1, 6);
            this.rebuildFittedCanvas();
            this.render();
            if (this.onFitChange) {
              this.onFitChange({ zoom: this.photoZoom, rotationDeg: this.photoRotDeg });
            }
          } else if (this._lastPanPos) {
            const maxPan = this.size * this.photoZoom * 0.65;
            this.panX = clamp(this.panX + (pos.x - this._lastPanPos.x), -maxPan, maxPan);
            this.panY = clamp(this.panY + (pos.y - this._lastPanPos.y), -maxPan, maxPan);
            this._lastPanPos = pos;
            this.rebuildFittedCanvas();
            this.render();
          }
        } else if (this._activeDragPart === 'center') {
          this.cx = clamp(pos.x, this.size * 0.18, this.size * 0.82);
          this.cy = clamp(pos.y, this.size * 0.18, this.size * 0.82);
          this.render();
        } else if (this._activeDragPart === 'needle') {
          const dx = pos.x - this.cx;
          const dy = pos.y - this.cy;
          if (Math.hypot(dx, dy) >= 8) {
            const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
            this.setAngle(deg);
          }
        }
      };

      const onUp = (evt) => {
        this._pointers.delete(evt.pointerId);
        if (this.mode === 'fit' && this._pointers.size === 1) {
          this._lastPanPos = Array.from(this._pointers.values())[0];
        } else if (this._pointers.size === 0) {
          this._lastPanPos = null;
        }
        if (this.mode === 'needle' && this._activeDragPart === 'center') {
          this._activeDragPart = null;
          this.runAutoDetect();
        } else {
          this._activeDragPart = null;
        }
      };

      this.canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    setRawImage(sourceCanvas, calibration, opts) {
      const options = opts || {};
      this.calibration = TankEngine.resolveCalibration(calibration);
      this.size = 420;
      this.canvas.width = this.size;
      this.canvas.height = this.size;

      // Preserve high-res source up to 1400px longest side for crisp zooming
      const sw = sourceCanvas.width || 420;
      const sh = sourceCanvas.height || 420;
      const maxEdge = Math.max(sw, sh);
      const scale = maxEdge > 1400 ? 1400 / maxEdge : 1;
      const rw = Math.max(1, Math.round(sw * scale));
      const rh = Math.max(1, Math.round(sh * scale));
      const raw = document.createElement('canvas');
      raw.width = rw;
      raw.height = rh;
      raw.getContext('2d').drawImage(sourceCanvas, 0, 0, rw, rh);
      this.rawCanvas = raw;

      this.photoZoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.photoRotDeg = 0;
      this.cx = this.size / 2;
      this.cy = this.size / 2;
      this.radius = this.size * 0.42;

      this.rebuildFittedCanvas();
      if (this.onFitChange) {
        this.onFitChange({ zoom: this.photoZoom, rotationDeg: this.photoRotDeg });
      }

      if (options.startInFitMode) {
        this.mode = 'fit';
        this.render();
      } else {
        this.mode = 'needle';
        if (options.initialResult) {
          this.angleDeg = options.initialResult.angleDeg;
          this.percent = options.initialResult.percent;
          this.render();
        } else {
          this.runAutoDetect();
        }
      }
    }

    setImage(sourceCanvas, calibration, initialResult) {
      this.setRawImage(sourceCanvas, calibration, { startInFitMode: false, initialResult });
    }

    rebuildFittedCanvas() {
      if (!this.rawCanvas) return;
      const sq = this.sourceCanvas || document.createElement('canvas');
      sq.width = this.size;
      sq.height = this.size;
      const sctx = sq.getContext('2d');
      sctx.fillStyle = '#0f172a';
      sctx.fillRect(0, 0, this.size, this.size);

      const rw = this.rawCanvas.width;
      const rh = this.rawCanvas.height;
      const baseScale = this.size / Math.min(rw, rh);
      const totalScale = baseScale * this.photoZoom;

      sctx.save();
      sctx.translate(this.size / 2 + this.panX, this.size / 2 + this.panY);
      sctx.rotate((this.photoRotDeg * Math.PI) / 180);
      sctx.scale(totalScale, totalScale);
      sctx.drawImage(this.rawCanvas, -rw / 2, -rh / 2);
      sctx.restore();
      this.sourceCanvas = sq;
    }

    setPhotoZoom(z) {
      this.photoZoom = clamp(Number(z) || 1, 1, 6);
      this.rebuildFittedCanvas();
      this.render();
    }

    setPhotoRotation(deg) {
      this.photoRotDeg = clamp(Number(deg) || 0, -45, 45);
      this.rebuildFittedCanvas();
      this.render();
    }

    setMode(mode) {
      this.mode = mode === 'fit' ? 'fit' : mode === 'map' ? 'map' : 'needle';
      this.render();
    }

    startDialMap(onMapProgress) {
      this.mode = 'map';
      this.mapPin = null;
      this.mapMarks = [];
      this.onMapProgress = onMapProgress || null;
      this.render();
      if (this.onMapProgress) {
        this.onMapProgress({ stepIndex: 0, targetLabel: 'PIN', done: false });
      }
    }

    cancelDialMap() {
      this.mode = 'needle';
      this.mapPin = null;
      this.mapMarks = [];
      this.render();
    }

    getFittedCanvas() {
      return this.sourceCanvas;
    }

    runAutoDetect() {
      if (!this.sourceCanvas) return null;
      const imgData = this.sourceCanvas
        .getContext('2d')
        .getImageData(0, 0, this.size, this.size);
      const res = detectDialNeedleFromRGBA(
        imgData.data,
        this.size,
        this.size,
        this.cx,
        this.cy,
        this.radius,
        this.calibration
      );
      this.angleDeg = res.angleDeg;
      this.percent = res.percent;
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent, res.confidence);
      return res;
    }

    setCalibration(calibration) {
      this.calibration = TankEngine.resolveCalibration(calibration);
      this.percent = TankEngine.angleDegToPercent(this.angleDeg, this.calibration);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    setPercent(pct) {
      const cal = this.calibration;
      this.percent = TankEngine.roundTo(clamp(pct, cal.minPct, cal.maxPct), 1);
      this.angleDeg = TankEngine.percentToAngleDeg(this.percent, cal);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    nudge(deltaPct) {
      this.setPercent(this.percent + deltaPct);
    }

    setAngle(deg) {
      this.angleDeg = TankEngine.normalizeAngle180(deg);
      this.percent = TankEngine.angleDegToPercent(this.angleDeg, this.calibration);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    render() {
      const ctx = this.ctx;
      const size = this.size;
      ctx.clearRect(0, 0, size, size);
      if (!this.sourceCanvas) return;

      ctx.drawImage(this.sourceCanvas, 0, 0);

      if (this.mode === 'fit') {
        ctx.save();
        // Darken outer margin outside target circle using even-odd cutout
        ctx.fillStyle = 'rgba(15, 23, 42, 0.52)';
        ctx.beginPath();
        ctx.rect(0, 0, size, size);
        ctx.arc(this.cx, this.cy, this.radius, 0, Math.PI * 2, true);
        ctx.fill('evenodd');

        // Crisp amber target circle
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, this.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Center pivot crosshair
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(this.cx - 12, this.cy);
        ctx.lineTo(this.cx + 12, this.cy);
        ctx.moveTo(this.cx, this.cy - 12);
        ctx.lineTo(this.cx, this.cy + 12);
        ctx.stroke();

        // Top 12 o'clock marker
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(this.cx - 34, this.cy - this.radius - 18, 68, 20);
        ctx.fillStyle = '#0f172a';
        ctx.font = '800 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('50% TOP', this.cx, this.cy - this.radius - 8);
        ctx.restore();
        return;
      }

      if (this.mode === 'map') {
        const pinX = this.mapPin ? this.mapPin.x : this.cx;
        const pinY = this.mapPin ? this.mapPin.y : this.cy;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
        ctx.beginPath();
        ctx.rect(0, 0, size, size);
        ctx.arc(pinX, pinY, this.radius, 0, Math.PI * 2, true);
        ctx.fill('evenodd');

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(pinX, pinY, this.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (this.mapPin) {
          // Crisp orange/white bullseye pin at tapped physical pivot
          ctx.beginPath();
          ctx.arc(this.mapPin.x, this.mapPin.y, 12, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(234, 88, 12, 0.25)';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#fb923c';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(this.mapPin.x, this.mapPin.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else {
          // Faint guide dot before first tap
          ctx.beginPath();
          ctx.arc(this.cx, this.cy, 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.fill();
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        for (let i = 0; i < this.mapMarks.length; i++) {
          const mk = this.mapMarks[i];
          ctx.beginPath();
          ctx.arc(mk.x, mk.y, 13, 0, Math.PI * 2);
          ctx.fillStyle = '#0284c7';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = '800 11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(mk.label, mk.x, mk.y);
        }
        ctx.restore();
        return;
      }

      // Needle confirm mode: subtle translucent ring + 10% ticks + glowing needle
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (let p = this.calibration.minPct; p <= this.calibration.maxPct; p += 10) {
        const deg = TankEngine.percentToAngleDeg(p, this.calibration);
        const rad = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(this.cx + Math.sin(rad) * (this.radius * 0.92), this.cy - Math.cos(rad) * (this.radius * 0.92));
        ctx.lineTo(this.cx + Math.sin(rad) * (this.radius * 1.03), this.cy - Math.cos(rad) * (this.radius * 1.03));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      const nRad = (this.angleDeg * Math.PI) / 180;
      const tipX = this.cx + Math.sin(nRad) * (this.radius * 0.92);
      const tipY = this.cy - Math.cos(nRad) * (this.radius * 0.92);

      ctx.shadowColor = 'rgba(234, 88, 12, 0.9)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(this.cx, this.cy);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ea580c';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(this.cx, this.cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.restore();
    }
  }

  /**
   * Guided Camera Controller with Hardware+Digital Zoom, Torch, Tilt Level & Tight Ring Crop.
   */
  class CameraController {
    constructor(videoEl) {
      this.videoEl = videoEl;
      this.stream = null;
      this.track = null;
      this.torchOn = false;
      this.onTiltUpdate = null;
      this._orientHandler = null;
      this.hwZoomMin = 1;
      this.hwZoomMax = 1;
      this.hasHwZoom = false;
      this.digitalZoom = 1;
      this.totalZoom = 1;
      this.ringDiameterRatio = 0.54;
    }

    async start() {
      this.stop();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Live camera not available in this browser — use Pick Saved Photo below.');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      this.videoEl.style.transformOrigin = 'center center';
      await this.videoEl.play();
      this.track = this.stream.getVideoTracks()[0] || null;
      const caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {};
      this.hasHwZoom = Boolean(caps && caps.zoom && caps.zoom.max > 1);
      this.hwZoomMin = this.hasHwZoom ? caps.zoom.min || 1 : 1;
      this.hwZoomMax = this.hasHwZoom ? Math.min(5, caps.zoom.max) : 1;

      await this.setZoom(2.0);
      return {
        hasZoom: true,
        zoomMin: 1,
        zoomMax: 5,
        zoomStep: 0.1,
        defaultZoom: 2.0,
        hasTorch: Boolean(caps && caps.torch),
      };
    }

    async setZoom(val) {
      const target = clamp(Number(val) || 1, 1, 5);
      this.totalZoom = target;
      let hwApplied = 1;

      if (this.hasHwZoom && this.track && this.track.applyConstraints) {
        hwApplied = clamp(target, this.hwZoomMin, this.hwZoomMax);
        try {
          await this.track.applyConstraints({ advanced: [{ zoom: hwApplied }] });
        } catch (_) {
          hwApplied = 1;
        }
      }

      this.digitalZoom = Math.max(1, target / hwApplied);
      if (this.videoEl) {
        this.videoEl.style.transform =
          this.digitalZoom > 1.01 ? `scale(${this.digitalZoom.toFixed(3)})` : '';
      }
    }

    async toggleTorch() {
      if (!this.track || !this.track.applyConstraints) return false;
      this.torchOn = !this.torchOn;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      } catch (_) {
        this.torchOn = false;
      }
      return this.torchOn;
    }

    startTiltSensor(callback) {
      this.onTiltUpdate = callback;
      if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
      if (this._orientHandler) window.removeEventListener('deviceorientation', this._orientHandler);
      this._orientHandler = (e) => {
        if (e.beta === null || e.gamma === null) return;
        const tiltDeg = Math.round(Math.hypot(e.gamma || 0, Math.abs(e.beta || 0) > 60 ? 90 - Math.abs(e.beta) : e.beta));
        if (this.onTiltUpdate) this.onTiltUpdate(tiltDeg);
      };
      window.addEventListener('deviceorientation', this._orientHandler, { passive: true });
    }

    captureFrame() {
      if (!this.videoEl || !this.videoEl.videoWidth) return null;
      const vw = this.videoEl.videoWidth;
      const vh = this.videoEl.videoHeight;
      // Crop strictly around the 54% amber reticle ring so dial fills 84% of captured frame (matches overlay 1:1)
      const visibleSide = Math.min(vw, vh) / Math.max(1, this.digitalZoom);
      const cropSide = Math.min(vw, vh, visibleSide * (this.ringDiameterRatio / 0.84));
      const sx = (vw - cropSide) / 2;
      const sy = (vh - cropSide) / 2;
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 640;
      out.getContext('2d').drawImage(this.videoEl, sx, sy, cropSide, cropSide, 0, 0, 640, 640);
      return out;
    }

    stop() {
      if (this._orientHandler && typeof window !== 'undefined') {
        window.removeEventListener('deviceorientation', this._orientHandler);
        this._orientHandler = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.track = null;
        this.torchOn = false;
      }
      this.digitalZoom = 1;
      this.totalZoom = 1;
      if (this.videoEl) {
        this.videoEl.style.transform = '';
        this.videoEl.srcObject = null;
      }
    }
  }

  return {
    detectDialNeedleFromRGBA,
    renderSyntheticDialToRGBA,
    renderSyntheticDial,
    compressPhotoBlob,
    DialOverlayController,
    CameraController,
  };
});
