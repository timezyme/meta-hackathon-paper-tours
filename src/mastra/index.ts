import { Mastra } from "@mastra/core/mastra"
import { makeAmuseMe } from "./amuseme.ts"

export const mastra = new Mastra(makeAmuseMe(4180))
