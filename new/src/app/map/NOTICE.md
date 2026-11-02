# Hindsight Constellation adaptation

`layout.ts` adapts the quadratic curved-link geometry from Vectorize Hindsight's `hindsight-control-plane/src/components/constellation.tsx`, version 1.1.0, commit `6decc291bc0b9f99568ad53cb0501f75128c6d7b`. The upstream root MIT license is included as `LICENSE`.

AmuseMe uses that curve for reading-order links between walkthrough steps. The node styling, hover emphasis and keyboard selection follow an earlier AmuseMe adaptation of the same component. Everything else is AmuseMe code: the column layout, cross-column links, port spacing, list fallback and side panel.

The map's data is not a Hindsight graph. It is derived in the browser from the reading guide saved with the document: walkthrough steps, claims, their limits and the exact source passages each one cites. A line means the guide cites that passage. It does not encode measured similarity, causation or independent verification. No Hindsight service, model call or extra stored artifact is involved. All paper text is rendered as React text.

Source: https://github.com/vectorize-io/hindsight/blob/6decc291bc0b9f99568ad53cb0501f75128c6d7b/hindsight-control-plane/src/components/constellation.tsx
