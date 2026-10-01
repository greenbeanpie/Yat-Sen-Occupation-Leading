import type { components } from '../api/schema';
type Settings = components['schemas']['AiSettingsResponse'];
type Config = components['schemas']['AiSettingsConfig'];
export function aiFormCapabilities(settings: Settings, config: Config) {
  const model = settings.presets.find(preset => preset.id === config.providerPreset)?.models.find(item => item.id === config.model);
  return { reasoningEfforts: model?.reasoningEfforts ?? [],
    temperature: config.providerPreset === 'custom' || !!model?.temperature || (!!model?.samplingWithNoneOnly && config.reasoningEffort === 'none'),
    topP: config.providerPreset === 'custom' || (!!model?.topP && !(config.providerPreset === 'deepseek' && config.reasoningEffort === 'none')) || (!!model?.samplingWithNoneOnly && config.reasoningEffort === 'none' && config.providerPreset !== 'deepseek'),
    thinkingBudget: config.providerPreset === 'gemini' && ['gemini-2.5-flash','gemini-2.5-pro'].includes(config.model),
  };
}

export function aiDestinationChanged(settings: Settings, current: Config): boolean {
  const destination = (config: Config) => {
    const preset = settings.presets.find(item => item.id === config.providerPreset);
    const protocol = config.protocol === 'auto' ? preset?.models.find(item => item.id === config.model)?.protocol ?? 'auto' : config.protocol;
    const raw = config.baseUrl.trim() || preset?.baseUrl || '';
    let root = raw;
    try { root = new URL(raw).href.replace(/\/+$/, ''); } catch { /* Invalid input remains different until corrected. */ }
    return JSON.stringify([config.providerPreset, protocol, root]);
  };
  return destination(current) !== destination(settings.config);
}
