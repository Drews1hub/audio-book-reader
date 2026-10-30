// Decimal units match the download sizes shown by the page.
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 bytes';
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1e6) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
