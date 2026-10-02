export function decideLowIntentCadence(hours: number, attempts: Array<{stage:number;confirmed:boolean;sentAtHours?:number}>, finalDelayHours=1): 1 | 2 | 3 | null {
 if (!Number.isFinite(hours) || hours < 1 || !Number.isFinite(finalDelayHours) || finalDelayHours<0.25 || attempts.some(a => !a.confirmed) || attempts.some(a => a.stage === 3)) return null;
 const sent = new Set(attempts.map(a => a.stage));
 if (!sent.has(1)) return hours < 23 ? 1 : null;
 if (!sent.has(2)) return hours >= 23 && hours < 48 ? 2 : null;
 const second=attempts.find(a=>a.stage===2);
 return hours >= (second?.sentAtHours ?? 23)+finalDelayHours ? 3 : null;
}
