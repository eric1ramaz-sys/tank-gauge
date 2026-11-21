"""Generate PWA icons, manifest.json, sw.js, and QR code for TankGauge."""

import json
import math
import os
from PIL import Image, ImageDraw
import qrcode

APP_DIR = os.path.dirname(os.path.abspath(__file__))
LIVE_URL = "https://eric1ramaz-sys.github.io/tank-gauge/"

BG_SLATE = (15, 23, 42, 255)      # #0F172A
DAY_BG = (244, 246, 249, 255)     # #F4F6F9
SURFACE_SLATE = (30, 41, 59, 255) # #1E293B
FLAME = (234, 88, 12, 255)        # #EA580C
AMBER = (245, 158, 11, 255)       # #F59E0B
DIAL_FACE = (248, 250, 252, 255)  # #F8FAFC
RED_ZONE = (220, 38, 38, 255)     # #DC2626


def create_icon(size: int, filename: str, opaque: bool = False):
    """Draw a high-contrast Slate & Flame Calor tank gauge icon."""
    mode = "RGB" if opaque else "RGBA"
    bg = BG_SLATE[:3] if opaque else BG_SLATE
    surface = SURFACE_SLATE[:3] if opaque else SURFACE_SLATE
    flame = FLAME[:3] if opaque else FLAME
    amber = AMBER[:3] if opaque else AMBER
    face = DIAL_FACE[:3] if opaque else DIAL_FACE
    red_z = RED_ZONE[:3] if opaque else RED_ZONE

    img = Image.new(mode, (size, size), bg)
    draw = ImageDraw.Draw(img)

    margin = int(size * 0.08)
    border_w = max(4, int(size * 0.032))
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=int(size * 0.22),
        fill=surface,
        outline=amber,
        width=border_w,
    )

    cx = size * 0.5
    cy = size * 0.52
    r = size * 0.31

    # Dial circle
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=face, outline=amber, width=max(3, int(size * 0.025)))

    # Arc track & low-fuel red arc (Pil uses 0 deg = 3 o'clock clockwise)
    arc_r = r * 0.78
    bbox = [cx - arc_r, cy - arc_r, cx + arc_r, cy + arc_r]
    arc_w = max(4, int(size * 0.045))
    draw.arc(bbox, start=130, end=195, fill=red_z, width=arc_w)
    draw.arc(bbox, start=198, end=310, fill=amber, width=arc_w)

    # Flame-orange needle pointing around 60% (clockwise ~+30 deg from 12 o'clock)
    angle_rad = math.radians(32)
    tip_x = cx + math.sin(angle_rad) * (r * 0.70)
    tip_y = cy - math.cos(angle_rad) * (r * 0.70)
    tail_x = cx - math.sin(angle_rad) * (r * 0.20)
    tail_y = cy + math.cos(angle_rad) * (r * 0.20)
    perp_x = math.cos(angle_rad) * (size * 0.032)
    perp_y = math.sin(angle_rad) * (size * 0.032)

    draw.polygon(
        [
            (tail_x - perp_x, tail_y - perp_y),
            (tail_x + perp_x, tail_y + perp_y),
            (tip_x + perp_x * 0.28, tip_y + perp_y * 0.28),
            (tip_x - perp_x * 0.28, tip_y - perp_y * 0.28),
        ],
        fill=flame,
    )

    hub_r = size * 0.065
    draw.ellipse([cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r], fill=bg)

    img.save(os.path.join(APP_DIR, filename), "PNG")


def create_qr(url: str, filename: str, target_size: int = 400):
    """Generate a high-contrast scannable QR code PNG with quiet zone."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="#0F172A", back_color="#FFFFFF").convert("RGB")
    qr_img = qr_img.resize((target_size, target_size), Image.Resampling.NEAREST)
    qr_img.save(os.path.join(APP_DIR, filename), "PNG")


def write_manifest():
    manifest = {
        "name": "TankGauge — Calor & UK LPG Tracker",
        "short_name": "TankGauge",
        "description": "Snap your Calor tank dial, track real daily & monthly £ spend, and cut LPG heating bills.",
        "start_url": "./index.html",
        "scope": "./",
        "display": "standalone",
        "orientation": "portrait-primary",
        "background_color": "#F4F6F9",
        "theme_color": "#0F172A",
        "icons": [
            {
                "src": "./icon-192.png",
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any maskable",
            },
            {
                "src": "./icon-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any maskable",
            },
        ],
    }
    with open(os.path.join(APP_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)


def write_service_worker():
    sw_code = """const CACHE_NAME = 'tank-gauge-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './engine.js',
  './vision.js',
  './weather.js',
  './charts.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './qr_tank_gauge.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Never hijack external API calls (Open-Meteo, postcodes.io, Gemini)
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
"""
    with open(os.path.join(APP_DIR, "sw.js"), "w", encoding="utf-8") as f:
        f.write(sw_code)


def main():
    create_icon(192, "icon-192.png", opaque=False)
    create_icon(512, "icon-512.png", opaque=False)
    create_icon(180, "apple-touch-icon.png", opaque=True)
    create_qr(LIVE_URL, "qr_tank_gauge.png", target_size=400)
    write_manifest()
    write_service_worker()
    print("Generated TankGauge PWA icons, manifest.json, sw.js, and qr_tank_gauge.png successfully.")


if __name__ == "__main__":
    main()
