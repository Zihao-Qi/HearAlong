import { isLocalModel, type AiMode } from '../pi-command.ts';

export type CloudConsent = { providers: string[]; time: number; legacy?: true };
export type ModeSettings = {
  aiMode?: AiMode;
  setupSeen?: boolean;
  localMainModel?: string | null;
  localQuickModel?: string | null;
  cloudMainModel?: string | null;
  cloudQuickModel?: string | null;
  cloudConsent?: CloudConsent;
  cloudNotice?: boolean;
};
export const providerSet = (ids: string[]) => [...new Set(ids.map(id => id.split('/')[0]))].sort();
export function consentCovers(consent: CloudConsent | undefined, ids: string[]): boolean {
  const providers = providerSet(ids);
  return !!consent && providers.length > 0 && (consent.legacy ? providers.every(provider => consent.providers.includes(provider)) : JSON.stringify([...consent.providers].sort()) === JSON.stringify(providers));
}
export function migrateAi(settings: ModeSettings, ids: string[], forcedOff: boolean, time = Date.now()): ModeSettings {
  if (settings.aiMode) return settings;
  const cloud = ids.filter(id => !isLocalModel(id));
  const legacy = !forcedOff && settings.setupSeen === true && cloud.length > 0;
  return { ...settings, aiMode: forcedOff ? 'off' : legacy ? 'cloud' : ids.some(isLocalModel) ? 'local' : 'off',
    cloudNotice: legacy, ...(legacy ? { cloudConsent: { providers: providerSet(cloud), time, legacy: true } } : {}) };
}
