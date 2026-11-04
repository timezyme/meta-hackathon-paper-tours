import { Schema } from "effect"
import { Figure } from "./document.ts"
import { ArtifactHash, Count, ImagePath, OutputScope, SchemaVersion, Timestamp, UserId } from "./identity.ts"

export const ArtifactEntry = Schema.Union([
  Schema.Struct({ path: Schema.Literal("normalized.txt"), mediaType: Schema.Literal("text/plain; charset=utf-8"), byteCount: Count, hash: ArtifactHash }),
  Schema.Struct({ path: Schema.Literals(["document.json", "images.json", "processing-report.json"]), mediaType: Schema.Literal("application/json"), byteCount: Count, hash: ArtifactHash }),
  Schema.Struct({ path: ImagePath, mediaType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]), byteCount: Count, hash: ArtifactHash }),
])
export type ArtifactEntry = typeof ArtifactEntry.Type
export const ArtifactManifest = Schema.Struct({ schemaVersion: SchemaVersion, scope: OutputScope, entries: Schema.NonEmptyArray(ArtifactEntry) })
export type ArtifactManifest = typeof ArtifactManifest.Type
export const ImageManifest = Schema.Struct({ schemaVersion: SchemaVersion, scope: OutputScope, figures: Schema.Array(Figure) })
export type ImageManifest = typeof ImageManifest.Type
export const RatingValue = Schema.Literals(["up", "down"])
export const Rating = Schema.Struct({ scope: OutputScope, userId: UserId, value: RatingValue, updatedAt: Timestamp })
export type Rating = typeof Rating.Type

export const outputFilenames = ["normalized.txt", "document.json", "images.json", "processing-report.json"] as const
