export const PdfLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxPages: 50,
  maxPageSidePoints: 14_400,
  maxPageAreaPoints: 14_400 * 14_400,
  maxXrefs: 100_000,
  maxPageTreeNodes: 1024,
  maxPageTreeDepth: 32,
  maxImagePixels: 100_000_000,
  maxTotalImagePixels: 500_000_000,
  maxOutputBytes: 65_536,
  timeoutMs: 10_000,
  cpuSeconds: 5,
  memoryBytes: 1024 * 1024 * 1024,
} as const

export const PYMUPDF_VERSION = "1.28.2"
export const PYTHON_VERSION = "3.14"
