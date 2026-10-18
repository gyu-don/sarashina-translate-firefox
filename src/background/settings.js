export const DEFAULT_SETTINGS = {
  apiKey: "",
  targetLang: "ja",
  rpm: 6,
  showOriginalOnHover: true,
  alwaysTranslateHosts: [],
};

export async function loadSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
