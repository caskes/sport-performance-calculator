// ─── Training Brain ────────────────────────────────────────────────────────────
// TSB model (CTL/ATL/TSB), Readiness Score, and Workout-of-the-Day logic.

export interface DailyMetric {
  date: string;           // ISO date YYYY-MM-DD
  weight_kg?: number;
  vo2_max?: number;
  hrv_ms?: number;
  sleep_hours?: number;
  active_energy_kcal?: number;
  cycling_work_kj?: number;
  tss?: number;           // computed Training Stress Score
}

export interface TrainingState {
  ctl: number;            // Chronic Training Load (42-day EMA)
  atl: number;            // Acute Training Load (7-day EMA)
  tsb: number;            // Training Stress Balance = CTL - ATL
  readiness: number;      // 0–1
  readiness_pct: number;  // 0–100
  burnout_risk: boolean;
  baseline_hrv: number;
  wod: WorkoutOfDay;
}

export interface WorkoutOfDay {
  type: string;
  label: string;
  description: string;
  target_zone: string;    // 'Z1' | 'Z2' | 'Z3' | 'Z4'
  duration_min: number;
  intensity_pct: number;  // % of FTP/threshold
}

export interface UpcomingEvent {
  id: string;
  name: string;
  date: string;           // ISO date
  sport: 'cycling' | 'running';
  distance_km: number;
  has_gpx?: boolean;
}

// ── TSS estimation ─────────────────────────────────────────────────────────────
// Rough TSS from available signals:
//   Cycling: work_kJ / (FTP_watts * 3.6) * 100
//   General: active_kcal mapped to ~0.25 TSS/kcal (rough but consistent)
export function estimateTSS(m: DailyMetric, ftp = 200): number {
  let tss = 0;
  if (m.cycling_work_kj && m.cycling_work_kj > 0) {
    // NP-based approximation: kJ ≈ kJ; TSS = (kJ / (FTP_W * 3.6)) * 100
    tss += Math.min(300, (m.cycling_work_kj / (ftp * 3.6)) * 100);
  } else if (m.active_energy_kcal && m.active_energy_kcal > 0) {
    tss += Math.min(200, m.active_energy_kcal * 0.15);
  }
  return Math.round(tss * 10) / 10;
}

// ── EMA helper ─────────────────────────────────────────────────────────────────
function ema(values: number[], days: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (days + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return Math.round(result * 10) / 10;
}

// ── Baseline HRV (30-day rolling mean) ────────────────────────────────────────
export function computeBaselineHRV(metrics: DailyMetric[]): number {
  const recent = metrics
    .slice(-30)
    .map(m => m.hrv_ms ?? 0)
    .filter(v => v > 0);
  if (recent.length === 0) return 50; // sensible default
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
}

// ── Core training state ────────────────────────────────────────────────────────
export function computeTrainingState(
  metrics: DailyMetric[],
  ftp = 200,
): TrainingState {
  const sorted = [...metrics].sort((a, b) => a.date.localeCompare(b.date));

  // Ensure TSS is populated
  const withTSS = sorted.map(m => ({
    ...m,
    tss: m.tss ?? estimateTSS(m, ftp),
  }));

  const tssValues = withTSS.map(m => m.tss!);
  const ctl = ema(tssValues, 42);
  const atl = ema(tssValues.slice(-14), 7);
  const tsb = Math.round((ctl - atl) * 10) / 10;

  const burnout_risk = atl > 0 && ctl > 0 && atl > ctl * 1.2;

  const baselineHRV = computeBaselineHRV(withTSS);
  const latest = withTSS[withTSS.length - 1];

  // Readiness = HRV component * 0.7 + Sleep component * 0.3
  const hrvRatio  = latest?.hrv_ms   ? Math.min(1.5, latest.hrv_ms / baselineHRV) : 1;
  const sleepRatio = latest?.sleep_hours ? Math.min(1, latest.sleep_hours / 8) : 1;
  const readiness = Math.min(1, Math.max(0, hrvRatio * 0.7 + sleepRatio * 0.3));
  const readiness_pct = Math.round(readiness * 100);

  const wod = recommendWOD(readiness, tsb, burnout_risk);

  return { ctl, atl, tsb, readiness, readiness_pct, burnout_risk, baseline_hrv: baselineHRV, wod };
}

// ── Workout of the Day ─────────────────────────────────────────────────────────
function recommendWOD(readiness: number, tsb: number, burnoutRisk: boolean): WorkoutOfDay {
  if (burnoutRisk || readiness < 0.55) {
    return {
      type: 'Recovery',
      label: '🛌 Active Recovery',
      description: 'HRV or sleep below threshold. Keep effort minimal — light walking, stretching, or complete rest.',
      target_zone: 'Z1',
      duration_min: 30,
      intensity_pct: 50,
    };
  }
  if (readiness < 0.70 || tsb < -20) {
    return {
      type: 'Endurance',
      label: '🚶 Easy Endurance',
      description: 'Moderate readiness or accumulated fatigue. Build aerobic base at conversational pace.',
      target_zone: 'Z2',
      duration_min: 60,
      intensity_pct: 70,
    };
  }
  if (readiness >= 0.85 && tsb > 5) {
    return {
      type: 'Quality',
      label: '⚡ Threshold Intervals',
      description: 'High readiness + fresh legs. Target 2×20 min at threshold (Z3) with 5 min recovery.',
      target_zone: 'Z3',
      duration_min: 75,
      intensity_pct: 95,
    };
  }
  return {
    type: 'Tempo',
    label: '🏃 Tempo / Sweet-Spot',
    description: 'Good form. Sustained tempo effort builds both aerobic capacity and FTP.',
    target_zone: 'Z2',
    duration_min: 60,
    intensity_pct: 85,
  };
}

// ── Event load balancing advisory ─────────────────────────────────────────────
export function eventAdvisory(events: UpcomingEvent[], state: TrainingState): string[] {
  const notes: string[] = [];
  const now = new Date();

  for (const ev of events) {
    const daysOut = Math.round((new Date(ev.date).getTime() - now.getTime()) / 86400000);
    if (daysOut < 0) continue;

    if (daysOut <= 7) {
      notes.push(`🏁 ${ev.name} in ${daysOut}d — taper now, target TSB +5 to +15 on race day.`);
    } else if (daysOut <= 21) {
      notes.push(`📅 ${ev.name} in ${daysOut}d — reduce long efforts, maintain intensity with shorter intervals.`);
    }
  }

  const hasCycling = events.some(e => e.sport === 'cycling');
  const hasRunning = events.some(e => e.sport === 'running');
  if (hasCycling && hasRunning) {
    notes.push('⚖️ Dual-sport block detected. Limit back-to-back long run + hard bike days to prevent structural overload.');
  }

  if (state.burnout_risk) {
    notes.push('🔥 Burnout risk: ATL exceeds CTL by >20%. Insert 2–3 recovery days before resuming load.');
  }

  return notes;
}
