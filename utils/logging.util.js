const formatMeta = (meta = {}) => {
  const entries = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  return entries.length ? ` ${entries.join(" ")}` : "";
};

export const logInfo = (message, meta) => {
  console.log(`${message}${formatMeta(meta)}`);
};

export const logWarn = (message, meta) => {
  console.warn(`${message}${formatMeta(meta)}`);
};

export const logError = (message, meta) => {
  console.error(`${message}${formatMeta(meta)}`);
};
