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

