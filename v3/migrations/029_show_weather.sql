-- Migration 029: per-show daily weather cache.
--
-- Mirrors the v2 show_weather table — one row per (show, date), updated
-- on re-fetch. Historical readings are persisted (Open-Meteo archive).
-- Forecast values are NOT persisted by /v3/getShowWeather — they change
-- daily and re-fetching is cheap.
--
-- Used by /v3/getShowWeather to avoid re-hitting Open-Meteo on every page
-- load and to keep historical weather available for completed shows.

CREATE TABLE IF NOT EXISTS show_weather (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id       INTEGER NOT NULL,
  date          TEXT NOT NULL,           -- ISO YYYY-MM-DD
  temp_high     REAL,                    -- °F
  temp_low      REAL,                    -- °F
  weather_code  INTEGER,                 -- WMO code (0=clear, 95=thunderstorm, etc.)
  precip_mm     REAL,                    -- daily precipitation, mm
  wind_max      REAL,                    -- daily max windspeed, mph
  humidity_mean REAL,                    -- daily mean relative humidity, %
  source        TEXT DEFAULT 'open-meteo',
  updated_at    TEXT,
  UNIQUE(show_id, date)
);

CREATE INDEX IF NOT EXISTS idx_show_weather_show ON show_weather(show_id);
