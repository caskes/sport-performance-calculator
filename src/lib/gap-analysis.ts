/*
 * Gap Analysis — current vs. required fitness for a preset event.
 *
 * Apple Shortcut curl equivalent for POST /api/fitness-intake:
 *
 *   curl -X POST https://aptoflux.aiconcepts.studio/api/fitness-intake \
 *     -H "Content-Type: application/json" \
 *     -H "X-Sync-Token: <your-token>" \
 *     -d '{
 *       "date": "2026-03-27",
 *       "source": "apple-shortcut",
 *       "sport": "cycling",
 *       "effort_distance_km": 80,
 *       "effort_time_min": 180,
 *       "weekly_hours": 8,
 *       "longest_session_h": 3.5,
 *       "fatigue_level": 2,
 *       "age": 38,
 *       "resting_heart_rate": 52,
 *       "recent_vo2max_estimate": 48,
 *       "avg_hrv_7day": 58,
 *       "weekly_active_calories": 3200
 *     }'
 */

export interface FitnessIntake {
  date: string;
  source: 'manual' | 'apple-shortcut';
  sport: 'cycling' | 'running' | 'both';
  effort_distance_km: number;
  effort_time_min: number;
  weekly_hours: number;
  longest_session_h: number;
  fatigue_level: number;
  age: number;
  resting_heart_rate?: number;
  recent_vo2max_estimate?: number;
  avg_hrv_7day?: number;
  weekly_active_calories?: number;
}

export interface GoalSelection {
  event_id: 'livigno' | 'nyc-marathon';
  target_finish_min?: number;
  event_date?: string;
}

export interface PresetEvent {
  id: string;
  name: string;
  sport: 'cycling' | 'running';
  distance_km: number;
  elevation_m: number;
  duration_range: { min: number; max: number };
  difficulty: 'Moderate' | 'Hard' | 'Elite';
}

export const PRESET_EVENTS: Record<string, PresetEvent> = {
  livigno: {
    id: 'livigno',
    name: 'Livigno Cycling Granfondo',
    sport: 'cycling',
    distance_km: 130,
    elevation_m: 3200,
    duration_range: { min: 330, max: 480 },
    difficulty: 'Elite',
  },
  'nyc-marathon': {
    id: 'nyc-marathon',
    name: 'New York City Marathon',
    sport: 'running',
    distance_km: 42.195,
    elevation_m: 300,
    duration_range: { min: 210, max: 360 },
    difficulty: 'Hard',
  },
};

export interface GapMetric {
  label: string;
  current: number;
  required: number;
  unit: string;
  pct: number;
  weight: number;
}

export interface GapAnalysis {
  readiness_pct: number;
  weeks_to_event: number;
  metrics: GapMetric[];
  color: 'red' | 'amber' | 'green';
}

function estimateVO2maxRunning(distance_km: number, time_min: number): number {
  const v = (distance_km * 1000) / time_min;
  const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * time_min)
            + 0.2989558 * Math.exp(-0.1932605 * time_min);
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  return Math.max(20, Math.min(85, Math.round(vo2 / pct)));
}

function estimateVO2maxCycling(distance_km: number, time_min: number): number {
  const speed_kmh = distance_km / (time_min / 60);
  return Math.max(20, Math.min(85, Math.round(speed_kmh * 1.8 + 3)));
}

export function computeGapAnalysis(intake: FitnessIntake, goal: GoalSelection): GapAnalysis {
  const event = PRESET_EVENTS[goal.event_id];
  const targetMin = goal.target_finish_min ?? event.duration_range.max;
  const weeksToEvent = goal.event_date
    ? Math.max(0, Math.round((new Date(goal.event_date).getTime() - Date.now()) / (7 * 86400000)))
    : 16;

  const currentVO2 = intake.recent_vo2max_estimate
    ?? (event.sport === 'running'
        ? estimateVO2maxRunning(intake.effort_distance_km, intake.effort_time_min)
        : estimateVO2maxCycling(intake.effort_distance_km, intake.effort_time_min));

  const targetSpeed = event.distance_km / (targetMin / 60);
  const elevFactor = event.sport === 'cycling' ? 1 + event.elevation_m / 10000 : 1;
  const requiredVO2 = event.sport === 'running'
    ? estimateVO2maxRunning(event.distance_km, targetMin)
    : Math.max(20, Math.min(85, Math.round(targetSpeed * elevFactor * 1.8 + 3)));

  const requiredWeeklyH = Math.round(targetMin / 60 * 2.5 * 10) / 10;
  const requiredLongestH = Math.round(targetMin / 60 * 0.75 * 10) / 10;

  const vo2Pct  = Math.min(100, Math.round((currentVO2 / requiredVO2) * 100));
  const volPct  = Math.min(100, Math.round((intake.weekly_hours / requiredWeeklyH) * 100));
  const longPct = Math.min(100, Math.round((intake.longest_session_h / requiredLongestH) * 100));
  const fatiguePct = Math.round(((6 - intake.fatigue_level) / 5) * 100);

  const metrics: GapMetric[] = [
    { label: 'Estimated VO2max',  current: currentVO2,             required: requiredVO2,    unit: 'ml/kg/min', pct: vo2Pct,    weight: 0.4 },
    { label: 'Weekly Volume',     current: intake.weekly_hours,    required: requiredWeeklyH, unit: 'hrs/week',  pct: volPct,    weight: 0.3 },
    { label: 'Longest Session',   current: intake.longest_session_h, required: requiredLongestH, unit: 'hrs',   pct: longPct,   weight: 0.2 },
    { label: 'Recovery Status',   current: 6 - intake.fatigue_level, required: 5,            unit: '/ 5',       pct: fatiguePct, weight: 0.1 },
  ];

  const readiness_pct = Math.round(metrics.reduce((s, m) => s + m.pct * m.weight, 0));

  return {
    readiness_pct,
    weeks_to_event: weeksToEvent,
    metrics,
    color: readiness_pct >= 80 ? 'green' : readiness_pct >= 50 ? 'amber' : 'red',
  };
}
