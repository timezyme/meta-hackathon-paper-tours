export const countLabel = (count: number, singular: string, plural = `${singular}s`): string => `${count} ${count === 1 ? singular : plural}`

export const headingText = (content: string): string => content.replace(/^#{1,6}\s+/u, "").trim()
