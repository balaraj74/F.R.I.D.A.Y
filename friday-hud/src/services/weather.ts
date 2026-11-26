// Live weather for the header (Open-Meteo: free, no API key). Returns null when unavailable,
// so the HUD hides the widget instead of showing made-up numbers.

export interface Weather {
  tempC: number;
  label: string;
  isDay: boolean;
}

// Bengaluru; the header clock is labelled for the same city.
const LAT = 12.97;
const LON = 77.59;

// WMO weather interpretation codes (subset that covers every code Open-Meteo returns).
function describe(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

export async function fetchWeather(signal?: AbortSignal): Promise<Weather | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,is_day`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const cur = (await res.json())?.current;
    if (typeof cur?.temperature_2m !== 'number') return null;
    return { tempC: Math.round(cur.temperature_2m), label: describe(Number(cur.weather_code)), isDay: cur.is_day === 1 };
  } catch {
    return null;
  }
}

/** "2026.1.27-beta.1" -> "v2026.1.27 β" (the underlying model is never shown). */
export function versionBadge(version: string): string {
  const [core, pre] = version.split('-');
  return core ? `v${core}${pre?.startsWith('beta') ? ' β' : pre?.startsWith('alpha') ? ' α' : ''}` : '';
}
